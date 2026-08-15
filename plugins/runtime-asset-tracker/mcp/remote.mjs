import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const remoteCache = new Map();
const CACHE_TTL_MS = 60_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sanitizeError(value) {
  const message = String(value || "远程快照失败");
  if (/ExpiredToken|session has expired|reauthenticate using/i.test(message)) return "AWS 登录已过期，请重新登录后刷新该来源。";
  if (/Unable to locate credentials|NoCredentials/i.test(message)) return "没有可用的 AWS 登录凭证，请登录后刷新该来源。";
  return message
    .replace(/(token|authorization|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .slice(0, 480);
}

function runStrict(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString?.("utf8") || error?.stdout?.toString?.("utf8") || error?.message;
    throw new Error(sanitizeError(detail));
  }
}

function runJson(command, args, options) {
  const output = runStrict(command, args, options);
  return output ? JSON.parse(output) : {};
}

function parseBytes(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?/i);
  if (!match) return 0;
  const units = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 };
  return Number(match[1]) * (units[(match[2] || "B").toUpperCase()] || 1);
}

function emptyBars() {
  return ["worktree", "host_artifact", "image", "volume", "cache"].map((type) => ({
    type,
    totalBytes: 0,
    count: 0,
    activeBytes: 0,
    protectedBytes: 0,
    expiringBytes: 0,
    retainedBytes: 0,
    reclaimableBytes: 0,
    unit: type === "worktree" ? "count" : "bytes",
  }));
}

function aggregate(type, assets, summary) {
  const matching = assets.filter((asset) => asset.type === type);
  const sum = (classification) => matching
    .filter((asset) => asset.classification === classification)
    .reduce((total, asset) => total + (type === "worktree" ? 1 : Number(asset.sizeBytes || 0)), 0);
  const activeBytes = sum("active");
  const protectedBytes = sum("protected");
  const expiringBytes = sum("expiring");
  const reclaimableBytes = type === "cache"
    ? Math.max(sum("reclaimable"), Number(summary?.reclaimableBytes || 0))
    : sum("reclaimable");
  const measured = matching.reduce((total, asset) => total + (type === "worktree" ? 1 : Number(asset.sizeBytes || 0)), 0);
  const totalBytes = type === "worktree" ? matching.length : Math.max(measured, Number(summary?.sizeBytes || 0));
  return {
    type,
    totalBytes,
    count: Number(summary?.totalCount ?? matching.length),
    activeBytes,
    protectedBytes,
    expiringBytes,
    retainedBytes: Math.max(0, totalBytes - activeBytes - protectedBytes - expiringBytes - reclaimableBytes),
    reclaimableBytes,
    unit: type === "worktree" ? "count" : "bytes",
  };
}

export function buildBars(assets, summary = {}) {
  return [
    aggregate("worktree", assets),
    aggregate("host_artifact", assets),
    aggregate("image", assets, summary.Images),
    aggregate("volume", assets, summary["Local Volumes"]),
    aggregate("cache", assets, summary["Build Cache"]),
  ];
}

function aggregateGithub(type, assets, unit) {
  const matching = assets.filter((asset) => asset.type === type);
  const measure = (asset) => unit === "count" ? 1 : Number(asset.sizeBytes || 0);
  const sum = (classification) => matching
    .filter((asset) => asset.classification === classification)
    .reduce((total, asset) => total + measure(asset), 0);
  const activeBytes = sum("active");
  const protectedBytes = sum("protected");
  const expiringBytes = sum("expiring");
  const reclaimableBytes = sum("reclaimable");
  const totalBytes = matching.reduce((total, asset) => total + measure(asset), 0);
  return {
    type,
    totalBytes,
    count: matching.length,
    activeBytes,
    protectedBytes,
    expiringBytes,
    retainedBytes: Math.max(0, totalBytes - activeBytes - protectedBytes - expiringBytes - reclaimableBytes),
    reclaimableBytes,
    unit,
  };
}

export function buildGithubBars(assets) {
  return [
    aggregateGithub("pull_request", assets, "count"),
    aggregateGithub("artifact", assets, "bytes"),
    aggregateGithub("actions_cache", assets, "bytes"),
    aggregateGithub("workflow_run", assets, "count"),
  ];
}

function runtimeLabel(labels, name) {
  return labels?.[`com.codex.runtime.${name}`];
}

export function resolveExpiry({ labels = {}, createdAt, expiresAt } = {}) {
  const explicit = expiresAt || runtimeLabel(labels, "expires-at") || runtimeLabel(labels, "retention-until");
  if (explicit && Number.isFinite(Date.parse(explicit))) return new Date(explicit).toISOString();
  const ttlDays = Number(runtimeLabel(labels, "ttl-days"));
  const created = Date.parse(createdAt || "");
  return ttlDays > 0 && Number.isFinite(created) ? new Date(created + ttlDays * 24 * 60 * 60_000).toISOString() : undefined;
}

export function expiryClassification(expiresAt, now = Date.now(), windowDays = 7) {
  const expiry = Date.parse(expiresAt || "");
  if (!Number.isFinite(expiry)) return undefined;
  if (expiry <= now) return "expired";
  return expiry - now <= windowDays * 24 * 60 * 60_000 ? "expiring" : "retained";
}

export function classifyDockerImage({ labels = {}, referenced = false, dangling = false, createdAt, expiresAt, now = Date.now() } = {}) {
  if (referenced) return "active";
  if (runtimeLabel(labels, "retention") === "protected" || runtimeLabel(labels, "disposable") === "false") return "protected";
  const expiry = expiryClassification(resolveExpiry({ labels, createdAt, expiresAt }), now);
  if (expiry === "expiring") return "expiring";
  if (expiry === "retained") return "retained";
  if (runtimeLabel(labels, "disposable") === "true" || dangling) return "reclaimable";
  return "retained";
}

export function classifyDockerVolume({ labels = {}, referenced = false, protectedName = false, createdAt, expiresAt, now = Date.now() } = {}) {
  if (referenced) return "active";
  if (protectedName || runtimeLabel(labels, "retention") === "protected" || runtimeLabel(labels, "disposable") === "false") return "protected";
  const expiry = expiryClassification(resolveExpiry({ labels, createdAt, expiresAt }), now);
  if (expiry === "expiring") return "expiring";
  if (expiry === "retained") return "review";
  if (runtimeLabel(labels, "disposable") === "true") return "reclaimable";
  return "review";
}

function normalizedTags(tags) {
  return [...new Set((tags || []).map(String).filter((tag) => tag && !tag.includes("<none>")))].sort();
}

