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
  return ["worktree", "image", "volume", "cache"].map((type) => ({
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
  return [...new Set((tags || []).map(String).filter((tag) => tag && !tag.startsWith("<none>")))].sort();
}

export function validateRemoteRetirementApproval(requested, current, sourceConfig = {}) {
  if (!requested || !current || requested.type !== "image" || current.type !== "image" || requested.id !== current.id) return false;
  if (String(requested.project || "") !== String(sourceConfig.projectId || requested.project || "")) return false;
  if ((current.lineage?.consumers || []).length > 0) return false;
  const evidence = requested.retirementEvidence;
  if (!/^[0-9a-f]{64}$/i.test(String(evidence?.reportSha256 || ""))) return false;
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
  const missingActiveContainers = [...beforeActive].filter(([id]) => !afterActive.has(id)).map(([id, name]) => ({ id, name }));
  const remainingImageIds = new Set((after?.assets || []).filter((asset) => asset.type === "image").map((asset) => asset.id));
  const removedIds = results.filter((item) => item.status === "removed" && item.type === "image").map((item) => item.id);
  const removedImagesStillPresent = removedIds.filter((id) => remainingImageIds.has(id));
  const freeBytesBefore = Number(before?.disk?.freeBytes || 0);
  const freeBytesAfter = Number(after?.disk?.freeBytes || 0);
  return {
    status: missingActiveContainers.length === 0 && removedImagesStillPresent.length === 0 ? "pass" : "fail",
    checkedAt: new Date().toISOString(),
    activeContainerCountBefore: beforeActive.size,
    activeContainerCountAfter: afterActive.size,
    missingActiveContainers,
    removedImagesStillPresent,
    freeBytesBefore,
    freeBytesAfter,
    freeBytesDelta: freeBytesAfter - freeBytesBefore,
  };
}

export function remoteSnapshotScript(sourceConfig = {}) {
  const context = Buffer.from(JSON.stringify({
    project: sourceConfig.projectId || "sparklingplaycms",
    environment: sourceConfig.id || "remote",
    releaseRoot: sourceConfig.releaseRoot ?? "/home/ec2-user/apps/sparkling-cms-releases",
    activeLink: sourceConfig.activeLink ?? "/home/ec2-user/apps/sparkling-cms",
    expiryWindowDays: Number(sourceConfig.expiryWindowDays || 7),
    transportPath: sourceConfig.transportPath || "",
  }), "utf8").toString("base64");
  return String.raw`
import base64, datetime, gzip, hashlib, json, os, re, shutil, socket, subprocess

PREFIX = "com.codex.runtime."
CONTEXT = json.loads(base64.b64decode("${context}"))
DEFAULT_PROJECT = CONTEXT.get("project") or "unknown"
DEFAULT_ENVIRONMENT = CONTEXT.get("environment") or "remote"
EXPIRY_WINDOW_DAYS = int(CONTEXT.get("expiryWindowDays") or 7)

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

def project(labels, fallback=None):
    return label(labels, "project") or DEFAULT_PROJECT or fallback or "unknown"

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
for item in container_details:
    name = str(item.get("Name") or "").lstrip("/")
    state = (item.get("State") or {}).get("Status") or "unknown"
    if item.get("Image"): image_consumers.setdefault(item.get("Image"), []).append({"id":item.get("Id"),"name":name,"state":state})
    for mount in (item.get("Mounts") or []):
        if mount.get("Type") == "volume" and mount.get("Name"):
            volume_consumers.setdefault(mount.get("Name"), []).append({"id":item.get("Id"),"name":name,"state":state,"destination":mount.get("Destination")})

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
    assets.append({
        "id": item.get("Id"), "name": str(item.get("Name") or "").lstrip("/"), "type":"container",
        "project": project(labels), "environment": label(labels, "environment") or "remote",
        "status": (item.get("State") or {}).get("Status") or "unknown", "classification": classify(labels, active=active, created_at=item.get("Created")),
        "sizeBytes": parse_bytes((container_row_map.get(item.get("Id")) or {}).get("Size")), "createdAt": item.get("Created"),
        "labels": labels, "lineage":{"composeProject":labels.get("com.docker.compose.project"),"imageId":item.get("Image"),"mounts":[{"type":mount.get("Type"),"name":mount.get("Name"),"destination":mount.get("Destination")} for mount in (item.get("Mounts") or [])]}, "reason": "正在运行" if active else "已停止，等待归属确认"
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
    assets.append({
        "id":image_id, "name":tags[0] if tags else image_id[:19], "type":"image", "project":project(labels, (tags[0].split(":")[0] if tags else "unknown")),
        "environment":label(labels, "environment") or "remote", "status":"in-use" if running else ("referenced-stopped" if referenced else ("dangling" if dangling else "unused")),
        "classification":image_class, "sizeBytes":unique_size,
        "createdAt":created_at, "expiresAt":expires_at, "labels":labels, "lineage":{"consumers":image_consumers.get(image_id, []),"tags":tags,"revision":labels.get("org.opencontainers.image.revision"),"source":labels.get("org.opencontainers.image.source")},
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
    assets.append({
        "id":name, "name":name, "type":"volume", "project":project(labels, name.split("_")[0]),
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
if os.path.isdir(release_root):
    for entry in sorted(os.scandir(release_root), key=lambda item:item.stat().st_mtime, reverse=True)[:60]:
        if not entry.is_dir(follow_symlinks=False): continue
        active = os.path.realpath(entry.path) == active_release
        assets.append({"id":entry.path,"name":entry.name,"type":"worktree","project":DEFAULT_PROJECT,"environment":DEFAULT_ENVIRONMENT,"status":"active-release" if active else "retained-release","classification":"active" if active else "retained","sizeBytes":0,"createdAt":datetime.datetime.fromtimestamp(entry.stat().st_mtime, datetime.timezone.utc).isoformat(),"labels":{},"reason":"当前活动 release" if active else "保留的 release"})

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
limits = {"container":200, "image":500, "volume":500, "worktree":60, "cache":10}
assets = [item for kind in ["container", "image", "volume", "worktree", "cache"] for item in [entry for entry in assets if entry.get("type") == kind][:limits[kind]]]
result = {"host":socket.gethostname(),"dockerAvailable":docker_available,"disk":{"totalBytes":usage.total,"freeBytes":usage.free},"summary":summary,"assets":assets,"events":events[:24],"activeRelease":active_release,"revision":revision}
payload = gzip.compress(json.dumps(result, separators=(",",":"), ensure_ascii=False).encode("utf-8"))
encoded_payload = base64.b64encode(payload).decode("ascii")
transport_path = CONTEXT.get("transportPath") or ""
if transport_path and len(encoded_payload) > 16000:
    descriptor = os.open(transport_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as handle:
        handle.write(encoded_payload)
    print("RAT2:%d:%s" % (len(encoded_payload), hashlib.sha256(encoded_payload.encode("ascii")).hexdigest()))
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

  const transportPath = `/tmp/runtime-asset-tracker-${randomUUID()}.b64`;
  const encoded = Buffer.from(remoteSnapshotScript({ ...sourceConfig, transportPath }), "utf8").toString("base64");
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const invocation = runAwsSsmCommand(regionArgs, instanceId, command, "Runtime Asset Tracker read-only snapshot");
  const lines = String(invocation.StandardOutputContent || "").split(/\r?\n/);
  const directMarker = lines.find((line) => line.startsWith("RAT1:"));
  if (directMarker) return decodeSnapshotPayload(directMarker.slice(5));

  const stagedMarker = lines.find((line) => line.startsWith("RAT2:"));
  const stagedMatch = stagedMarker?.match(/^RAT2:(\d+):([a-f0-9]{64})$/);
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
      const chunkCommand = `python3 -c "p='${transportPath}';f=open(p,'rb');f.seek(${offset});print(f.read(${count}).decode('ascii'))"`;
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
    const cleanupCommand = `python3 -c "import os;p='${transportPath}';os.path.exists(p) and os.remove(p)"`;
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

export function awsDockerCleanupScript(allowlist) {
  const payload = Buffer.from(JSON.stringify(allowlist.map((item) => ({
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
    } : undefined,
  }))), "utf8").toString("base64");
  return String.raw`import base64, datetime, gzip, json, re, subprocess

items = json.loads(base64.b64decode("${payload}"))

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
    if kind == "image":
        detail = inspect("image", identifier)
        if detail:
            labels = (detail.get("Config") or {}).get("Labels") or {}
            code, refs, _ = run(docker + ["ps", "-aq", "--filter", "ancestor=" + identifier])
            tags = sorted(detail.get("RepoTags") or [])
            digests = detail.get("RepoDigests") or []
            dangling = not tags and not digests
            protected = label(labels, "retention") == "protected" or label(labels, "disposable") == "false"
            evidence = item.get("retirementEvidence") or {}
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
            safe = code == 0 and not refs and not protected and not future_expiry(labels, detail.get("CreatedAt")) and label(labels, "disposable") == "true"
            reason = "未被任何容器挂载且明确 disposable 的卷"
    if not safe:
        results.append({**item, "status":"skipped", "reclaimedBytes":0, "reason":"执行前复核不再满足安全清理条件"})
        continue
    command = docker + (["image", "rm"] + (requested_tags if kind == "image" and requested_tags else [identifier]) if kind == "image" else ["volume", "rm", identifier])
    code, _, error = run(command)
    removed = code == 0 and (kind != "image" or inspect("image", identifier) is None)
    results.append({**item, "status":"removed" if removed else "failed", "reclaimedBytes":item.get("sizeBytes", 0) if removed else 0, "removedReferences":requested_tags if kind == "image" else None, "reason":reason if removed else (error[-300:] or "image still exists after exact tag removal")})

encoded = base64.b64encode(gzip.compress(json.dumps({"results":results}, separators=(",",":"), ensure_ascii=False).encode("utf-8"))).decode("ascii")
print("RATCLEAN1:" + encoded)`;
}

export function ssmMutationCommand(script) {
  const encoded = gzipSync(Buffer.from(String(script), "utf8"), { level: 9 }).toString("base64");
  return `echo '${encoded}' | base64 -d | gzip -d | bash`;
}

function runSsmMutation(sourceConfig, script, comment) {
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
  if (!instance || instance.PingStatus !== "Online") throw new Error(`EC2 ${instanceId} 未通过 Systems Manager 在线`);

  const command = ssmMutationCommand(script);
  const sent = runJson("aws", [
    ...regionArgs,
    "ssm", "send-command",
    "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript",
    "--comment", comment,
    "--parameters", JSON.stringify({ commands: [command] }),
    "--timeout-seconds", "180",
    "--output", "json",
  ], { timeout: 30_000 });
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("Systems Manager 未返回 commandId");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 185_000) {
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
    if (invocation.Status !== "Success") throw new Error(invocation.StandardErrorContent || `SSM 清理状态：${invocation.Status}`);
    return { commandId, output: String(invocation.StandardOutputContent || "").slice(-24_000) };
  }
  throw new Error("远程清理超过 185 秒仍未完成");
}

function executeAwsDockerCleanup(sourceConfig, allowlist) {
  const snapshot = collectAwsSnapshot(sourceConfig);
  const currentAssets = new Map(snapshot.assets.map((item) => [`${item.type}:${item.id}`, item]));
  const skipped = [];
  const approved = [];
  for (const requested of allowlist) {
    const current = currentAssets.get(`${requested.type}:${requested.id}`);
    const safe = current?.classification === "reclaimable" || validateRemoteRetirementApproval(requested, current, sourceConfig);
    if (!current || !safe) skipped.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前快照复核不再满足安全清理条件" });
    else approved.push({ ...requested, sizeBytes: current.sizeBytes, reason: current.reason });
  }
  if (!approved.length) return { completedAt: new Date().toISOString(), results: skipped };
  const script = awsDockerCleanupScript(approved);
  const encoded = gzipSync(Buffer.from(script, "utf8"), { level: 9 }).toString("base64");
  const invocation = runSsmMutation(sourceConfig, `echo '${encoded}' | base64 -d | gzip -d | python3`, "Runtime Asset Tracker exact safe Docker cleanup");
  const match = invocation.output.match(/RATCLEAN1:([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error("远程清理没有返回可验证结果");
  const payload = JSON.parse(gunzipSync(Buffer.from(match[1], "base64")).toString("utf8"));
  remoteCache.clear();
  const results = [...skipped, ...(payload.results || [])];
  const after = collectAwsSnapshot(sourceConfig);
  return { completedAt: new Date().toISOString(), commandId: invocation.commandId, results, verification: buildPostCleanupVerification(snapshot, after, results) };
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
  const snapshot = collectSshSnapshot(sourceConfig);
  const currentAssets = new Map(snapshot.assets.map((item) => [`${item.type}:${item.id}`, item]));
  const skipped = [];
  const approved = [];
  for (const requested of allowlist) {
    const current = currentAssets.get(`${requested.type}:${requested.id}`);
    const safe = current?.classification === "reclaimable" || validateRemoteRetirementApproval(requested, current, sourceConfig);
    if (!current || !safe) skipped.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前快照复核不再满足安全清理条件" });
    else approved.push({ ...requested, sizeBytes: current.sizeBytes, reason: current.reason });
  }
  if (!approved.length) return { completedAt: new Date().toISOString(), results: skipped };
  const output = runSshMutation(sourceConfig, awsDockerCleanupScript(approved));
  const match = output.match(/RATCLEAN1:([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error("远程清理没有返回可验证结果");
  const payload = JSON.parse(gunzipSync(Buffer.from(match[1], "base64")).toString("utf8"));
  remoteCache.clear();
  const results = [...skipped, ...(payload.results || [])];
  const after = collectSshSnapshot(sourceConfig);
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

export function executeRemoteCleanup({ source, sourceConfig, allowlist }) {
  if (!sourceConfig) throw new Error(`${source} 来源尚未配置`);
  if (sourceConfig.kind === "github") return executeGithubCleanup(sourceConfig, allowlist);
  if (sourceConfig.kind === "ssh") return executeSshDockerCleanup(sourceConfig, allowlist);
  return executeAwsDockerCleanup(sourceConfig, allowlist);
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

export function collectRemoteDashboard({ source, scope, project, config, sources }) {
  const schedule = config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" };
  const baseSourceConfig = (config.sources || []).find((item) => item.id === source);
  const projectOptions = registeredProjectOptions(config, baseSourceConfig);
  const selectedRepository = baseSourceConfig?.kind === "github"
    ? (project !== "all" ? project : baseSourceConfig.repository || projectOptions[0]?.repository)
    : undefined;
  const sourceConfig = baseSourceConfig?.kind === "github"
    ? { ...baseSourceConfig, repository: selectedRepository }
    : baseSourceConfig;
  const selectedProject = selectedRepository || project;
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
    const filteredAssets = selectedProject === "all" ? canonicalAssets : canonicalAssets.filter((asset) => asset.project === selectedProject);
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
      assets: filteredAssets.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)).slice(0, 320),
      events: snapshot.events || [],
      remoteSnapshotAvailable: true,
      snapshotMode: sourceConfig.kind === "github" ? "github-api" : sourceConfig.kind === "ssh" ? "ssh-readonly" : "aws-ssm-readonly",
      activeRelease: snapshot.activeRelease,
      revision: snapshot.revision,
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
