import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

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
  const reclaimableBytes = sum("reclaimable");
  const measured = matching.reduce((total, asset) => total + (type === "worktree" ? 1 : Number(asset.sizeBytes || 0)), 0);
  const totalBytes = type === "worktree" ? matching.length : Math.max(measured, Number(summary?.sizeBytes || 0));
  return {
    type,
    totalBytes,
    count: Number(summary?.totalCount ?? matching.length),
    activeBytes,
    protectedBytes,
    retainedBytes: Math.max(0, totalBytes - activeBytes - protectedBytes - reclaimableBytes),
    reclaimableBytes,
    unit: type === "worktree" ? "count" : "bytes",
  };
}

function buildBars(assets, summary = {}) {
  return [
    aggregate("worktree", assets),
    aggregate("image", assets, summary.Images),
    aggregate("volume", assets, summary["Local Volumes"]),
    aggregate("cache", assets, summary["Build Cache"]),
  ];
}

export function remoteSnapshotScript() {
  return String.raw`
import base64, datetime, gzip, json, os, re, shutil, socket, subprocess

PREFIX = "com.codex.runtime."

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
    return {k:v for k,v in (labels or {}).items() if k.startswith(PREFIX) or k.startswith("com.docker.compose.") or k == "org.opencontainers.image.revision"}

def label(labels, name):
    return (labels or {}).get(PREFIX + name)

def project(labels, fallback="unknown"):
    return label(labels, "project") or (labels or {}).get("com.docker.compose.project") or fallback or "unknown"

def classify(labels, active=False, protected=False, dangling=False):
    if active: return "active"
    if protected or label(labels, "retention") == "protected" or label(labels, "disposable") == "false": return "protected"
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

container_row_map = {row.get("ID"): row for row in container_rows}
for item in container_details:
    labels = safe_labels((item.get("Config") or {}).get("Labels"))
    active = bool((item.get("State") or {}).get("Running"))
    assets.append({
        "id": item.get("Id"), "name": str(item.get("Name") or "").lstrip("/"), "type":"container",
        "project": project(labels), "environment": label(labels, "environment") or "remote",
        "status": (item.get("State") or {}).get("Status") or "unknown", "classification": classify(labels, active=active),
        "sizeBytes": parse_bytes((container_row_map.get(item.get("Id")) or {}).get("Size")), "createdAt": item.get("Created"),
        "labels": {}, "reason": "正在运行" if active else "已停止，等待归属确认"
    })

image_rows = json_lines(docker(["image", "ls", "--no-trunc", "--format", "{{json .}}"])) if docker_available else []
image_map = {}
for row in image_rows:
    image_id = row.get("ID")
    if not image_id: continue
    entry = image_map.setdefault(image_id, {"row":row, "tags":[]})
    ref = "%s:%s" % (row.get("Repository") or "<none>", row.get("Tag") or "<none>")
    if ref not in entry["tags"]: entry["tags"].append(ref)

governed = set(referenced_images)
for value in ["true", "false"]:
    governed.update(filter(None, docker(["image", "ls", "--no-trunc", "--filter", "label=" + PREFIX + "disposable=" + value, "--format", "{{.ID}}"]).splitlines()))
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
    active = image_id in running_images
    assets.append({
        "id":image_id, "name":tags[0] if tags else image_id[:19], "type":"image", "project":project(labels, (tags[0].split(":")[0] if tags else "unknown")),
        "environment":label(labels, "environment") or "remote", "status":"in-use" if image_id in referenced_images else "unused",
        "classification":classify(labels, active=active, dangling=dangling), "sizeBytes":parse_bytes(entry["row"].get("Size")),
        "createdAt":entry["row"].get("CreatedAt"), "labels":{}, "reason":"活动容器镜像" if active else "未引用但没有可丢弃标签"
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
    protected = bool(protected_pattern.search(name))
    assets.append({
        "id":name, "name":name, "type":"volume", "project":project(labels, name.split("_")[0]),
        "environment":label(labels, "environment") or "remote", "status":"mounted-running" if active else ("mounted-stopped" if name in all_mounted else "unmounted"),
        "classification":classify(labels, active=active, protected=protected), "sizeBytes":0, "createdAt":item.get("CreatedAt"),
        "labels":{}, "reason":"名称表明可能包含业务数据" if protected else ("正在被运行容器挂载" if active else "卷默认保护")
    })

for row in json_lines(docker(["system", "df", "--format", "{{json .}}"])) if docker_available else []:
    summary[row.get("Type")] = {"totalCount":int(row.get("TotalCount") or 0), "activeCount":int(row.get("Active") or 0), "sizeBytes":parse_bytes(row.get("Size")), "reclaimableBytes":parse_bytes(row.get("Reclaimable"))}

release_root = "/home/ec2-user/apps/sparkling-cms-releases"
active_link = "/home/ec2-user/apps/sparkling-cms"
active_release = os.path.realpath(active_link) if os.path.exists(active_link) else ""
if os.path.isdir(release_root):
    for entry in sorted(os.scandir(release_root), key=lambda item:item.stat().st_mtime, reverse=True)[:60]:
        if not entry.is_dir(follow_symlinks=False): continue
        active = os.path.realpath(entry.path) == active_release
        assets.append({"id":entry.path,"name":entry.name,"type":"worktree","project":"sparklingplaycms","environment":"remote","status":"active-release" if active else "retained-release","classification":"active" if active else "retained","sizeBytes":0,"createdAt":datetime.datetime.fromtimestamp(entry.stat().st_mtime, datetime.timezone.utc).isoformat(),"labels":{},"reason":"当前活动 release" if active else "保留的 release"})

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
limits = {"container":40, "image":50, "volume":50, "worktree":30}
assets = [item for kind in ["container", "image", "volume", "worktree"] for item in [entry for entry in assets if entry.get("type") == kind][:limits[kind]]]
result = {"host":socket.gethostname(),"dockerAvailable":docker_available,"disk":{"totalBytes":usage.total,"freeBytes":usage.free},"summary":summary,"assets":assets,"events":events[:24],"activeRelease":active_release,"revision":revision}
payload = gzip.compress(json.dumps(result, separators=(",",":"), ensure_ascii=False).encode("utf-8"))
print("RAT1:" + base64.b64encode(payload).decode("ascii"))
`;
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

  const encoded = Buffer.from(remoteSnapshotScript(), "utf8").toString("base64");
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const sent = runJson("aws", [
    ...regionArgs,
    "ssm", "send-command",
    "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript",
    "--comment", "Runtime Asset Tracker read-only snapshot",
    "--parameters", JSON.stringify({ commands: [command] }),
    "--timeout-seconds", "120",
    "--output", "json",
  ], { timeout: 30_000 });
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("Systems Manager 未返回 commandId");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 125_000) {
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
    const marker = String(invocation.StandardOutputContent || "").split(/\r?\n/).find((line) => line.startsWith("RAT1:"));
    if (!marker) throw new Error("远程快照没有返回有效载荷");
    return JSON.parse(gunzipSync(Buffer.from(marker.slice(5), "base64")).toString("utf8"));
  }
  throw new Error("远程快照超过 125 秒仍未完成");
}