export function validateRemoteRetirementApproval(requested, current, sourceConfig = {}) {
  if (!requested || !current || requested.type !== current.type || requested.id !== current.id) return false;
  if (String(requested.project || "") !== String(sourceConfig.projectId || requested.project || "")) return false;
  const evidence = requested.retirementEvidence;
  if (!/^[0-9a-f]{64}$/i.test(String(evidence?.reportSha256 || ""))) return false;
  if (evidence?.lifecycle && (evidence.lifecycle.state !== "MERGED" || evidence.lifecycle.coolingComplete !== true)) return false;
  if (requested.type === "container") {
    const normalizedMounts = (mounts) => (mounts || []).map((mount) => ({
      type: String(mount?.type || ""), name: String(mount?.name || ""), source: String(mount?.source || ""), destination: String(mount?.destination || ""),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const expectedState = String(evidence?.expectedState || "");
    const currentState = String(current.status || "");
    const stateMatches = expectedState === currentState || (expectedState === "running" && currentState === "exited");
    return evidence?.assetType === "container"
      && evidence?.preserveVolumes === true
      && stateMatches
      && current.name === evidence.expectedName
      && current.lineage?.imageId === evidence.expectedImageId
      && current.lineage?.composeProject === evidence.expectedComposeProject
      && JSON.stringify(normalizedMounts(current.lineage?.mounts)) === JSON.stringify(normalizedMounts(evidence.expectedMounts));
  }
  if (["host_artifact", "worktree"].includes(requested.type)) {
    const managedRoots = [...(sourceConfig.managedPaths || []).map((item) => String(item.path || "")), String(sourceConfig.releaseRoot || "")].filter(Boolean);
    const root = String(evidence?.managedRoot || "").replace(/\/+$/, "");
    const path = String(current.id || "").replace(/\/+$/, "");
    return evidence?.assetType === requested.type
      && managedRoots.includes(root)
      && path.startsWith(`${root}/`)
      && !(current.lineage?.consumers || []).length
      && Number(current.sizeBytes || 0) === Number(evidence.expectedSizeBytes || 0)
      && String(current.lineage?.fingerprint || "") === String(evidence.fingerprint || "");
  }
  if (requested.type === "volume") {
    return evidence?.assetType === "volume"
      && Number(evidence.expectedReferences) === 0
      && !(current.lineage?.consumers || []).length
      && Number(current.sizeBytes || 0) === Number(evidence.expectedSizeBytes || 0);
  }
  if (requested.type !== "image" || (current.lineage?.consumers || []).length > 0) return false;
  if (!/^[0-9a-f]{40}$/i.test(String(evidence?.revision || ""))) return false;
  if (String(current.lineage?.revision || "").toLowerCase() !== String(evidence.revision).toLowerCase()) return false;
  const liveTags = normalizedTags(current.lineage?.tags);
  const approvedTags = normalizedTags(evidence.approvedTags);
  const previewTags = normalizedTags(requested.tags);
  return liveTags.length > 0
    && liveTags.length === approvedTags.length
    && liveTags.every((tag, index) => tag === approvedTags[index])
    && liveTags.length === previewTags.length
    && liveTags.every((tag, index) => tag === previewTags[index]);
}

export function remoteImageRemovalArgs(item) {
  const tags = normalizedTags(item?.tags || item?.retirementEvidence?.approvedTags);
  return ["image", "rm", ...(tags.length ? tags : [String(item?.id || "")])];
}

export function buildPostCleanupVerification(before, after, results = []) {
  const activeContainers = (snapshot) => new Map((snapshot?.assets || [])
    .filter((asset) => asset.type === "container" && asset.classification === "active")
    .map((asset) => [asset.id, asset.name]));
  const beforeActive = activeContainers(before);
  const afterActive = activeContainers(after);
  const intentionallyRemovedContainerIds = new Set(results.filter((item) => item.status === "removed" && item.type === "container").map((item) => item.id));
  const missingActiveContainers = [...beforeActive].filter(([id]) => !afterActive.has(id) && !intentionallyRemovedContainerIds.has(id)).map(([id, name]) => ({ id, name }));
  const remainingContainerIds = new Set((after?.assets || []).filter((asset) => asset.type === "container").map((asset) => asset.id));
  const removedContainersStillPresent = [...intentionallyRemovedContainerIds].filter((id) => remainingContainerIds.has(id));
  const remainingImageIds = new Set((after?.assets || []).filter((asset) => asset.type === "image").map((asset) => asset.id));
  const removedIds = results.filter((item) => item.status === "removed" && item.type === "image").map((item) => item.id);
  const removedImagesStillPresent = removedIds.filter((id) => remainingImageIds.has(id));
  const freeBytesBefore = Number(before?.disk?.freeBytes || 0);
  const freeBytesAfter = Number(after?.disk?.freeBytes || 0);
  const nonSuccess = results.filter((item) => item.status !== "removed");
  const safetyStatus = missingActiveContainers.length === 0 && removedContainersStillPresent.length === 0 && removedImagesStillPresent.length === 0 ? "pass" : "fail";
  const operationStatus = nonSuccess.length === 0 ? "complete" : results.some((item) => item.status === "removed") ? "partial" : "not_completed";
  return {
    status: safetyStatus === "pass" && operationStatus === "complete" ? "pass" : safetyStatus === "fail" ? "fail" : "partial",
    safetyStatus,
    operationStatus,
    nonSuccessCount: nonSuccess.length,
    checkedAt: new Date().toISOString(),
    activeContainerCountBefore: beforeActive.size,
    activeContainerCountAfter: afterActive.size,
    missingActiveContainers,
    intentionallyRemovedContainerIds: [...intentionallyRemovedContainerIds],
    removedContainersStillPresent,
    removedImagesStillPresent,
    freeBytesBefore,
    freeBytesAfter,
    freeBytesDelta: freeBytesAfter - freeBytesBefore,
  };
}

export function remoteSnapshotScript(sourceConfig = {}) {
  const context = Buffer.from(JSON.stringify({
    project: sourceConfig.projectId || "sparklingplaycms",
    projectAliases: sourceConfig.projectAliases || [],
    assetPrefixes: sourceConfig.assetPrefixes || [],
    managedPaths: sourceConfig.managedPaths || [],
    includeAllAssets: sourceConfig.includeAllAssets === true,
    environment: sourceConfig.id || "remote",
    releaseRoot: sourceConfig.releaseRoot ?? "/home/ec2-user/apps/sparkling-cms-releases",
    activeLink: sourceConfig.activeLink ?? "/home/ec2-user/apps/sparkling-cms",
    expiryWindowDays: Number(sourceConfig.expiryWindowDays || 7),
    transportPath: sourceConfig.transportPath || "",
  }), "utf8").toString("base64");
  return String.raw`
import base64, datetime, gzip, hashlib, json, os, re, shutil, socket, stat, subprocess

PREFIX = "com.codex.runtime."
CONTEXT = json.loads(base64.b64decode("${context}"))
DEFAULT_PROJECT = CONTEXT.get("project") or "unknown"
DEFAULT_ENVIRONMENT = CONTEXT.get("environment") or "remote"
EXPIRY_WINDOW_DAYS = int(CONTEXT.get("expiryWindowDays") or 7)
PROJECT_TOKENS = [re.sub(r"[^a-z0-9]", "", str(value).lower()) for value in (CONTEXT.get("projectAliases") or []) + (CONTEXT.get("assetPrefixes") or []) if value]

def run(args, timeout=30):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
        return result.returncode, result.stdout.strip()
    except Exception:
        return 127, ""

docker_prefix = ["docker"]
code, _ = run(docker_prefix + ["version", "--format", "{{.Server.Version}}"])
if code != 0:
    docker_prefix = ["sudo", "-n", "docker"]
    code, _ = run(docker_prefix + ["version", "--format", "{{.Server.Version}}"])
docker_available = code == 0

def docker(args, timeout=45):
    if not docker_available:
        return ""
    return run(docker_prefix + args, timeout)[1]

def json_lines(text):
    rows = []
    for line in text.splitlines():
        try: rows.append(json.loads(line))
        except Exception: pass
    return rows

def parse_bytes(value):
    match = re.match(r"^([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?", str(value or ""), re.I)
    if not match: return 0
    units = {"B":1,"KB":1000,"KIB":1024,"MB":1000**2,"MIB":1024**2,"GB":1000**3,"GIB":1024**3,"TB":1000**4,"TIB":1024**4}
    return int(float(match.group(1)) * units.get((match.group(2) or "B").upper(), 1))

def disk_usage_bytes(path):
    code, value = run(["sudo", "-n", "du", "-sb", "--", path], timeout=90)
    if code != 0: return 0
    try: return int(value.split()[0])
    except Exception: return 0

def metadata_fingerprint(path, size_bytes):
    try:
        stat = os.lstat(path)
        value = "%s\0%s\0%s\0%s\0%s" % (os.path.realpath(path), int(size_bytes), int(stat.st_mtime_ns), int(stat.st_mode), int(stat.st_ino))
        return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()
    except Exception: return ""

def bind_consumers(path):
    target = os.path.realpath(path).rstrip("/")
    consumers = []
    for item in container_details:
        for mount in (item.get("Mounts") or []):
            if mount.get("Type") != "bind" or not mount.get("Source"): continue
            source = os.path.realpath(str(mount.get("Source"))).rstrip("/")
            if source == target or source.startswith(target + "/") or target.startswith(source + "/"):
                consumers.append({"id":item.get("Id"),"name":str(item.get("Name") or "").lstrip("/"),"state":(item.get("State") or {}).get("Status") or "unknown","source":source,"destination":mount.get("Destination")})
    return consumers

def safe_labels(labels):
    return {k:v for k,v in (labels or {}).items() if k.startswith(PREFIX) or k.startswith("com.docker.compose.") or k in ["org.opencontainers.image.revision", "org.opencontainers.image.source"]}

def label(labels, name):
    return (labels or {}).get(PREFIX + name)

def parse_time(value):
    if not value: return None
    try: return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception: return None

def expiry_at(labels, created_at=None):
    explicit = label(labels, "expires-at") or label(labels, "retention-until")
    parsed = parse_time(explicit)
    if parsed: return parsed
    try: ttl_days = float(label(labels, "ttl-days") or 0)
    except Exception: ttl_days = 0
    created = parse_time(created_at)
    return created + datetime.timedelta(days=ttl_days) if created and ttl_days > 0 else None

def expiry_class(labels, created_at=None):
    expires = expiry_at(labels, created_at)
    if not expires: return None, None
    now = datetime.datetime.now(datetime.timezone.utc)
    if expires <= now: return "expired", expires.isoformat()
    if expires - now <= datetime.timedelta(days=EXPIRY_WINDOW_DAYS): return "expiring", expires.isoformat()
    return "retained", expires.isoformat()

def normalized_project_token(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())

def belongs_to_selected_project(value):
    candidate = normalized_project_token(value)
    return bool(candidate and any(len(token) >= 4 and token in candidate for token in PROJECT_TOKENS))

def explicit_project(labels):
    value = label(labels, "project")
    if not value: return None
    return DEFAULT_PROJECT if belongs_to_selected_project(value) else value

def inferred_project(candidates):
    values = [str(value) for value in candidates if value]
    if any(belongs_to_selected_project(value) for value in values): return DEFAULT_PROJECT
    unique = sorted(set(values))
    if len(unique) == 1 and re.fullmatch(r"[0-9a-f]{64}", unique[0], re.I): return "unknown"
    return unique[0] if len(unique) == 1 else ("shared" if len(unique) > 1 else "unknown")

def project_from_compose_or_name(compose_project, name):
    if compose_project:
        return DEFAULT_PROJECT if belongs_to_selected_project(compose_project) else str(compose_project)
    return inferred_project([name])

def classify(labels, active=False, protected=False, dangling=False, created_at=None):
    if active: return "active"
    if protected or label(labels, "retention") == "protected" or label(labels, "disposable") == "false": return "protected"
    expiry, _ = expiry_class(labels, created_at)
    if expiry == "expiring": return "expiring"
    if expiry == "retained": return "retained"
    if label(labels, "disposable") == "true": return "reclaimable"
    if dangling: return "review"
    return "retained"

assets = []
summary = {}
container_rows = json_lines(docker(["ps", "-a", "--size", "--no-trunc", "--format", "{{json .}}"])) if docker_available else []
container_ids = [row.get("ID") for row in container_rows if row.get("ID")]
container_details = []
for start in range(0, len(container_ids), 30):
    text = docker(["container", "inspect"] + container_ids[start:start+30])
    try: container_details.extend(json.loads(text or "[]"))
    except Exception: pass

running_images = {item.get("Image") for item in container_details if (item.get("State") or {}).get("Running")}
referenced_images = {item.get("Image") for item in container_details if item.get("Image")}
all_mounted = {mount.get("Name") for item in container_details for mount in (item.get("Mounts") or []) if mount.get("Type") == "volume"}
active_mounted = {mount.get("Name") for item in container_details if (item.get("State") or {}).get("Running") for mount in (item.get("Mounts") or []) if mount.get("Type") == "volume"}
image_consumers = {}
volume_consumers = {}
image_consumer_projects = {}
volume_consumer_projects = {}
for item in container_details:
    name = str(item.get("Name") or "").lstrip("/")
    state = (item.get("State") or {}).get("Status") or "unknown"
    item_labels = safe_labels((item.get("Config") or {}).get("Labels"))
    compose_project = item_labels.get("com.docker.compose.project")
    consumer_project = explicit_project(item_labels) or project_from_compose_or_name(compose_project, name)
    if item.get("Image"):
        image_consumers.setdefault(item.get("Image"), []).append({"id":item.get("Id"),"name":name,"state":state})
        image_consumer_projects.setdefault(item.get("Image"), set()).add(consumer_project)
    for mount in (item.get("Mounts") or []):
        if mount.get("Type") == "volume" and mount.get("Name"):
            volume_consumers.setdefault(mount.get("Name"), []).append({"id":item.get("Id"),"name":name,"state":state,"destination":mount.get("Destination")})
            volume_consumer_projects.setdefault(mount.get("Name"), set()).add(consumer_project)

df_verbose = docker(["system", "df", "-v"]) if docker_available else ""
def section(text, start_marker, end_marker):
    start = text.find(start_marker)
    if start < 0: return ""
    body = text[start + len(start_marker):]
    end = body.find(end_marker)
    return body if end < 0 else body[:end]

image_unique_sizes = {}
for line in section(df_verbose, "Images space usage:", "Containers space usage:").splitlines()[1:]:
    parts = re.split(r"\s{2,}", line.strip())
    if len(parts) >= 8: image_unique_sizes[parts[2]] = parse_bytes(parts[6])

volume_sizes = {}
for line in section(df_verbose, "Local Volumes space usage:", "Build cache usage:").splitlines()[1:]:
    parts = re.split(r"\s{2,}", line.strip())
    if len(parts) >= 3: volume_sizes[parts[0]] = parse_bytes(parts[2])

container_row_map = {row.get("ID"): row for row in container_rows}
for item in container_details:
    labels = safe_labels((item.get("Config") or {}).get("Labels"))
    active = bool((item.get("State") or {}).get("Running"))
    compose_project = labels.get("com.docker.compose.project")
    assets.append({
        "id": item.get("Id"), "name": str(item.get("Name") or "").lstrip("/"), "type":"container",
        "project": explicit_project(labels) or project_from_compose_or_name(compose_project, str(item.get("Name") or "").lstrip("/")), "environment": label(labels, "environment") or "remote",
        "status": (item.get("State") or {}).get("Status") or "unknown", "classification": classify(labels, active=active, created_at=item.get("Created")),
        "sizeBytes": parse_bytes((container_row_map.get(item.get("Id")) or {}).get("Size")), "createdAt": item.get("Created"),
        "labels": labels, "lineage":{"composeProject":labels.get("com.docker.compose.project"),"imageId":item.get("Image"),"mounts":[{"type":mount.get("Type"),"name":mount.get("Name"),"source":mount.get("Source"),"destination":mount.get("Destination")} for mount in (item.get("Mounts") or [])]}, "reason": "正在运行" if active else "已停止，等待归属确认"
    })

image_rows = json_lines(docker(["image", "ls", "--no-trunc", "--format", "{{json .}}"])) if docker_available else []
image_map = {}
for row in image_rows:
    image_id = row.get("ID")
    if not image_id: continue
    entry = image_map.setdefault(image_id, {"row":row, "tags":[]})
    ref = "%s:%s" % (row.get("Repository") or "<none>", row.get("Tag") or "<none>")
    if ref not in entry["tags"]: entry["tags"].append(ref)

governed = set(image_map.keys())
image_details = {}
for ids in [list(governed)[start:start+30] for start in range(0, len(governed), 30)]:
    text = docker(["image", "inspect"] + ids)
    try:
        for item in json.loads(text or "[]"): image_details[item.get("Id")] = item
    except Exception: pass

for image_id, entry in image_map.items():
    item = image_details.get(image_id) or {}
    labels = safe_labels((item.get("Config") or {}).get("Labels"))
    tags = entry["tags"]
    dangling = not tags or all(tag.startswith("<none>") for tag in tags)
    running = image_id in running_images
    referenced = image_id in referenced_images
    protected = label(labels, "retention") == "protected" or label(labels, "disposable") == "false"
    disposable = label(labels, "disposable") == "true"
    created_at = item.get("Created") or entry["row"].get("CreatedAt")
    expiry_state, expires_at = expiry_class(labels, created_at)
    image_class = "active" if referenced else ("protected" if protected else ("expiring" if expiry_state == "expiring" else ("retained" if expiry_state == "retained" else ("reclaimable" if disposable or dangling else "retained"))))
    unique_size = next((size for short_id, size in image_unique_sizes.items() if short_id in image_id), 0)
    consumer_projects = sorted(image_consumer_projects.get(image_id, set()))
    inferred_image_project = explicit_project(labels) or (consumer_projects[0] if len(consumer_projects) == 1 else ("shared" if len(consumer_projects) > 1 else inferred_project(tags)))
    assets.append({
        "id":image_id, "name":tags[0] if tags else image_id[:19], "type":"image", "project":inferred_image_project,
        "environment":label(labels, "environment") or "remote", "status":"in-use" if running else ("referenced-stopped" if referenced else ("dangling" if dangling else "unused")),
        "classification":image_class, "sizeBytes":unique_size,
        "createdAt":created_at, "expiresAt":expires_at, "labels":labels, "lineage":{"consumers":image_consumers.get(image_id, []),"projects":consumer_projects,"tags":tags,"revision":labels.get("org.opencontainers.image.revision"),"source":labels.get("org.opencontainers.image.source")},
        "reason":"被运行容器引用" if running else ("仍被已停止容器引用" if referenced else ("保留策略明确保护" if protected else ("未引用且明确可丢弃" if disposable else ("未被任何容器引用的悬空镜像" if dangling else "未引用但没有可丢弃标签"))))
    })

volume_rows = json_lines(docker(["volume", "ls", "--format", "{{json .}}"])) if docker_available else []
volume_names = [row.get("Name") for row in volume_rows if row.get("Name")]
volume_details = []
for start in range(0, len(volume_names), 30):
    text = docker(["volume", "inspect"] + volume_names[start:start+30])
    try: volume_details.extend(json.loads(text or "[]"))
    except Exception: pass
protected_pattern = re.compile(r"postgres|mysql|maria|redis|valkey|upload|media|data|backup", re.I)
for item in volume_details:
    name = item.get("Name") or "unknown"
    labels = safe_labels(item.get("Labels"))
    active = name in active_mounted
    mounted = name in all_mounted
    protected = bool(protected_pattern.search(name))
    policy_protected = protected or label(labels, "retention") == "protected" or label(labels, "disposable") == "false"
    disposable = label(labels, "disposable") == "true"
    expiry_state, expires_at = expiry_class(labels, item.get("CreatedAt"))
    volume_class = "active" if mounted else ("protected" if policy_protected else ("expiring" if expiry_state == "expiring" else ("review" if expiry_state == "retained" else ("reclaimable" if disposable else "review"))))
    consumer_projects = sorted(volume_consumer_projects.get(name, set()))
    inferred_volume_project = explicit_project(labels) or (consumer_projects[0] if len(consumer_projects) == 1 else ("shared" if len(consumer_projects) > 1 else project_from_compose_or_name(labels.get("com.docker.compose.project"), name)))
    assets.append({
        "id":name, "name":name, "type":"volume", "project":inferred_volume_project,
        "environment":label(labels, "environment") or "remote", "status":"mounted-running" if active else ("mounted-stopped" if mounted else "unmounted"),
        "classification":volume_class, "sizeBytes":volume_sizes.get(name, 0), "createdAt":item.get("CreatedAt"), "expiresAt":expires_at,
        "labels":labels, "lineage":{"composeProject":labels.get("com.docker.compose.project"),"consumers":volume_consumers.get(name, []),"mountpoint":item.get("Mountpoint")}, "reason":"被运行容器挂载" if active else ("仍被已停止容器挂载" if mounted else ("名称或保留策略表明可能包含业务数据" if policy_protected else ("未挂载且明确可丢弃" if disposable else "未证明可丢弃，等待确认")))
    })

for row in json_lines(docker(["system", "df", "--format", "{{json .}}"])) if docker_available else []:
    summary[row.get("Type")] = {"totalCount":int(row.get("TotalCount") or 0), "activeCount":int(row.get("Active") or 0), "sizeBytes":parse_bytes(row.get("Size")), "reclaimableBytes":parse_bytes(row.get("Reclaimable"))}

build_cache = summary.get("Build Cache") or {}
if build_cache.get("reclaimableBytes", 0) > 0:
    assets.append({
        "id":"docker-build-cache", "name":"Docker Build Cache", "type":"cache", "project":DEFAULT_PROJECT,
        "environment":"remote", "status":"unused-build-cache", "classification":"reclaimable",
        "sizeBytes":build_cache.get("reclaimableBytes", 0), "createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "labels":{}, "reason":"Docker 明确认定为未使用且可回收的 Build Cache"
    })

release_root = CONTEXT.get("releaseRoot") or ""
active_link = CONTEXT.get("activeLink") or ""
active_release = os.path.realpath(active_link) if os.path.exists(active_link) else ""
if os.path.isdir(release_root) and not os.path.islink(release_root):
    release_entries = sorted(os.scandir(release_root), key=lambda item:item.stat().st_mtime, reverse=True)
    if not CONTEXT.get("includeAllAssets"): release_entries = release_entries[:60]
    for entry in release_entries:
        if not entry.is_dir(follow_symlinks=False): continue
        active = os.path.realpath(entry.path) == active_release
        size_bytes = disk_usage_bytes(entry.path)
        consumers = bind_consumers(entry.path)
        assets.append({"id":entry.path,"name":entry.name,"type":"worktree","project":DEFAULT_PROJECT,"environment":DEFAULT_ENVIRONMENT,"status":"active-release" if active else "retained-release","classification":"active" if active else "retained","sizeBytes":size_bytes,"createdAt":datetime.datetime.fromtimestamp(entry.stat().st_mtime, datetime.timezone.utc).isoformat(),"labels":{},"lineage":{"path":entry.path,"activeLink":active_link,"managedRoot":release_root,"fingerprint":metadata_fingerprint(entry.path,size_bytes),"consumers":consumers},"reason":"当前活动 release" if active else "保留的 release"})

for managed in CONTEXT.get("managedPaths") or []:
    root = str(managed.get("path") or "")
    if not root.startswith("/home/") or not os.path.isdir(root) or os.path.islink(root): continue
    managed_entries = sorted(os.scandir(root), key=lambda item:item.stat(follow_symlinks=False).st_mtime, reverse=True)
    if not CONTEXT.get("includeAllAssets"): managed_entries = managed_entries[:240]
    for entry in managed_entries:
        if entry.is_symlink(): continue
        kind = str(managed.get("kind") or "managed-host-artifact")
        size_bytes = disk_usage_bytes(entry.path) if entry.is_dir(follow_symlinks=False) else entry.stat(follow_symlinks=False).st_size
        consumers = bind_consumers(entry.path)
        assets.append({"id":entry.path,"name":entry.name,"type":"host_artifact","project":DEFAULT_PROJECT,"environment":DEFAULT_ENVIRONMENT,"status":"retained-host-artifact","classification":"retained","sizeBytes":size_bytes,"createdAt":datetime.datetime.fromtimestamp(entry.stat(follow_symlinks=False).st_mtime,datetime.timezone.utc).isoformat(),"labels":{},"lineage":{"path":entry.path,"managedRoot":root,"artifactKind":kind,"fingerprint":metadata_fingerprint(entry.path,size_bytes),"consumers":consumers},"reason":"Managed host artifact awaiting exact retirement evidence"})

events = []
for ledger_path in ["/var/lib/runtime-asset-tracker/events.jsonl", os.path.expanduser("~/.local/state/runtime-asset-tracker/events.jsonl")]:
    if not os.path.isfile(ledger_path): continue
    try:
        with open(ledger_path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()[-24:]
        for line in reversed(lines):
            try: events.append(json.loads(line))
            except Exception: pass
        break
    except Exception: pass

usage = shutil.disk_usage("/")
revision = ""
if active_release:
    revision = run(["git", "-C", active_release, "rev-parse", "HEAD"])[1]
asset_types = ["container", "image", "volume", "worktree", "host_artifact", "cache"]
limits = {"container":200, "image":500, "volume":500, "worktree":60, "host_artifact":240, "cache":10}
assets = [item for kind in asset_types for item in ([entry for entry in assets if entry.get("type") == kind] if CONTEXT.get("includeAllAssets") else [entry for entry in assets if entry.get("type") == kind][:limits[kind]])]
result = {"host":socket.gethostname(),"dockerAvailable":docker_available,"disk":{"totalBytes":usage.total,"freeBytes":usage.free},"summary":summary,"assets":assets,"events":events[:24],"activeRelease":active_release,"revision":revision}
payload = gzip.compress(json.dumps(result, separators=(",",":"), ensure_ascii=False).encode("utf-8"))
encoded_payload = base64.b64encode(payload).decode("ascii")
transport_path = CONTEXT.get("transportPath") or ""
if transport_path and len(encoded_payload) > 16000:
    if not hasattr(os, "O_NOFOLLOW"): raise RuntimeError("O_NOFOLLOW is required for staged snapshot transport")
    transport_dir = os.path.dirname(transport_path)
    os.mkdir(transport_dir, 0o700)
    directory_info = os.lstat(transport_dir)
    if not stat.S_ISDIR(directory_info.st_mode) or stat.S_ISLNK(directory_info.st_mode) or directory_info.st_uid != os.geteuid() or stat.S_IMODE(directory_info.st_mode) != 0o700:
        raise RuntimeError("staged snapshot directory identity is unsafe")
    descriptor = os.open(transport_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    staged_info = os.fstat(descriptor)
    if not stat.S_ISREG(staged_info.st_mode) or staged_info.st_uid != os.geteuid() or stat.S_IMODE(staged_info.st_mode) != 0o600 or staged_info.st_nlink != 1:
        os.close(descriptor)
        raise RuntimeError("staged snapshot file identity is unsafe")
    with os.fdopen(descriptor, "w", encoding="ascii") as handle:
        handle.write(encoded_payload)
    print("RAT2:%d:%s:%d:%d:%d" % (len(encoded_payload), hashlib.sha256(encoded_payload.encode("ascii")).hexdigest(), staged_info.st_dev, staged_info.st_ino, staged_info.st_uid))
else:
    print("RAT1:" + encoded_payload)
`;
}

function runAwsSsmCommand(regionArgs, instanceId, command, comment, timeoutSeconds = 120) {
  const sent = runJson("aws", [
    ...regionArgs,
    "ssm", "send-command",
    "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript",
    "--comment", comment,
    "--parameters", JSON.stringify({ commands: [command] }),
    "--timeout-seconds", String(timeoutSeconds),
    "--output", "json",
  ], { timeout: 30_000 });
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("Systems Manager 未返回 commandId");

  const startedAt = Date.now();
  const waitLimit = (timeoutSeconds + 5) * 1_000;
  while (Date.now() - startedAt < waitLimit) {
    sleep(1_000);
    let invocation;
    try {
      invocation = runJson("aws", [
        ...regionArgs,
        "ssm", "get-command-invocation",
        "--command-id", commandId,
        "--instance-id", instanceId,
        "--output", "json",
      ], { timeout: 20_000 });
    } catch (error) {
      if (/InvocationDoesNotExist/i.test(error.message)) continue;
      throw error;
    }
    if (["Pending", "InProgress", "Delayed"].includes(invocation.Status)) continue;
    if (invocation.Status !== "Success") throw new Error(invocation.StandardErrorContent || `SSM 快照状态：${invocation.Status}`);
    return invocation;
  }
  throw new Error(`远程命令超过 ${waitLimit / 1_000} 秒仍未完成`);
}

export function decodeSnapshotPayload(encoded, { expectedLength, expectedSha256 } = {}) {
  const payload = String(encoded || "").trim();
  if (Number.isFinite(expectedLength) && payload.length !== expectedLength) {
    throw new Error(`远程快照分块长度不一致：预期 ${expectedLength}，实际 ${payload.length}`);
  }
  if (expectedSha256) {
    const actualSha256 = createHash("sha256").update(payload, "ascii").digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("远程快照分块校验失败");
  }
  return JSON.parse(gunzipSync(Buffer.from(payload, "base64")).toString("utf8"));
}

function collectAwsSnapshot(sourceConfig) {
  const instanceId = sourceConfig?.instanceId;
  if (!instanceId) throw new Error("未配置 EC2 instanceId");
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  const managed = runJson("aws", [
    ...regionArgs,
    "ssm", "describe-instance-information",
    "--filters", `Key=InstanceIds,Values=${instanceId}`,
    "--output", "json",
  ]);
  const instance = managed.InstanceInformationList?.find((item) => item.InstanceId === instanceId);
  if (!instance || instance.PingStatus !== "Online") {
    throw new Error(`EC2 ${instanceId} 未通过 Systems Manager 在线，当前不能读取 Docker 运行态`);
  }

  const transportPath = `/tmp/runtime-asset-tracker-${randomUUID()}/snapshot.b64`;
  const encoded = Buffer.from(remoteSnapshotScript({ ...sourceConfig, transportPath }), "utf8").toString("base64");
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const invocation = runAwsSsmCommand(regionArgs, instanceId, command, "Runtime Asset Tracker read-only snapshot");
  const lines = String(invocation.StandardOutputContent || "").split(/\r?\n/);
  const directMarker = lines.find((line) => line.startsWith("RAT1:"));
  if (directMarker) return decodeSnapshotPayload(directMarker.slice(5));

  const stagedMarker = lines.find((line) => line.startsWith("RAT2:"));
  const stagedMatch = stagedMarker?.match(/^RAT2:(\d+):([a-f0-9]{64}):(\d+):(\d+):(\d+)$/);
  if (!stagedMatch) throw new Error("远程快照没有返回有效载荷");
  const expectedLength = Number(stagedMatch[1]);
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > 32 * 1024 * 1024) {
    throw new Error("远程快照分块长度超出安全范围");
  }
  const chunkSize = 16_000;
  const chunks = [];
  let primaryError;
  let snapshot;
  try {
    for (let offset = 0; offset < expectedLength; offset += chunkSize) {
      const count = Math.min(chunkSize, expectedLength - offset);
      const chunkCommand = safeStagedFileReadCommand(transportPath, offset, count, { dev: stagedMatch[3], ino: stagedMatch[4], uid: stagedMatch[5] });
      const chunkInvocation = runAwsSsmCommand(regionArgs, instanceId, chunkCommand, "Runtime Asset Tracker snapshot chunk", 30);
      const chunk = String(chunkInvocation.StandardOutputContent || "").trim();
      if (chunk.length !== count) throw new Error(`远程快照分块 ${offset / chunkSize + 1} 长度不一致`);
      chunks.push(chunk);
    }
    snapshot = decodeSnapshotPayload(chunks.join(""), { expectedLength, expectedSha256: stagedMatch[2] });
  } catch (error) {
    primaryError = error;
  }
  try {
    const cleanupCommand = safeStagedFileCleanupCommand(transportPath, { dev: stagedMatch[3], ino: stagedMatch[4], uid: stagedMatch[5] });
    runAwsSsmCommand(regionArgs, instanceId, cleanupCommand, "Runtime Asset Tracker snapshot temp cleanup", 30);
  } catch (cleanupError) {
    if (!primaryError) primaryError = new Error(`远程快照已读取，但临时文件清理失败：${cleanupError.message}`);
  }
  if (primaryError) throw primaryError;
  return snapshot;
}

function decodeSnapshot(output) {
  const marker = String(output || "").split(/\r?\n/).find((line) => line.startsWith("RAT1:"));
  if (!marker) throw new Error("远程快照没有返回有效载荷");
  return decodeSnapshotPayload(marker.slice(5));
}

function collectSshSnapshot(sourceConfig) {
  const sshProfile = String(sourceConfig?.sshProfile || "").trim();
  if (!sshProfile) throw new Error("未配置 SSH Profile；私钥只应由 OpenSSH/系统凭据库管理");
  const encoded = Buffer.from(remoteSnapshotScript(sourceConfig), "utf8").toString("base64");
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const output = runStrict("ssh", [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=12",
    sshProfile,
    command,
  ], { timeout: 150_000, maxBuffer: 32 * 1024 * 1024 });
  return decodeSnapshot(output);
}

export function classifyGithubAsset({ kind, expired = false, expiresAt, lastAccessedAt, ref, pullState, now = Date.now(), expiryWindowDays = 7 }) {
  if (kind === "artifact") {
    const expiry = Date.parse(expiresAt || "");
    if (expired || (Number.isFinite(expiry) && expiry <= now)) return "reclaimable";
    if (Number.isFinite(expiry) && expiry - now <= expiryWindowDays * 24 * 60 * 60_000) return "expiring";
    return "retained";
  }
  const lastAccessed = new Date(lastAccessedAt || 0).getTime();
  const staleAt = lastAccessed + 30 * 24 * 60 * 60_000;
  const stale = now >= staleAt;
  const closedPullRequest = /^refs\/pull\/\d+\/merge$/.test(String(ref || "")) && pullState === "closed";
  if (stale || closedPullRequest) return "reclaimable";
  return staleAt - now <= expiryWindowDays * 24 * 60 * 60_000 ? "expiring" : "retained";
}

function collectGithubSnapshot(sourceConfig) {
  const repository = sourceConfig?.repository;
  if (!repository || !repository.includes("/")) throw new Error("未配置 GitHub owner/repository");
  const artifacts = runJson("gh", ["api", `repos/${repository}/actions/artifacts?per_page=100`]);
  const caches = runJson("gh", ["api", `repos/${repository}/actions/caches?per_page=100`]);
  const runs = runJson("gh", ["api", `repos/${repository}/actions/runs?per_page=30`]);
  const pulls = runJson("gh", ["api", `repos/${repository}/pulls?state=all&per_page=100`]);
  const now = Date.now();
  const pullStates = new Map((pulls || []).map((pull) => [String(pull.number), pull.state || "unknown"]));
  const assets = [
    ...(pulls || []).map((pull) => {
      const status = pull.draft ? "draft" : pull.merged_at ? "merged" : pull.state || "unknown";
      const active = status === "open" || status === "draft";
      return {
        id: String(pull.number),
        name: `#${pull.number} · ${pull.title}`,
        type: "pull_request",
        project: repository,
        environment: "github",
        status,
        classification: active ? "active" : "retained",
        sizeBytes: 1,
        unit: "count",
        createdAt: pull.created_at,
        updatedAt: pull.updated_at,
        author: pull.user?.login || "unknown",
        headRef: pull.head?.ref || "unknown",
        baseRef: pull.base?.ref || "unknown",
        url: pull.html_url,
        labels: {},
        reason: `${status === "draft" ? "Draft" : status[0]?.toUpperCase() + status.slice(1)} Pull Request`,
      };
    }),
    ...(artifacts.artifacts || []).map((item) => ({
      id: String(item.id),
      name: item.name,
      type: "artifact",
      remoteKind: "artifact",
      project: repository,
      environment: "github",
      status: item.expired ? "expired-artifact" : "artifact",
      classification: classifyGithubAsset({ kind: "artifact", expired: item.expired, expiresAt: item.expires_at }),
      sizeBytes: Number(item.size_in_bytes || 0),
      createdAt: item.created_at,
      expiresAt: item.expires_at,
      lineage: { workflowRunId: item.workflow_run?.id, repository },
      labels: {},
      reason: item.expired ? "已过期的 GitHub Actions artifact" : "有效的 GitHub Actions artifact",
    })),
    ...(caches.actions_caches || []).map((item) => {
      const match = String(item.ref || "").match(/^refs\/pull\/(\d+)\/merge$/);
      const pullState = match ? pullStates.get(match[1]) : undefined;
      const classification = classifyGithubAsset({
        kind: "actions-cache",
        lastAccessedAt: item.last_accessed_at || item.created_at,
        ref: item.ref,
        pullState,
        now,
      });
      const closedPullRequest = match && pullState === "closed";
      return {
        id: String(item.id),
        name: `${item.key} · ${item.ref || "unknown ref"}`,
        type: "actions_cache",
        remoteKind: "actions-cache",
        project: repository,
        environment: "github",
        status: classification === "reclaimable" ? (closedPullRequest ? "closed-pr-cache" : "stale-cache") : "actions-cache",
        classification,
        sizeBytes: Number(item.size_in_bytes || 0),
        createdAt: item.created_at,
        expiresAt: new Date(Date.parse(item.last_accessed_at || item.created_at || 0) + 30 * 24 * 60 * 60_000).toISOString(),
        lineage: { ref: item.ref, pullState, repository },
        labels: {},
        reason: closedPullRequest ? "已关闭 Pull Request 的 GitHub Actions cache"
          : classification === "reclaimable" ? "超过 30 天未访问的 GitHub Actions cache"
            : classification === "expiring" ? "将在 7 天内达到 30 天未访问期限"
            : `仍在保留期内的 GitHub Actions cache · ${item.ref || "unknown ref"}`,
      };
    }),
    ...(runs.workflow_runs || []).map((run) => {
      const status = run.conclusion || run.status || "unknown";
      const active = !run.conclusion && !["completed", "cancelled"].includes(run.status);
      return {
        id: String(run.id),
        name: `${run.name || run.display_title || "Workflow"} · ${run.head_branch || "unknown branch"}`,
        type: "workflow_run",
        project: repository,
        environment: "github",
        status,
        classification: active ? "active" : "retained",
        sizeBytes: 1,
        unit: "count",
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        headRef: run.head_branch || "unknown",
        url: run.html_url,
        labels: {},
        reason: active ? "Workflow 正在运行" : `Workflow 已完成 · ${status}`,
      };
    }),
  ];
  const events = (runs.workflow_runs || []).map((run) => ({
    id: String(run.id),
    occurredAt: run.updated_at || run.created_at,
    event: `github.workflow.${run.conclusion || run.status}`,
    project: repository,
    environment: "github",
    assetType: "workflow-run",
    assetId: String(run.id),
  }));
  return {
    host: "github.com",
    dockerAvailable: false,
    disk: { totalBytes: 0, freeBytes: 0 },
    bars: buildGithubBars(assets),
    assets,
    events,
    repository,
  };
}

export function awsBuildCacheCleanupScript() {
  return String.raw`set -eu
if docker version >/dev/null 2>&1; then
  docker builder prune --all --force
elif sudo -n docker version >/dev/null 2>&1; then
  sudo -n docker builder prune --all --force
else
  echo "Docker daemon is unavailable" >&2
  exit 40
fi`;
}

export function awsDockerCleanupScript(allowlist, sourceConfig = {}) {
  const payload = Buffer.from(JSON.stringify({
    safety: {
      managedRoots: [...(sourceConfig.managedPaths || []).map((item) => String(item.path || "")), String(sourceConfig.releaseRoot || "")].filter(Boolean),
      protectedPaths: [...(sourceConfig.protectedPaths || []).map(String), String(sourceConfig.activeLink || "")].filter(Boolean),
      activeLink: String(sourceConfig.activeLink || ""),
      resultPath: String(sourceConfig.cleanupResultPath || ""),
    },
    items: allowlist.map((item) => ({
    type: item.type,
    id: item.id,
    name: item.name,
    sizeBytes: Number(item.sizeBytes || 0),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    revision: item.revision ? String(item.revision) : undefined,
    retirementEvidence: item.retirementEvidence ? {
      reportSha256: String(item.retirementEvidence.reportSha256 || ""),
      group: String(item.retirementEvidence.group || ""),
      approvedTags: Array.isArray(item.retirementEvidence.approvedTags) ? item.retirementEvidence.approvedTags.map(String) : [],
      revision: String(item.retirementEvidence.revision || ""),
      assetType: String(item.retirementEvidence.assetType || ""),
      expectedSizeBytes: Number(item.retirementEvidence.expectedSizeBytes || 0),
      expectedName: String(item.retirementEvidence.expectedName || ""),
      expectedState: String(item.retirementEvidence.expectedState || ""),
      expectedImageId: String(item.retirementEvidence.expectedImageId || ""),
      expectedComposeProject: String(item.retirementEvidence.expectedComposeProject || ""),
      expectedMounts: Array.isArray(item.retirementEvidence.expectedMounts) ? item.retirementEvidence.expectedMounts : [],
      preserveVolumes: item.retirementEvidence.preserveVolumes === true,
      stopBeforeRemoval: item.retirementEvidence.stopBeforeRemoval === true,
      managedRoot: String(item.retirementEvidence.managedRoot || ""),
      fingerprint: String(item.retirementEvidence.fingerprint || ""),
      expectedReferences: Number(item.retirementEvidence.expectedReferences || 0),
      lifecycle: item.retirementEvidence.lifecycle,
    } : undefined,
  })),
  }), "utf8").toString("base64");
  return String.raw`import base64, datetime, gzip, hashlib, json, os, re, shutil, stat, subprocess, time

payload = json.loads(base64.b64decode("${payload}"))
items = payload.get("items") or []
safety = payload.get("safety") or {}

def run(args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

docker = ["docker"]
code, _, _ = run(docker + ["version"])
if code != 0:
    docker = ["sudo", "-n", "docker"]
    code, _, _ = run(docker + ["version"])
if code != 0:
    raise SystemExit("Docker daemon is unavailable")

result_path = safety.get("resultPath") or ""
result_dir = os.path.dirname(result_path) if result_path else ""
result_name = os.path.basename(result_path) if result_path else ""
result_dir_fd = None
result_descriptor = None
staged_info = None
if result_path:
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise RuntimeError("O_NOFOLLOW and O_DIRECTORY are required for staged cleanup transport")
    os.mkdir(result_dir, 0o700)
    result_dir_fd = os.open(result_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory_info = os.fstat(result_dir_fd)
    if not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != os.geteuid() or stat.S_IMODE(directory_info.st_mode) != 0o700:
        os.close(result_dir_fd)
        raise RuntimeError("staged cleanup directory identity is unsafe")
    result_descriptor = os.open(result_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=result_dir_fd)
    staged_info = os.fstat(result_descriptor)
    if not stat.S_ISREG(staged_info.st_mode) or staged_info.st_uid != os.geteuid() or stat.S_IMODE(staged_info.st_mode) != 0o600 or staged_info.st_nlink != 1:
        os.close(result_descriptor)
        os.close(result_dir_fd)
        raise RuntimeError("staged cleanup file identity is unsafe")

def inspect(kind, identifier):
    code, out, _ = run(docker + [kind, "inspect", identifier])
    if code != 0: return None
    try:
        rows = json.loads(out or "[]")
        return rows[0] if rows else None
    except Exception:
        return None

def label(labels, name):
    return (labels or {}).get("com.codex.runtime." + name)

def future_expiry(labels, created_at=None):
    value = label(labels, "expires-at") or label(labels, "retention-until")
    try: expires = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except Exception: expires = None
    if not expires:
        try: ttl_days = float(label(labels, "ttl-days") or 0)
        except Exception: ttl_days = 0
        try: created = datetime.datetime.fromisoformat(str(created_at).replace("Z", "+00:00")) if created_at else None
        except Exception: created = None
        expires = created + datetime.timedelta(days=ttl_days) if created and ttl_days > 0 else None
    return bool(expires and expires > datetime.datetime.now(datetime.timezone.utc))

def normalized_mounts(mounts):
    return sorted([{"type":str(mount.get("Type") or mount.get("type") or ""),"name":str(mount.get("Name") or mount.get("name") or ""),"source":str(mount.get("Source") or mount.get("source") or ""),"destination":str(mount.get("Destination") or mount.get("destination") or "")} for mount in (mounts or [])], key=lambda item:json.dumps(item,sort_keys=True))

def evidence_valid(evidence, asset_type):
    lifecycle = evidence.get("lifecycle") or {}
    lifecycle_ok = not lifecycle or (lifecycle.get("state") == "MERGED" and lifecycle.get("coolingComplete") is True)
    return bool(re.match(r"^[0-9a-f]{64}$", str(evidence.get("reportSha256") or ""), re.I) and evidence.get("assetType") == asset_type and lifecycle_ok)

def disk_usage(path):
    code, out, _ = run(["du", "-sb", "--", path], timeout=180)
    if code != 0: code, out, _ = run(["sudo", "-n", "du", "-sb", "--", path], timeout=180)
    try: return int(out.split()[0]) if code == 0 else -1
    except Exception: return -1

def metadata_fingerprint(path, size_bytes):
    try:
        stat = os.lstat(path)
        value = "%s\0%s\0%s\0%s\0%s" % (os.path.realpath(path), int(size_bytes), int(stat.st_mtime_ns), int(stat.st_mode), int(stat.st_ino))
        return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()
    except Exception: return ""

def path_is_referenced(path):
    target = os.path.realpath(path).rstrip("/")
    code, ids, _ = run(docker + ["ps", "-aq"])
    if code != 0: return True
    identifiers = ids.split()
    for start in range(0, len(identifiers), 30):
        code, out, _ = run(docker + ["container", "inspect"] + identifiers[start:start+30])
        if code != 0: return True
        try: details = json.loads(out or "[]")
        except Exception: return True
        for detail in details:
            for mount in detail.get("Mounts") or []:
                if mount.get("Type") != "bind" or not mount.get("Source"): continue
                source = os.path.realpath(str(mount.get("Source"))).rstrip("/")
                if source == target or source.startswith(target + "/") or target.startswith(source + "/"): return True
    return False

def canonical_path_is_contained(path, root):
    try:
        real_root = os.path.realpath(root).rstrip("/")
        real_path = os.path.realpath(path).rstrip("/")
        if not real_root or not real_path or real_path == real_root or not real_path.startswith(real_root + "/"): return False
        if os.path.islink(root): return False
        relative = os.path.relpath(path, root)
        if relative == ".." or relative.startswith("../"): return False
        cursor = root
        for part in relative.split(os.sep):
            if not part or part == ".": continue
            cursor = os.path.join(cursor, part)
            if os.path.islink(cursor): return False
        return True
    except Exception:
        return False

def path_identity(path):
    info = os.lstat(path)
    return (int(info.st_dev), int(info.st_ino), int(info.st_mode), int(getattr(info, "st_ctime_ns", 0)), bool(os.path.islink(path)))

def same_path_identity(path, expected):
    try: return path_identity(path) == expected
    except Exception: return False

def fd_identity(info):
    return (int(info.st_dev), int(info.st_ino), int(stat.S_IFMT(info.st_mode)))

def stable_path_identity(expected):
    return (int(expected[0]), int(expected[1]), int(stat.S_IFMT(expected[2])))

def fd_mount_id(descriptor):
    try:
        with open("/proc/self/fdinfo/%d" % descriptor, "r", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("mnt_id:"): return int(line.split(":", 1)[1].strip())
    except Exception as error:
        raise RuntimeError("Mount identity is unavailable") from error
    raise RuntimeError("Mount identity is unavailable")

def open_directory_no_follow(name, dir_fd=None):
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("O_DIRECTORY and O_NOFOLLOW are required for remote path cleanup")
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)

def remove_directory_contents_fd(directory_fd, expected_device, expected_mount_id):
    for name in os.listdir(directory_fd):
        if name in [".", ".."]: raise RuntimeError("Unexpected directory entry")
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if int(before.st_dev) != int(expected_device): raise RuntimeError("Cross-device path cleanup is blocked")
        if not hasattr(os, "O_PATH"): raise RuntimeError("O_PATH is required for mount-safe cleanup")
        entry_fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory_fd)
        try:
            if fd_identity(os.fstat(entry_fd)) != fd_identity(before) or fd_mount_id(entry_fd) != expected_mount_id:
                raise RuntimeError("Entry identity or mount changed before removal")
        finally:
            os.close(entry_fd)
        if stat.S_ISDIR(before.st_mode):
            child_fd = open_directory_no_follow(name, dir_fd=directory_fd)
            try:
                opened = os.fstat(child_fd)
                if fd_identity(opened) != fd_identity(before) or fd_mount_id(child_fd) != expected_mount_id: raise RuntimeError("Directory identity or mount changed before traversal")
                remove_directory_contents_fd(child_fd, expected_device, expected_mount_id)
                current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if fd_identity(current) != fd_identity(opened): raise RuntimeError("Directory identity changed before removal")
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)

def remove_managed_path_handle_relative(path, root, expected_root, expected_target):
    relative = os.path.relpath(path, root)
    parts = [part for part in relative.split(os.sep) if part not in ["", "."]]
    if not parts or any(part == ".." for part in parts): raise RuntimeError("Target is outside the managed root")
    root_fd = open_directory_no_follow(root)
    parent_fd = root_fd
    quarantine = None
    target_name = parts[-1]
    try:
        if fd_identity(os.fstat(root_fd)) != stable_path_identity(expected_root): raise RuntimeError("Managed root identity changed")
        root_mount_id = fd_mount_id(root_fd)
        for part in parts[:-1]:
            next_fd = open_directory_no_follow(part, dir_fd=parent_fd)
            if fd_mount_id(next_fd) != root_mount_id:
                os.close(next_fd)
                raise RuntimeError("Mount transition below managed root is blocked")
            if parent_fd != root_fd: os.close(parent_fd)
            parent_fd = next_fd
        before = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
        if fd_identity(before) != stable_path_identity(expected_target) or stat.S_ISLNK(before.st_mode): raise RuntimeError("Target identity changed before isolation")
        if not hasattr(os, "O_PATH"): raise RuntimeError("O_PATH is required for mount-safe cleanup")
        target_identity_fd = os.open(target_name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            if fd_identity(os.fstat(target_identity_fd)) != fd_identity(before) or fd_mount_id(target_identity_fd) != root_mount_id:
                raise RuntimeError("Target mount transition is blocked")
        finally:
            os.close(target_identity_fd)
        quarantine = ".runtime-asset-trash-" + hashlib.sha256((path + str(time.time_ns())).encode("utf-8")).hexdigest()[:24]
        os.rename(target_name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        isolated = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        if fd_identity(isolated) != stable_path_identity(expected_target):
            try:
                os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                try: os.rename(quarantine, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                except Exception: pass
            except Exception: pass
            raise RuntimeError("Target identity changed during isolation")
        if stat.S_ISDIR(isolated.st_mode):
            target_fd = open_directory_no_follow(quarantine, dir_fd=parent_fd)
            try:
                opened = os.fstat(target_fd)
                if fd_identity(opened) != fd_identity(isolated): raise RuntimeError("Isolated directory identity changed")
                if fd_mount_id(target_fd) != root_mount_id: raise RuntimeError("Isolated target mount transition is blocked")
                remove_directory_contents_fd(target_fd, isolated.st_dev, root_mount_id)
                current = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
                if fd_identity(current) != fd_identity(opened): raise RuntimeError("Isolated directory identity changed before removal")
            finally:
                os.close(target_fd)
            os.rmdir(quarantine, dir_fd=parent_fd)
        else:
            os.unlink(quarantine, dir_fd=parent_fd)
        quarantine = None
    finally:
        if parent_fd != root_fd: os.close(parent_fd)
        os.close(root_fd)

def overlaps_protected_path(path, protected_paths):
    target = os.path.realpath(path).rstrip("/")
    return any(target == protected or target.startswith(protected + "/") or protected.startswith(target + "/") for protected in protected_paths)

results = []
for item in items:
    kind = item.get("type")
    identifier = str(item.get("id") or "")
    safe = False
    reason = "执行前复核不再满足安全清理条件"
    if kind == "cache" and identifier == "docker-build-cache":
        code, _, error = run(docker + ["builder", "prune", "--all", "--force"])
        results.append({**item, "status":"removed" if code == 0 else "failed", "reclaimedBytes":item.get("sizeBytes", 0) if code == 0 else 0, "reason":"仅清理未使用 Build Cache" if code == 0 else error[-300:]})
        continue
    evidence = item.get("retirementEvidence") or {}
    if kind == "container":
        detail = inspect("container", identifier)
        if detail and evidence_valid(evidence, "container"):
            state = str((detail.get("State") or {}).get("Status") or "")
            expected_state = str(evidence.get("expectedState") or "")
            state_matches = state == expected_state or (expected_state == "running" and state == "exited")
            labels = (detail.get("Config") or {}).get("Labels") or {}
            exact = str(detail.get("Name") or "").lstrip("/") == str(evidence.get("expectedName") or "") and detail.get("Image") == evidence.get("expectedImageId") and labels.get("com.docker.compose.project") == evidence.get("expectedComposeProject") and normalized_mounts(detail.get("Mounts")) == normalized_mounts(evidence.get("expectedMounts"))
            safe = bool(state_matches and exact and evidence.get("preserveVolumes") is True and (state != "running" or evidence.get("stopBeforeRemoval") is True))
        if not safe:
            results.append({**item,"status":"skipped","reclaimedBytes":0,"reason":"Container identity, state, image, Compose project, mount set, or preserve-volumes contract drifted."})
            continue
        if state == "running":
            code, _, error = run(docker + ["stop", "--time", "30", identifier], timeout=60)
            if code != 0:
                results.append({**item,"status":"failed","reclaimedBytes":0,"reason":error[-300:]})
                continue
        code, _, error = run(docker + ["container", "rm", identifier])
        removed = code == 0 and inspect("container", identifier) is None
        results.append({**item,"status":"removed" if removed else "failed","reclaimedBytes":item.get("sizeBytes",0) if removed else 0,"preservedVolumes":True,"reason":"Exact merged-PR container removed without -v." if removed else error[-300:]})
        continue
    if kind in ["host_artifact", "worktree"]:
        path = identifier.rstrip("/")
        root = str(evidence.get("managedRoot") or "").rstrip("/")
        managed_roots = [str(value).rstrip("/") for value in (safety.get("managedRoots") or [])]
        protected_paths = [os.path.realpath(str(value)) for value in (safety.get("protectedPaths") or []) if value]
        active_link = str(safety.get("activeLink") or "")
        active_target = os.path.realpath(active_link) if active_link and os.path.exists(active_link) else ""
        size = disk_usage(path) if os.path.exists(path) else -1
        expected_size = evidence.get("expectedSizeBytes")
        parent = os.path.dirname(path)
        try:
            root_identity = path_identity(root)
            parent_identity = path_identity(parent)
            target_identity = path_identity(path)
        except Exception:
            root_identity = parent_identity = target_identity = None
        safe = bool(evidence_valid(evidence, kind) and root in managed_roots and root_identity and not root_identity[-1] and parent_identity and target_identity and canonical_path_is_contained(path, root) and not overlaps_protected_path(path, protected_paths) and os.path.realpath(path) != active_target and expected_size is not None and size == int(expected_size) and metadata_fingerprint(path,size) == evidence.get("fingerprint") and not path_is_referenced(path))
        if not safe:
            results.append({**item,"status":"skipped","reclaimedBytes":0,"reason":"Remote path root, active/protected state, bytes, fingerprint, or bind-mount references drifted."})
            continue
        try:
            if not canonical_path_is_contained(path, root) or not same_path_identity(root, root_identity) or not same_path_identity(parent, parent_identity) or not same_path_identity(path, target_identity):
                raise RuntimeError("Path ancestry changed before isolation")
            remove_managed_path_handle_relative(path, root, root_identity, target_identity)
            removed = not os.path.lexists(path)
            results.append({**item,"status":"removed" if removed else "failed","reclaimedBytes":size if removed else 0,"reason":"Exact managed path removed after live revalidation." if removed else "Path still exists after removal."})
        except Exception as error:
            results.append({**item,"status":"failed","reclaimedBytes":0,"reason":str(error)[-300:]})
        continue
    if kind == "image":
        detail = inspect("image", identifier)
        if detail:
            labels = (detail.get("Config") or {}).get("Labels") or {}
            code, refs, _ = run(docker + ["ps", "-aq", "--filter", "ancestor=" + identifier])
            tags = sorted(detail.get("RepoTags") or [])
            digests = detail.get("RepoDigests") or []
            dangling = not tags and not digests
            protected = label(labels, "retention") == "protected" or label(labels, "disposable") == "false"
            approved_tags = sorted(set(str(tag) for tag in (evidence.get("approvedTags") or []) if tag and not str(tag).startswith("<none>")))
            requested_tags = sorted(set(str(tag) for tag in (item.get("tags") or []) if tag and not str(tag).startswith("<none>")))
            revision = str(labels.get("org.opencontainers.image.revision") or label(labels, "git-sha") or "").lower()
            attested = bool(
                re.match(r"^[0-9a-f]{64}$", str(evidence.get("reportSha256") or ""), re.I)
                and re.match(r"^[0-9a-f]{40}$", str(evidence.get("revision") or ""), re.I)
                and revision == str(evidence.get("revision") or "").lower()
                and tags == approved_tags
                and tags == requested_tags
            )
            safe = code == 0 and not refs and not future_expiry(labels, detail.get("Created")) and ((not protected and (label(labels, "disposable") == "true" or dangling)) or attested)
            reason = "未被任何容器引用的悬空/显式 disposable 镜像"
    elif kind == "volume":
        detail = inspect("volume", identifier)
        if detail:
            labels = detail.get("Labels") or {}
            code, refs, _ = run(docker + ["ps", "-aq", "--filter", "volume=" + identifier])
            protected_name = re.search(r"postgres|mysql|maria|redis|valkey|upload|media|assets?|database|db[-_]?data|backup", identifier, re.I)
            protected = bool(protected_name) or label(labels, "retention") == "protected" or label(labels, "disposable") == "false"
            expected_references = evidence.get("expectedReferences")
            expected_size = evidence.get("expectedSizeBytes")
            attested = evidence_valid(evidence, "volume") and expected_references is not None and int(expected_references) == 0 and expected_size is not None and int(expected_size) == int(item.get("sizeBytes") or -2)
            safe = code == 0 and not refs and not protected and not future_expiry(labels, detail.get("CreatedAt")) and (label(labels, "disposable") == "true" or attested)
            reason = "未被任何容器挂载且明确 disposable 的卷"
    if not safe:
        results.append({**item, "status":"skipped", "reclaimedBytes":0, "reason":"执行前复核不再满足安全清理条件"})
        continue
    command = docker + (["image", "rm"] + (requested_tags if kind == "image" and requested_tags else [identifier]) if kind == "image" else ["volume", "rm", identifier])
    code, _, error = run(command)
    if kind == "image" and code == 0:
        for _ in range(6):
            if inspect("image", identifier) is None: break
            time.sleep(0.5)
    image_gone = kind != "image" or inspect("image", identifier) is None
    removed_references = [tag for tag in requested_tags if inspect("image", tag) is None] if kind == "image" else None
    removed = code == 0 and image_gone
    results.append({**item, "status":"removed" if removed else "failed", "reclaimedBytes":item.get("sizeBytes", 0) if removed else 0, "removedReferences":removed_references, "reason":reason if removed else (error[-300:] or "image still exists after exact tag removal")})

encoded = base64.b64encode(gzip.compress(json.dumps({"results":results}, separators=(",",":"), ensure_ascii=False).encode("utf-8"))).decode("ascii")
if result_path:
    payload_bytes = encoded.encode("ascii")
    offset = 0
    while offset < len(payload_bytes):
        offset += os.write(result_descriptor, payload_bytes[offset:])
    os.fsync(result_descriptor)
    os.close(result_descriptor)
    os.close(result_dir_fd)
    print("RATCLEAN2:%d:%s:%d:%d:%d" % (len(encoded), hashlib.sha256(encoded.encode("ascii")).hexdigest(), staged_info.st_dev, staged_info.st_ino, staged_info.st_uid))
else:
    print("RATCLEAN1:" + encoded)`;
}

function stagedFileCommand(context, body) {
  const encodedContext = Buffer.from(JSON.stringify(context), "utf8").toString("base64");
  const script = `import base64,json,os,stat\nC=json.loads(base64.b64decode("${encodedContext}"))\n${body}`;
  return `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(script, "utf8").toString("base64")}'))"`;
}

function safeStagedFileReadCommand(path, offset, count, identity) {
  return stagedFileCommand({ path, offset, count, ...identity }, `
p=C["path"]
d=os.path.dirname(p)
di=os.lstat(d)
assert stat.S_ISDIR(di.st_mode) and not stat.S_ISLNK(di.st_mode) and di.st_uid==int(C["uid"])==os.geteuid() and stat.S_IMODE(di.st_mode)==0o700
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 fd=os.open(os.path.basename(p),os.O_RDONLY|os.O_NOFOLLOW,dir_fd=dfd)
 s=os.fstat(fd)
 assert stat.S_ISREG(s.st_mode) and s.st_dev==int(C["dev"]) and s.st_ino==int(C["ino"]) and s.st_uid==int(C["uid"]) and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1
 with os.fdopen(fd,"rb") as f:
  f.seek(int(C["offset"]))
  print(f.read(int(C["count"])).decode("ascii"))
finally:
 os.close(dfd)`);
}

function safeStagedFileCleanupCommand(path, identity) {
  return stagedFileCommand({ path, ...identity }, `
p=C["path"]
d=os.path.dirname(p)
di=os.lstat(d)
assert stat.S_ISDIR(di.st_mode) and not stat.S_ISLNK(di.st_mode) and di.st_uid==int(C["uid"])==os.geteuid() and stat.S_IMODE(di.st_mode)==0o700
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 n=os.path.basename(p)
 fd=os.open(n,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=dfd)
 s=os.fstat(fd)
 os.close(fd)
 assert stat.S_ISREG(s.st_mode) and s.st_dev==int(C["dev"]) and s.st_ino==int(C["ino"]) and s.st_uid==int(C["uid"]) and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1
 os.unlink(n,dir_fd=dfd)
finally:
 os.close(dfd)
os.rmdir(d)`);
}

export function ssmMutationCommand(script) {
  const encoded = gzipSync(Buffer.from(String(script), "utf8"), { level: 9 }).toString("base64");
  return `echo '${encoded}' | base64 -d | gzip -d | bash`;
}

export function findExactSsmCommandId(commands, { comment, instanceId } = {}) {
  const matches = (commands || []).filter((item) => item?.Comment === comment
    && (!Array.isArray(item?.InstanceIds) || item.InstanceIds.includes(instanceId)));
  if (matches.length > 1) throw new Error(`Multiple SSM commands matched exact operation comment ${comment}; refusing ambiguous recovery.`);
  return matches[0]?.CommandId || null;
}

function reconcileSsmCommandId(sourceConfig, comment, { attempts = 1, delayMs = 0 } = {}) {
  const instanceId = sourceConfig.instanceId;
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const listed = runJson("aws", [...regionArgs, "ssm", "list-commands", "--instance-id", instanceId, "--max-results", "50", "--output", "json"], { timeout: 20_000 });
      const commandId = findExactSsmCommandId(listed.Commands, { comment, instanceId });
      if (commandId) return commandId;
    } catch (error) {
      if (/Multiple SSM commands/.test(error.message)) throw error;
    }
    if (attempt + 1 < attempts && delayMs > 0) sleep(delayMs);
  }
  return null;
}

