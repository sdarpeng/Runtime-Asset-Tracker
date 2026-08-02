import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { collectRemoteDashboard, executeRemoteCleanup } from "./remote.mjs";

const RUNTIME_PREFIX = "com.codex.runtime.";
const previewStore = new Map();
const dashboardCache = new Map();

export function stateRoot() {
  if (process.env.RUNTIME_ASSET_STATE_DIR) return resolve(process.env.RUNTIME_ASSET_STATE_DIR);
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RuntimeAssetTracker");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "runtime-asset-tracker");
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 20_000,
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
    }).trim();
  } catch {
    return "";
  }
}

function jsonLines(output) {
  return String(output || "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function parseBytes(value) {
  const match = String(value || "").trim().match(/^(-?[\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?/i);
  if (!match) return 0;
  const units = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 };
  return Math.max(0, Number(match[1]) * (units[(match[2] || "B").toUpperCase()] || 1));
}

function chunks(values, size = 36) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function inspectMany(kind, identifiers) {
  const unique = [...new Set(identifiers.filter(Boolean))];
  return chunks(unique).flatMap((part) => {
    const output = run("docker", [kind, "inspect", ...part], { timeout: 30_000 });
    if (!output) return [];
    try { return JSON.parse(output); } catch { return []; }
  });
}

function safeLabels(labels) {
  return Object.fromEntries(Object.entries(labels || {}).filter(([key]) =>
    key.startsWith(RUNTIME_PREFIX) || key.startsWith("com.docker.compose.") || key === "org.opencontainers.image.revision"));
}

function labelValue(labels, key) {
  return labels?.[`${RUNTIME_PREFIX}${key}`];
}

function classification({ labels = {}, active = false, dangling = false, knownProtected = false }) {
  if (active) return "active";
  if (knownProtected || labelValue(labels, "retention") === "protected" || labelValue(labels, "disposable") === "false") return "protected";
  if (labelValue(labels, "disposable") === "true") return "reclaimable";
  if (dangling) return "review";
  return "retained";
}

function projectFrom(labels, fallback = "unknown") {
  return labelValue(labels, "project") || labels?.["com.docker.compose.project"] || fallback || "unknown";
}

function environmentFrom(labels) {
  return labelValue(labels, "environment") || "local";
}

function parseVerboseVolumeSizes() {
  const output = run("docker", ["system", "df", "-v"], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  const marker = "Local Volumes space usage:";
  const start = output.indexOf(marker);
  if (start < 0) return new Map();
  const section = output.slice(start + marker.length).split("Build cache usage:")[0];
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1);
  return new Map(lines.flatMap((line) => {
    const parts = line.split(/\s{2,}/);
    return parts.length >= 3 ? [[parts[0], parseBytes(parts[2])]] : [];
  }));
}

function dockerSummary() {
  const rows = jsonLines(run("docker", ["system", "df", "--format", "{{json .}}"]));
  return Object.fromEntries(rows.map((row) => [row.Type, {
    totalCount: Number(row.TotalCount || 0),
    activeCount: Number(row.Active || 0),
    sizeBytes: parseBytes(row.Size),
    reclaimableBytes: parseBytes(row.Reclaimable),
  }]));
}

function dockerInventory() {
  const available = Boolean(run("docker", ["version", "--format", "{{.Server.Version}}"]));
  if (!available) return { available: false, assets: [], summary: {} };

  const containerRows = jsonLines(run("docker", ["ps", "-a", "--size", "--no-trunc", "--format", "{{json .}}"]));
  const containerDetails = inspectMany("container", containerRows.map((item) => item.ID));
  const runningImageIds = new Set(containerDetails.filter((item) => item.State?.Running).map((item) => item.Image));
  const allMountedVolumes = new Set(containerDetails.flatMap((item) => (item.Mounts || []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name)));
  const activeMountedVolumes = new Set(containerDetails.filter((item) => item.State?.Running).flatMap((item) =>
    (item.Mounts || []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name)));

  const containers = containerDetails.map((item) => {
    const labels = safeLabels(item.Config?.Labels);
    const active = Boolean(item.State?.Running);
    return {
      id: item.Id,
      name: String(item.Name || "").replace(/^\//, ""),
      type: "container",
      project: projectFrom(labels),
      environment: environmentFrom(labels),
      status: item.State?.Status || "unknown",
      classification: classification({ labels, active }),
      sizeBytes: parseBytes(containerRows.find((row) => row.ID === item.Id)?.Size),
      createdAt: item.Created,
      labels,
      reason: active ? "正在运行" : labelValue(labels, "disposable") === "true" ? "已停止且明确可丢弃" : "已停止，等待归属确认",
    };
  });

  const imageRows = jsonLines(run("docker", ["image", "ls", "--no-trunc", "--format", "{{json .}}"]));
  const governedImageIds = [
    ...runningImageIds,
    ...run("docker", ["image", "ls", "--no-trunc", "--filter", "label=com.codex.runtime.disposable=true", "--format", "{{.ID}}"] ).split(/\r?\n/),
    ...run("docker", ["image", "ls", "--no-trunc", "--filter", "label=com.codex.runtime.disposable=false", "--format", "{{.ID}}"] ).split(/\r?\n/),
  ].filter(Boolean);
  const imageDetails = new Map(inspectMany("image", governedImageIds).map((item) => [item.Id, item]));
  const consolidatedImages = new Map();
  for (const row of imageRows) {
    const existing = consolidatedImages.get(row.ID) || { ...row, tags: [] };
    const reference = `${row.Repository || "<none>"}:${row.Tag || "<none>"}`;
    if (!existing.tags.includes(reference)) existing.tags.push(reference);
    consolidatedImages.set(row.ID, existing);
  }
  const images = [...consolidatedImages.values()].map((row) => {
    const item = imageDetails.get(row.ID);
    const labels = safeLabels(item?.Config?.Labels);
    const tags = row.tags;
    const active = runningImageIds.has(row.ID);
    const dangling = tags.length === 0 || tags.every((tag) => tag.startsWith("<none>"));
    return {
      id: row.ID,
      name: tags[0] || row.ID.slice(7, 19),
      type: "image",
      project: projectFrom(labels, tags[0]?.split(/[/:]/)[0]),
      environment: environmentFrom(labels),
      status: active ? "in-use" : dangling ? "dangling" : "unused",
      classification: classification({ labels, active, dangling }),
      sizeBytes: parseBytes(row.Size),
      createdAt: item?.Created || row.CreatedAt,
      labels,
      reason: active ? "被运行容器引用" : labelValue(labels, "disposable") === "true" ? "未引用且明确可丢弃" : dangling ? "悬空镜像，需确认归属" : "未引用但没有可丢弃标签",
    };
  });

  const volumeRows = jsonLines(run("docker", ["volume", "ls", "--format", "{{json .}}"]));
  const volumeDetails = inspectMany("volume", volumeRows.map((item) => item.Name));
  const volumeSizes = parseVerboseVolumeSizes();
  const protectedName = /(postgres|mysql|redis|valkey|uploads?|media|assets?|database|db[-_]?data)/i;
  const volumes = volumeDetails.map((item) => {
    const labels = safeLabels(item.Labels);
    const active = activeMountedVolumes.has(item.Name);
    const mounted = allMountedVolumes.has(item.Name);
    const knownProtected = protectedName.test(item.Name);
    return {
      id: item.Name,
      name: item.Name,
      type: "volume",
      project: projectFrom(labels, item.Labels?.["com.docker.compose.project"]),
      environment: environmentFrom(labels),
      status: active ? "mounted-running" : mounted ? "mounted-stopped" : "unmounted",
      classification: classification({ labels, active, knownProtected }),
      sizeBytes: volumeSizes.get(item.Name) || 0,
      createdAt: item.CreatedAt,
      labels,
      reason: active ? "被运行容器挂载" : knownProtected ? "名称表明可能包含业务数据" : labelValue(labels, "disposable") === "true" ? "未挂载且明确可丢弃" : "卷默认保护",
    };
  });

  return { available: true, assets: [...containers, ...images, ...volumes], summary: dockerSummary() };
}

function worktreeInventory() {
  const configuredRoot = loadConfig().gitRoots?.[0];
  const output = run("git", ["worktree", "list", "--porcelain"], { cwd: process.env.RUNTIME_ASSET_GIT_ROOT || configuredRoot || process.cwd() });
  if (!output) return [];
  const blocks = output.split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map((block) => {
    const fields = Object.fromEntries(block.split(/\r?\n/).map((line) => {
      const space = line.indexOf(" ");
      return space > 0 ? [line.slice(0, space), line.slice(space + 1)] : [line, true];
    }));
    const path = fields.worktree;
    const status = path ? run("git", ["status", "--short"], { cwd: path, timeout: 8_000 }) : "";
    const dirty = Boolean(status);
    return {
      id: path,
      name: path ? parse(path).base : "unknown",
      path,
      type: "worktree",
      project: "sparklingplaycms",
      environment: "local",
      status: dirty ? "dirty" : fields.detached ? "detached" : "clean",
      classification: dirty ? "protected" : fields.detached ? "review" : "retained",
      sizeBytes: 1,
      unit: "count",
      gitSha: fields.HEAD,
      branch: typeof fields.branch === "string" ? fields.branch.replace("refs/heads/", "") : "detached",
      reason: dirty ? "包含未提交内容" : fields.detached ? "干净 detached worktree，可审查" : "干净分支 worktree，未证明可删除",
    };
  });
}

function readLedger(limit = 24) {
  const ledger = process.env.RUNTIME_ASSET_LEDGER_FILE || join(stateRoot(), "events.jsonl");
  if (!existsSync(ledger)) return [];
  const stats = statSync(ledger);
  const length = Math.min(stats.size, 2 * 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(ledger, "r");
  readSync(fd, buffer, 0, length, stats.size - length);
  closeSync(fd);
  return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-limit).reverse().flatMap((line) => {
    try {
      const item = JSON.parse(line);
      return [{
        id: item.eventId,
        occurredAt: item.occurredAt,
        event: item.event,
        project: item.project,
        environment: item.environment,
        assetType: item.asset?.type,
        assetId: item.asset?.id,
        status: item.status,
      }];
    } catch { return []; }
  });
}

function loadConfig() {
  const path = process.env.RUNTIME_ASSET_DASHBOARD_CONFIG || join(stateRoot(), "dashboard-config.json");
  if (!existsSync(path)) return { sources: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { sources: [] }; }
}

export function saveSchedule(schedule) {
  const path = process.env.RUNTIME_ASSET_DASHBOARD_CONFIG || join(stateRoot(), "dashboard-config.json");
  const config = loadConfig();
  const next = {
    ...config,
    schedule: {
      enabled: Boolean(schedule.enabled),
      cadence: ["daily", "weekly", "monthly"].includes(schedule.cadence) ? schedule.cadence : "weekly",
      day: String(schedule.day || "sunday"),
      time: /^\d{2}:\d{2}$/.test(String(schedule.time || "")) ? String(schedule.time) : "03:00",
      mode: "preview-only",
      updatedAt: new Date().toISOString(),
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  dashboardCache.clear();
  return next.schedule;
}

function aggregate(type, assets, fallback = {}) {
  const matching = assets.filter((asset) => asset.type === type);
  const sum = (kind) => matching.filter((asset) => asset.classification === kind).reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0);
  const total = matching.reduce((value, asset) => value + Number(asset.sizeBytes || 0), 0) || Number(fallback.sizeBytes || 0);
  return {
    type,
    totalBytes: total,
    count: matching.length,
    activeBytes: sum("active"),
    protectedBytes: sum("protected"),
    retainedBytes: sum("retained") + sum("review"),
    reclaimableBytes: sum("reclaimable"),
    unit: type === "worktree" ? "count" : "bytes",
  };
}

export function collectDashboard({ scope = "environment", source = "local", project = "all" } = {}) {
  const cacheKey = `${scope}:${source}:${project}`;
  const cached = dashboardCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 20_000) return { ...cached.value, generatedAt: new Date().toISOString(), cached: true };
  if (source !== "local") {
    const remoteConfig = loadConfig();
    const remoteDiskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
    const configuredSources = new Map((remoteConfig.sources || []).map((item) => [item.id, item]));
    const sources = [
      { id: "local", label: `Local ${remoteDiskRoot}`, kind: "local", status: "connected", detail: hostname() },
      { id: "production", label: "EC2 Production", kind: "server", status: configuredSources.has("production") ? "configured" : "not-configured", detail: configuredSources.get("production")?.label || "等待配置" },
      { id: "staging", label: "EC2 Staging", kind: "server", status: configuredSources.has("staging") ? "configured" : "not-configured", detail: configuredSources.get("staging")?.label || "等待配置" },
      { id: "github", label: "GitHub", kind: "github", status: configuredSources.has("github") ? "configured" : "not-configured", detail: configuredSources.get("github")?.repository || "等待配置" },
    ];
    return collectRemoteDashboard({ source, scope, project, config: remoteConfig, sources });
  }
  const docker = dockerInventory();
  const worktrees = worktreeInventory();
  const allAssets = [...worktrees, ...docker.assets];
  const sourceAssets = source === "local" ? allAssets : [];
  const filtered = project === "all" ? sourceAssets : sourceAssets.filter((asset) => asset.project === project);
  const config = loadConfig();
  const diskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
  let disk = { totalBytes: 0, freeBytes: 0 };
  try {
    const stats = statfsSync(diskRoot);
    disk = { totalBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch { /* disk metrics are optional */ }
  const summary = docker.summary;
  const bars = [
    aggregate("worktree", filtered),
    aggregate("image", filtered, summary.Images),
    aggregate("volume", filtered, summary["Local Volumes"]),
    {
      type: "cache",
      totalBytes: Number(summary["Build Cache"]?.sizeBytes || 0),
      count: Number(summary["Build Cache"]?.totalCount || 0),
      activeBytes: 0,
      protectedBytes: 0,
      retainedBytes: Math.max(0, Number(summary["Build Cache"]?.sizeBytes || 0) - Number(summary["Build Cache"]?.reclaimableBytes || 0)),
      reclaimableBytes: Number(summary["Build Cache"]?.reclaimableBytes || 0),
      unit: "bytes",
    },
  ];
  const projects = [...new Set(allAssets.map((asset) => asset.project).filter((value) => value && value !== "unknown"))].sort();
  const configuredSources = new Map((config.sources || []).map((item) => [item.id, item]));
  const sources = [
    { id: "local", label: `Local ${diskRoot}`, kind: "local", status: docker.available ? "connected" : "unavailable", detail: hostname() },
    { id: "production", label: "EC2 Production", kind: "server", status: configuredSources.has("production") ? "configured" : "not-configured", detail: configuredSources.get("production")?.label || "等待配置" },
    { id: "staging", label: "EC2 Staging", kind: "server", status: configuredSources.has("staging") ? "configured" : "not-configured", detail: configuredSources.get("staging")?.label || "等待配置" },
    { id: "github", label: "GitHub", kind: "github", status: configuredSources.has("github") ? "configured" : "not-configured", detail: configuredSources.get("github")?.repository || "等待配置" },
  ];
  const dashboard = {
    generatedAt: new Date().toISOString(),
    scope,
    selectedSource: source,
    selectedProject: project,
    host: hostname(),
    dockerAvailable: docker.available,
    disk,
    bars,
    sources,
    projects,
    assets: filtered.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)).slice(0, 320),
    events: readLedger(),
    schedule: config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" },
  };
  dashboardCache.set(cacheKey, { createdAt: Date.now(), value: dashboard });
  return dashboard;
}

export function createCleanupPreview({ source = "local", types = ["container", "image", "volume", "cache"] } = {}) {
  const dashboard = collectDashboard({ source });
  if (source !== "local" && !dashboard.remoteSnapshotAvailable) throw new Error(dashboard.remoteError || `${source} 快照不可用`);
  const allowlist = dashboard.assets.filter((asset) => {
    if (!types.includes(asset.type) || asset.classification !== "reclaimable") return false;
    if (source === "local" && asset.type !== "cache") return asset.labels?.[`${RUNTIME_PREFIX}disposable`] === "true";
    return asset.type === "cache";
  }).map((asset) => ({
    type: asset.type,
    id: asset.id,
    name: asset.name,
    project: asset.project,
    sizeBytes: asset.sizeBytes,
    reason: asset.reason,
    remoteKind: asset.remoteKind,
  }));
  if (source === "local" && types.includes("cache")) {
    const cache = dashboard.bars.find((item) => item.type === "cache");
    if (Number(cache?.reclaimableBytes || 0) > 0) {
      allowlist.push({
        type: "cache",
        id: "docker-build-cache",
        name: "Docker Build Cache",
        project: "docker-builder",
        sizeBytes: Number(cache.reclaimableBytes),
        reason: "Docker 明确认定为未使用且可回收的 Build Cache",
      });
    }
  }
  const token = randomUUID();
  const preview = {
    token,
    source,
    policy: source === "github"
      ? "只删除已过期制品、已关闭 PR 的缓存和超过 30 天未访问的缓存"
      : source === "local" ? "只删除显式 disposable 资产和 Docker 未使用的 Build Cache"
        : "只执行 Docker builder prune；镜像、卷、容器和 release 永不进入清单",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    allowlist,
    totalBytes: allowlist.reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0),
    protectedCount: dashboard.assets.filter((asset) => asset.classification === "protected").length,
  };
  previewStore.set(token, preview);
  return preview;
}

function appendCleanupEvent(event, details, environment = "local") {
  const ledger = process.env.RUNTIME_ASSET_LEDGER_FILE || join(stateRoot(), "events.jsonl");
  const item = {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    event,
    host: hostname(),
    project: "runtime-asset-tracker",
    environment,
    release: "dashboard",
    gitSha: "unknown",
    owner: "local-user",
    details,
  };
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify(item)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function executeCleanup({ token, confirmed = false }) {
  const preview = previewStore.get(token);
  if (!preview) throw new Error("Cleanup preview is missing or expired. Generate a new preview.");
  if (Date.parse(preview.expiresAt) < Date.now()) {
    previewStore.delete(token);
    throw new Error("Cleanup preview expired. Generate a new preview.");
  }
  if (!confirmed) throw new Error("Cleanup requires confirmation for the exact preview allowlist.");
  if (preview.source !== "local") {
    const config = loadConfig();
    const sourceConfig = (config.sources || []).find((item) => item.id === preview.source);
    const cleanup = executeRemoteCleanup({ source: preview.source, sourceConfig, allowlist: preview.allowlist });
    previewStore.delete(token);
    dashboardCache.clear();
    appendCleanupEvent("cleanup.remote.executed", {
      previewToken: token,
      source: preview.source,
      removed: String(cleanup.results.filter((item) => item.status === "removed").length),
      failed: String(cleanup.results.filter((item) => item.status === "failed").length),
    }, preview.source);
    return cleanup;
  }
  const results = [];
  for (const asset of preview.allowlist) {
    const args = asset.type === "container" ? ["container", "rm", asset.id]
      : asset.type === "image" ? ["image", "rm", asset.id]
        : asset.type === "volume" ? ["volume", "rm", asset.id]
          : asset.type === "cache" && asset.id === "docker-build-cache" ? ["builder", "prune", "--all", "--force"]
          : null;
    if (!args) continue;
    const output = run("docker", args, { timeout: 30_000 });
    results.push({ ...asset, status: output ? "removed" : "failed" });
  }
  previewStore.delete(token);
  dashboardCache.clear();
  appendCleanupEvent("cleanup.executed", { previewToken: token, removed: String(results.filter((item) => item.status === "removed").length), failed: String(results.filter((item) => item.status === "failed").length) });
  return { completedAt: new Date().toISOString(), results };
}