function collectGithubSnapshot(sourceConfig) {
  const repository = sourceConfig?.repository;
  if (!repository || !repository.includes("/")) throw new Error("未配置 GitHub owner/repository");
  const artifacts = runJson("gh", ["api", `repos/${repository}/actions/artifacts?per_page=100`]);
  const caches = runJson("gh", ["api", `repos/${repository}/actions/caches?per_page=100`]);
  const runs = runJson("gh", ["api", `repos/${repository}/actions/runs?per_page=30`]);
  const now = Date.now();
  const assets = [
    ...(artifacts.artifacts || []).map((item) => ({
      id: String(item.id),
      name: item.name,
      type: "cache",
      project: repository,
      environment: "github",
      status: item.expired ? "expired-artifact" : "artifact",
      classification: item.expired ? "review" : "retained",
      sizeBytes: Number(item.size_in_bytes || 0),
      createdAt: item.created_at,
      labels: {},
      reason: item.expired ? "已过期，等待人工确认" : "GitHub Actions artifact",
    })),
    ...(caches.actions_caches || []).map((item) => {
      const stale = now - new Date(item.last_accessed_at || item.created_at).getTime() > 30 * 24 * 60 * 60_000;
      return {
        id: String(item.id),
        name: `${item.key} · ${item.ref || "unknown ref"}`,
        type: "cache",
        project: repository,
        environment: "github",
        status: stale ? "stale-cache" : "actions-cache",
        classification: stale ? "review" : "retained",
        sizeBytes: Number(item.size_in_bytes || 0),
        createdAt: item.created_at,
        labels: {},
        reason: stale ? "30 天未访问，等待人工确认" : `GitHub Actions cache · ${item.ref || "unknown ref"}`,
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
    summary: {
      "Build Cache": {
        totalCount: assets.length,
        activeCount: 0,
        sizeBytes: assets.reduce((total, item) => total + item.sizeBytes, 0),
        reclaimableBytes: 0,
      },
    },
    assets,
    events,
    repository,
  };
}

export function collectRemoteDashboard({ source, scope, project, config, sources }) {
  const schedule = config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" };
  const sourceConfig = (config.sources || []).find((item) => item.id === source);
  const empty = {
    generatedAt: new Date().toISOString(),
    scope,
    selectedSource: source,
    selectedProject: project,
    host: sourceConfig?.label || sourceConfig?.repository || "等待远程快照",
    dockerAvailable: false,
    disk: { totalBytes: 0, freeBytes: 0 },
    bars: emptyBars(),
    sources,
    projects: sourceConfig?.repository ? [sourceConfig.repository] : [],
    assets: [],
    events: [],
    schedule,
    remoteSnapshotAvailable: false,
  };
  if (!sourceConfig) return { ...empty, remoteError: "该来源尚未配置" };

  try {
    const cacheKey = `${source}:${sourceConfig.instanceId || sourceConfig.repository}`;
    const cached = remoteCache.get(cacheKey);
    let snapshot;
    let fromCache = false;
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      snapshot = cached.value;
      fromCache = true;
    } else {
      snapshot = sourceConfig.kind === "github" ? collectGithubSnapshot(sourceConfig) : collectAwsSnapshot(sourceConfig);
      remoteCache.set(cacheKey, { createdAt: Date.now(), value: snapshot });
    }
    const filteredAssets = project === "all" ? snapshot.assets : snapshot.assets.filter((asset) => asset.project === project);
    const projects = [...new Set(snapshot.assets.map((asset) => asset.project).filter(Boolean))].sort();
    return {
      ...empty,
      generatedAt: new Date().toISOString(),
      host: snapshot.host,
      dockerAvailable: snapshot.dockerAvailable,
      disk: snapshot.disk,
      bars: buildBars(filteredAssets, snapshot.summary),
      sources: sources.map((item) => item.id === source ? { ...item, status: "connected", detail: snapshot.host } : item),
      projects,
      assets: filteredAssets.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)).slice(0, 320),
      events: snapshot.events || [],
      remoteSnapshotAvailable: true,
      snapshotMode: sourceConfig.kind === "github" ? "github-api" : "aws-ssm-readonly",
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