function pollExistingSsmMutation(sourceConfig, commandId, comment, waitMs = 185_000) {
  const instanceId = sourceConfig.instanceId;
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  const mutationError = (message, mutationState) => Object.assign(new Error(message), { mutationState, commandId, operationComment: comment });
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    sleep(1_000);
    let invocation;
    try {
      invocation = runJson("aws", [...regionArgs, "ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId, "--output", "json"], { timeout: 20_000 });
    } catch (error) {
      if (/InvocationDoesNotExist/i.test(error.message)) continue;
      throw mutationError(error.message, "outcome_unknown");
    }
    if (["Pending", "InProgress", "Delayed"].includes(invocation.Status)) continue;
    if (invocation.Status !== "Success") throw Object.assign(mutationError(invocation.StandardErrorContent || `SSM cleanup status: ${invocation.Status}`, "outcome_unknown"), { output: String(invocation.StandardOutputContent || ""), terminalStatus: invocation.Status });
    return { commandId, output: String(invocation.StandardOutputContent || "") };
  }
  throw mutationError(`Remote cleanup command ${commandId} did not reach a terminal state within ${Math.ceil(waitMs / 1_000)} seconds.`, "outcome_unknown");
}

function runSsmMutation(sourceConfig, script, comment) {
  const instanceId = sourceConfig?.instanceId;
  if (!instanceId) throw new Error("EC2 instanceId is not configured.");
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  const managed = runJson("aws", [...regionArgs, "ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`, "--output", "json"]);
  const instance = managed.InstanceInformationList?.find((item) => item.InstanceId === instanceId);
  if (!instance || instance.PingStatus !== "Online") throw new Error(`EC2 ${instanceId} is not online through Systems Manager.`);
  const command = ssmMutationCommand(script);
  const mutationError = (message, mutationState, commandId) => Object.assign(new Error(message), { mutationState, commandId, operationComment: comment });
  let sent;
  try {
    sent = runJson("aws", [...regionArgs, "ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--comment", comment, "--parameters", JSON.stringify({ commands: [command] }), "--timeout-seconds", "180", "--output", "json"], { timeout: 30_000 });
  } catch (error) {
    const reconciledCommandId = reconcileSsmCommandId(sourceConfig, comment, { attempts: 8, delayMs: 1_000 });
    if (!reconciledCommandId) throw mutationError(`SSM send outcome is unknown; exact operation comment: ${comment}. Resume by operationId without resending. ${error.message}`, "outcome_unknown");
    sent = { Command: { CommandId: reconciledCommandId } };
  }
  const commandId = sent.Command?.CommandId || reconcileSsmCommandId(sourceConfig, comment, { attempts: 3, delayMs: 1_000 });
  if (!commandId) throw mutationError("Systems Manager did not return a commandId. Resume by operationId without resending.", "outcome_unknown");
  return pollExistingSsmMutation(sourceConfig, commandId, comment);
}

function decodeAwsCleanupResult(invocation, sourceConfig, resultPath) {
  const lines = String(invocation.output || "").split(/\r?\n/);
  const direct = lines.find((line) => line.startsWith("RATCLEAN1:"));
  if (direct) return decodeSnapshotPayload(direct.slice("RATCLEAN1:".length));
  const staged = lines.find((line) => line.startsWith("RATCLEAN2:"));
  const match = staged?.match(/^RATCLEAN2:(\d+):([a-f0-9]{64}):(\d+):(\d+):(\d+)$/);
  if (!match) throw Object.assign(new Error("Remote cleanup returned no checksum-verifiable result marker."), { mutationState: "outcome_unknown", commandId: invocation.commandId });
  const expectedLength = Number(match[1]);
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > 32 * 1024 * 1024) throw Object.assign(new Error("Remote cleanup result length is outside the safety bound."), { mutationState: "outcome_unknown", commandId: invocation.commandId });
  const instanceId = sourceConfig.instanceId;
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  const chunks = [];
  try {
    for (let offset = 0; offset < expectedLength; offset += 16_000) {
      const count = Math.min(16_000, expectedLength - offset);
      const command = safeStagedFileReadCommand(resultPath, offset, count, { dev: match[3], ino: match[4], uid: match[5] });
      const chunk = runAwsSsmCommand(regionArgs, instanceId, command, `RAT result ${invocation.commandId} ${offset}`, 30);
      const value = String(chunk.StandardOutputContent || "").trim();
      if (value.length !== count) throw new Error(`Remote cleanup result chunk ${offset / 16_000 + 1} has an unexpected length.`);
      chunks.push(value);
    }
    return decodeSnapshotPayload(chunks.join(""), { expectedLength, expectedSha256: match[2] });
  } catch (error) {
    throw Object.assign(error, { mutationState: "outcome_unknown", commandId: invocation.commandId });
  }
}

function cleanupAwsResultFile(sourceConfig, commandId, resultPath, output) {
  const instanceId = sourceConfig.instanceId;
  const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
  const staged = String(output || "").split(/\r?\n/).find((line) => line.startsWith("RATCLEAN2:"));
  const match = staged?.match(/^RATCLEAN2:(\d+):([a-f0-9]{64}):(\d+):(\d+):(\d+)$/);
  if (!match) return { status: "retained-for-recovery", reason: "Missing exact staged-file identity." };
  try {
    runAwsSsmCommand(regionArgs, instanceId, safeStagedFileCleanupCommand(resultPath, { dev: match[3], ino: match[4], uid: match[5] }), `RAT result cleanup ${commandId}`, 30);
    return { status: "removed-or-absent" };
  } catch (error) {
    return { status: "retained-for-recovery", reason: error.message };
  }
}

function collectPostCleanupSnapshot(sourceConfig, commandId, partialResults) {
  try {
    return collectAwsSnapshot(sourceConfig);
  } catch (error) {
    throw Object.assign(new Error(`Cleanup command ${commandId} completed, but post-cleanup inventory failed: ${error.message}`), { mutationState: "outcome_unknown", commandId, partialResults });
  }
}

function executeAwsDockerCleanup(sourceConfig, allowlist, operationId) {
  const cleanupResultPath = `/tmp/runtime-asset-tracker-cleanup-${String(operationId).replace(/[^a-zA-Z0-9-]/g, "")}/result.b64`;
  const fullSourceConfig = { ...sourceConfig, includeAllAssets: true, cleanupResultPath };
  const snapshot = collectAwsSnapshot(fullSourceConfig);
  const currentAssets = new Map(snapshot.assets.map((item) => [`${item.type}:${item.id}`, item]));
  const skipped = [];
  const approved = [];
  for (const requested of allowlist) {
    const current = currentAssets.get(`${requested.type}:${requested.id}`);
    const safe = current?.classification === "reclaimable" || validateRemoteRetirementApproval(requested, current, fullSourceConfig);
    if (!current || !safe) skipped.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前快照复核不再满足安全清理条件" });
    else approved.push({ ...requested, sizeBytes: current.sizeBytes, reason: current.reason });
  }
  if (!approved.length) return { completedAt: new Date().toISOString(), results: skipped };
  const script = awsDockerCleanupScript(approved, fullSourceConfig);
  const encoded = gzipSync(Buffer.from(script, "utf8"), { level: 9 }).toString("base64");
  const invocation = runSsmMutation(fullSourceConfig, `echo '${encoded}' | base64 -d | gzip -d | python3`, `RAT ${operationId}`);
  const payload = decodeAwsCleanupResult(invocation, fullSourceConfig, cleanupResultPath);
  remoteCache.clear();
  const results = [...skipped, ...(payload.results || [])];
  const after = collectPostCleanupSnapshot(fullSourceConfig, invocation.commandId, results);
  const resultTransportCleanup = invocation.output.includes("RATCLEAN2:") ? cleanupAwsResultFile(fullSourceConfig, invocation.commandId, cleanupResultPath, invocation.output) : { status: "not-staged" };
  return { completedAt: new Date().toISOString(), commandId: invocation.commandId, results, verification: buildPostCleanupVerification(snapshot, after, results), resultTransportCleanup };
}

export function resumeAwsCleanup({ sourceConfig, operationId, commandId, allowlist = [] } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(operationId || ""))) throw new Error("A valid cleanup operationId is required.");
  const instanceId = sourceConfig?.instanceId;
  if (!instanceId) throw new Error("EC2 instanceId is not configured.");
  const comment = `RAT ${operationId}`;
  let exactCommandId = String(commandId || "").trim();
  if (exactCommandId) {
    const regionArgs = sourceConfig.region ? ["--region", sourceConfig.region] : [];
    const listed = runJson("aws", [...regionArgs, "ssm", "list-commands", "--command-id", exactCommandId, "--output", "json"], { timeout: 20_000 });
    if (findExactSsmCommandId(listed.Commands, { comment, instanceId }) !== exactCommandId) throw new Error("The supplied SSM commandId is not bound to the exact cleanup operation and instance.");
  } else {
    exactCommandId = reconcileSsmCommandId(sourceConfig, comment, { attempts: 8, delayMs: 1_000 }) || "";
  }
  if (!exactCommandId) return { completedAt: new Date().toISOString(), operationId, commandId: null, status: "outcome_unknown", results: [], resumeToken: { operationId, commandId: null }, reason: "Exact commandId is not visible yet; retry this resume operation without sending a new cleanup command." };
  let invocation;
  try {
    invocation = pollExistingSsmMutation(sourceConfig, exactCommandId, comment);
  } catch (error) {
    if (error.mutationState !== "outcome_unknown" || error.commandId !== exactCommandId) throw error;
    invocation = { commandId: exactCommandId, output: String(error.output || ""), terminalStatus: error.terminalStatus || "Unknown" };
  }
  const resultPath = `/tmp/runtime-asset-tracker-cleanup-${String(operationId).replace(/[^a-zA-Z0-9-]/g, "")}/result.b64`;
  const hasResultMarker = /RATCLEAN[12]:/.test(invocation.output);
  const payload = hasResultMarker ? decodeAwsCleanupResult(invocation, sourceConfig, resultPath) : { results: [] };
  const results = hasResultMarker ? (payload.results || []) : (allowlist || []).map((item) => ({ ...item, status: "outcome_unknown", reclaimedBytes: 0, reason: `SSM terminal status ${invocation.terminalStatus || "unknown"} had no durable result marker; live reconciliation is required.` }));
  if (!hasResultMarker && results.length === 0) throw Object.assign(new Error("The failed SSM operation has no result marker or persisted exact allowlist for live reconciliation."), { mutationState: "outcome_unknown", commandId: exactCommandId });
  remoteCache.clear();
  const after = collectPostCleanupSnapshot({ ...sourceConfig, includeAllAssets: true }, exactCommandId, results);
  const resultTransportCleanup = invocation.output.includes("RATCLEAN2:") ? cleanupAwsResultFile(sourceConfig, exactCommandId, resultPath, invocation.output) : { status: hasResultMarker ? "not-staged" : "retained-or-unavailable-for-reconciliation" };
  const remaining = new Set((after.assets || []).map((asset) => `${asset.type}:${asset.id}`));
  const reconciledResults = results.map((item) => {
    const stillPresent = remaining.has(`${item.type}:${item.id}`);
    if (!hasResultMarker && item.type !== "cache" && !stillPresent) return { ...item, status: "removed", reclaimedBytes: Number(item.sizeBytes || 0), reason: "Exact object is absent in the live post-command inventory; removal was reconciled without resending." };
    if (item.status === "removed" && stillPresent) return { ...item, status: "outcome_unknown", reclaimedBytes: 0, reason: "Command reported removal but the exact object is still present during resume reconciliation." };
    return item;
  });
  const incomplete = reconciledResults.filter((item) => item.status !== "removed").length;
  return {
    completedAt: new Date().toISOString(), operationId, commandId: exactCommandId,
    status: incomplete === 0 ? "reconciled-complete" : reconciledResults.some((item) => item.status === "removed") ? "reconciled-partial" : "reconciled-not-complete",
    results: reconciledResults,
    verification: { status: "reconciled", exactCommandRecovered: true, remainingApprovedObjects: reconciledResults.filter((item) => remaining.has(`${item.type}:${item.id}`)).map((item) => item.id) },
    resultTransportCleanup,
  };
}

function runSshMutation(sourceConfig, script) {
  const sshProfile = String(sourceConfig?.sshProfile || "").trim();
  if (!sshProfile) throw new Error("未配置 SSH Profile；私钥只应由 OpenSSH/系统凭据库管理");
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return runStrict("ssh", [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=12",
    sshProfile,
    `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`,
  ], { timeout: 210_000, maxBuffer: 32 * 1024 * 1024 });
}

function executeSshDockerCleanup(sourceConfig, allowlist) {
  const fullSourceConfig = { ...sourceConfig, includeAllAssets: true };
  const snapshot = collectSshSnapshot(fullSourceConfig);
  const currentAssets = new Map(snapshot.assets.map((item) => [`${item.type}:${item.id}`, item]));
  const skipped = [];
  const approved = [];
  for (const requested of allowlist) {
    const current = currentAssets.get(`${requested.type}:${requested.id}`);
    const safe = current?.classification === "reclaimable" || validateRemoteRetirementApproval(requested, current, fullSourceConfig);
    if (!current || !safe) skipped.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前快照复核不再满足安全清理条件" });
    else approved.push({ ...requested, sizeBytes: current.sizeBytes, reason: current.reason });
  }
  if (!approved.length) return { completedAt: new Date().toISOString(), results: skipped };
  const output = runSshMutation(fullSourceConfig, awsDockerCleanupScript(approved, fullSourceConfig));
  const match = output.match(/RATCLEAN1:([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error("远程清理没有返回可验证结果");
  const payload = JSON.parse(gunzipSync(Buffer.from(match[1], "base64")).toString("utf8"));
  remoteCache.clear();
  const results = [...skipped, ...(payload.results || [])];
  const after = collectSshSnapshot(fullSourceConfig);
  return { completedAt: new Date().toISOString(), results, verification: buildPostCleanupVerification(snapshot, after, results) };
}

function executeGithubCleanup(sourceConfig, allowlist) {
  const snapshot = collectGithubSnapshot(sourceConfig);
  const safeAssets = new Map(snapshot.assets.filter((item) => item.classification === "reclaimable").map((item) => [`${item.remoteKind}:${item.id}`, item]));
  const results = [];
  for (const requested of allowlist) {
    const safe = safeAssets.get(`${requested.remoteKind}:${requested.id}`);
    if (!safe) {
      results.push({ ...requested, status: "skipped", reason: "执行前复核不再满足安全清理条件" });
      continue;
    }
    const endpoint = safe.remoteKind === "artifact"
      ? `repos/${sourceConfig.repository}/actions/artifacts/${safe.id}`
      : `repos/${sourceConfig.repository}/actions/caches/${safe.id}`;
    try {
      runStrict("gh", ["api", "--method", "DELETE", endpoint]);
      results.push({ ...requested, status: "removed", reclaimedBytes: safe.sizeBytes });
    } catch (error) {
      results.push({ ...requested, status: "failed", reason: sanitizeError(error.message) });
    }
  }
  remoteCache.clear();
  return { completedAt: new Date().toISOString(), results };
}

export function executeRemoteCleanup({ source, sourceConfig, allowlist, operationId = randomUUID() }) {
  if (!sourceConfig) throw new Error(`${source} 来源尚未配置`);
  if (sourceConfig.kind === "github") return executeGithubCleanup(sourceConfig, allowlist);
  if (sourceConfig.kind === "ssh") return executeSshDockerCleanup(sourceConfig, allowlist);
  return executeAwsDockerCleanup(sourceConfig, allowlist, operationId);
}

function registeredProjectOptions(config, sourceConfig) {
  const configured = Array.isArray(config.projects) && config.projects.length
    ? config.projects
    : sourceConfig?.repository ? [{ id: sourceConfig.repository, repository: sourceConfig.repository }] : [];
  const unique = new Map();
  for (const item of configured) {
    const repository = String(item.repository || item.id || "").replace(/^.*github\.com[/:]/i, "").replace(/\.git$/i, "").replace(/\/$/, "");
    if (!/^[^/]+\/[^/]+$/.test(repository) || unique.has(repository.toLowerCase())) continue;
    unique.set(repository.toLowerCase(), {
      id: repository,
      repository,
      label: String(item.label || repository.split("/").at(-1)),
      aliases: [...new Set([...(item.aliases || []), item.id, item.label, repository.split("/").at(-1)].filter(Boolean).map(String))],
      assetPrefixes: [...new Set((item.assetPrefixes || []).filter(Boolean).map(String))],
    });
  }
  return [...unique.values()];
}

function canonicalRemoteProject(value, projects) {
  const key = String(value || "").toLowerCase();
  const match = projects.find((item) => [item.id, item.repository, item.label, ...item.aliases]
    .some((candidate) => String(candidate || "").toLowerCase() === key));
  return match?.id || value || "unknown";
}

export function assetInSelectedProjectScope(asset, selectedProject) {
  if (selectedProject === "all") return true;
  if (asset?.project === selectedProject) return true;
  return Array.isArray(asset?.lineage?.projects) && asset.lineage.projects.includes(selectedProject);
}

export function limitDashboardAssets(assets, includeAllAssets = false) {
  return includeAllAssets ? assets : assets.slice(0, 320);
}

export function collectRemoteDashboard({ source, scope, project, config, sources, includeAllAssets = false }) {
  const schedule = config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" };
  const baseSourceConfig = (config.sources || []).find((item) => item.id === source);
  const projectOptions = registeredProjectOptions(config, baseSourceConfig);
  const selectedRepository = baseSourceConfig?.kind === "github"
    ? (project !== "all" ? project : baseSourceConfig.repository || projectOptions[0]?.repository)
    : undefined;
  const selectedProject = selectedRepository || project;
  const selectedProjectOption = projectOptions.find((item) => item.id === selectedProject);
  const sourceConfig = baseSourceConfig?.kind === "github"
    ? { ...baseSourceConfig, repository: selectedRepository }
    : baseSourceConfig ? {
      ...baseSourceConfig,
      projectAliases: baseSourceConfig.projectAliases || selectedProjectOption?.aliases || [],
      assetPrefixes: baseSourceConfig.assetPrefixes || selectedProjectOption?.assetPrefixes || [],
      includeAllAssets,
    } : baseSourceConfig;
  const empty = {
    generatedAt: new Date().toISOString(),
    scope,
    selectedSource: source,
    selectedProject,
    host: sourceConfig?.label || sourceConfig?.repository || "等待远程快照",
    dockerAvailable: false,
    disk: { totalBytes: 0, freeBytes: 0 },
    bars: emptyBars(),
    sources,
    projects: projectOptions.map((item) => item.id),
    projectOptions,
    assets: [],
    events: [],
    schedule,
    remoteSnapshotAvailable: false,
  };
  if (!sourceConfig) return { ...empty, remoteError: "该来源尚未配置" };

  try {
    const cacheKey = `${selectedProject}:${source}:${sourceConfig.instanceId || sourceConfig.sshProfile || sourceConfig.repository}`;
    const cached = remoteCache.get(cacheKey);
    let snapshot;
    let fromCache = false;
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      snapshot = cached.value;
      fromCache = true;
    } else {
      snapshot = sourceConfig.kind === "github"
        ? collectGithubSnapshot(sourceConfig)
        : sourceConfig.kind === "ssh"
          ? collectSshSnapshot(sourceConfig)
          : collectAwsSnapshot(sourceConfig);
      remoteCache.set(cacheKey, { createdAt: Date.now(), value: snapshot });
    }
    const canonicalAssets = snapshot.assets.map((asset) => ({ ...asset, project: canonicalRemoteProject(asset.project, projectOptions) }));
    const filteredAssets = canonicalAssets.filter((asset) => assetInSelectedProjectScope(asset, selectedProject));
    const siblingAssets = canonicalAssets.filter((asset) => !assetInSelectedProjectScope(asset, selectedProject));
    const siblingProjects = [...new Set(siblingAssets.flatMap((asset) => {
      if (asset.type === "container") return [asset.project];
      if (Array.isArray(asset.lineage?.projects)) return asset.lineage.projects;
      return asset.lineage?.composeProject ? [asset.lineage.composeProject] : [];
    }).filter((value) => value && !["unknown", "shared", selectedProject].includes(value)))].sort();
    const hostGuard = {
      siblingAssetCount: siblingAssets.length,
      unattributedAssetCount: siblingAssets.filter((asset) => asset.project === "unknown").length,
      sharedDependencyCount: filteredAssets.filter((asset) => asset.project === "shared").length,
      siblingProjects,
    };
    const projects = projectOptions.length
      ? projectOptions.map((item) => item.id)
      : [...new Set(canonicalAssets.map((asset) => asset.project).filter(Boolean))].sort();
    return {
      ...empty,
      generatedAt: new Date().toISOString(),
      host: snapshot.host,
      dockerAvailable: snapshot.dockerAvailable,
      disk: snapshot.disk,
      bars: sourceConfig.kind === "github" ? buildGithubBars(filteredAssets) : buildBars(filteredAssets, snapshot.summary),
      sources: sources.map((item) => item.id === source ? { ...item, status: "connected", detail: sourceConfig.kind === "github" ? selectedRepository : snapshot.host } : item),
      projects,
      projectOptions,
      assets: limitDashboardAssets(filteredAssets.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)), includeAllAssets),
      events: snapshot.events || [],
      remoteSnapshotAvailable: true,
      snapshotMode: sourceConfig.kind === "github" ? "github-api" : sourceConfig.kind === "ssh" ? "ssh-readonly" : "aws-ssm-readonly",
      activeRelease: snapshot.activeRelease,
      revision: snapshot.revision,
      hostGuard,
      cached: fromCache,
    };
  } catch (error) {
    return {
      ...empty,
      sources: sources.map((item) => item.id === source ? { ...item, status: "error", detail: "读取失败" } : item),
      remoteError: sanitizeError(error.message),
    };
  }
}
