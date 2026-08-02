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
    key.startsWith(RUNTIME_PREFIX) || key.startsWith("com.docker.compose.") || ["org.opencontainers.image.revision", "org.opencontainers.image.source"].includes(key)));
}

function labelValue(labels, key) {
  return labels?.[`${RUNTIME_PREFIX}${key}`];
}

function classification({ labels = {}, active = false, dangling = false, knownProtected = false, assetType = "generic" }) {
  if (active) return "active";
  if (knownProtected || labelValue(labels, "retention") === "protected" || labelValue(labels, "disposable") === "false") return "protected";
  if (labelValue(labels, "disposable") === "true") return "reclaimable";
  if (assetType === "image" && dangling) return "reclaimable";
  if (assetType === "volume") return "review";
  return "retained";
}

function projectFrom(labels, fallback = "unknown") {
  return labelValue(labels, "project") || labels?.["com.docker.compose.project"] || fallback || "unknown";
}

function environmentFrom(labels) {
  return labelValue(labels, "environment") || "local";
}

function parseVerboseDockerSizes() {
  const output = run("docker", ["system", "df", "-v"], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  const imageMarker = "Images space usage:";
  const imageStart = output.indexOf(imageMarker);
  const imageSection = imageStart < 0 ? "" : output.slice(imageStart + imageMarker.length).split("Containers space usage:")[0];
  const imageUniqueSizes = new Map(imageSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1).flatMap((line) => {
    const parts = line.split(/\s{2,}/);
    return parts.length >= 8 ? [[parts[2], parseBytes(parts[6])]] : [];
  }));

  const volumeMarker = "Local Volumes space usage:";
  const volumeStart = output.indexOf(volumeMarker);
  const volumeSection = volumeStart < 0 ? "" : output.slice(volumeStart + volumeMarker.length).split("Build cache usage:")[0];
  const volumeSizes = new Map(volumeSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1).flatMap((line) => {
    const parts = line.split(/\s{2,}/);
    return parts.length >= 3 ? [[parts[0], parseBytes(parts[2])]] : [];
  }));
  return { imageUniqueSizes, volumeSizes };
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
  const verboseSizes = parseVerboseDockerSizes();
  const runningImageIds = new Set(containerDetails.filter((item) => item.State?.Running).map((item) => item.Image));
  const referencedImageIds = new Set(containerDetails.map((item) => item.Image).filter(Boolean));
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
  const consolidatedImages = new Map();
  for (const row of imageRows) {
    const existing = consolidatedImages.get(row.ID) || { ...row, tags: [] };
    const reference = `${row.Repository || "<none>"}:${row.Tag || "<none>"}`;
    if (!existing.tags.includes(reference)) existing.tags.push(reference);
    consolidatedImages.set(row.ID, existing);
  }
  const imageDetails = new Map(inspectMany("image", [...consolidatedImages.keys()]).map((item) => [item.Id, item]));
  const images = [...consolidatedImages.values()].map((row) => {
    const item = imageDetails.get(row.ID);
    const labels = safeLabels(item?.Config?.Labels);
    const tags = row.tags;
    const running = runningImageIds.has(row.ID);
    const referenced = referencedImageIds.has(row.ID);
    const dangling = tags.length === 0 || tags.every((tag) => tag.startsWith("<none>"));
    const policyProtected = labelValue(labels, "retention") === "protected" || labelValue(labels, "disposable") === "false";
    return {
      id: row.ID,
      name: tags[0] || row.ID.slice(7, 19),
      type: "image",
      project: projectFrom(labels, tags[0]?.split(/[/:]/)[0]),
      environment: environmentFrom(labels),
      status: running ? "in-use" : referenced ? "referenced-stopped" : dangling ? "dangling" : "unused",
      classification: classification({ labels, active: referenced, dangling, assetType: "image" }),
      sizeBytes: [...verboseSizes.imageUniqueSizes.entries()].find(([shortId]) => String(row.ID).includes(shortId))?.[1] || 0,
      createdAt: item?.Created || row.CreatedAt,
      labels,
      reason: running ? "被运行容器引用" : referenced ? "仍被已停止容器引用" : policyProtected ? "保留策略明确保护" : labelValue(labels, "disposable") === "true" ? "未被任何容器引用且明确可丢弃" : dangling ? "未被任何容器引用的悬空镜像" : "未引用但没有可丢弃标签",
    };
  });

  const volumeRows = jsonLines(run("docker", ["volume", "ls", "--format", "{{json .}}"]));
  const volumeDetails = inspectMany("volume", volumeRows.map((item) => item.Name));
  const volumeSizes = verboseSizes.volumeSizes;
  const protectedName = /(postgres|mysql|maria|redis|valkey|uploads?|media|assets?|database|db[-_]?data|backup)/i;
  const volumes = volumeDetails.map((item) => {
    const labels = safeLabels(item.Labels);
    const active = activeMountedVolumes.has(item.Name);
    const mounted = allMountedVolumes.has(item.Name);
    const knownProtected = protectedName.test(item.Name);
    const policyProtected = knownProtected || labelValue(labels, "retention") === "protected" || labelValue(labels, "disposable") === "false";
    return {
      id: item.Name,
      name: item.Name,
      type: "volume",
      project: projectFrom(labels, item.Labels?.["com.docker.compose.project"]),
      environment: environmentFrom(labels),
      status: active ? "mounted-running" : mounted ? "mounted-stopped" : "unmounted",
      classification: classification({ labels, active: mounted, knownProtected, assetType: "volume" }),
      sizeBytes: volumeSizes.get(item.Name) || 0,
      createdAt: item.CreatedAt,
      labels,
      reason: active ? "被运行容器挂载" : mounted ? "仍被已停止容器挂载" : policyProtected ? "名称或保留策略表明可能包含业务数据" : labelValue(labels, "disposable") === "true" ? "未被任何容器挂载且明确可丢弃" : "未证明可丢弃，等待确认",
    };
  });

  return { available: true, assets: [...containers, ...images, ...volumes], summary: dockerSummary() };
}

export function normalizeGithubRepository(value) {
  const text = String(value || "").trim().replace(/\\/g, "/").replace(/\.git$/i, "").replace(/\/$/, "");
  const match = text.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return match ? match[1] : (/^[^/]+\/[^/]+$/.test(text) ? text : "");
}

export function registeredProjects(config = loadConfig()) {
  const githubSource = (config.sources || []).find((item) => item.kind === "github" || item.id === "github");
  const configured = Array.isArray(config.projects) && config.projects.length
    ? config.projects
    : githubSource?.repository ? [{ id: githubSource.repository, repository: githubSource.repository }] : [];
  const unique = new Map();
  for (const item of configured) {
    const repository = normalizeGithubRepository(item.repository || item.id);
    if (!repository || unique.has(repository.toLowerCase())) continue;
    unique.set(repository.toLowerCase(), {
      id: repository,
      repository,
      label: String(item.label || repository.split("/").at(-1)),
      aliases: [...new Set([...(item.aliases || []), item.id, item.label, repository.split("/").at(-1)].filter(Boolean).map(String))],
      gitRoots: [...new Set((item.gitRoots || []).filter(Boolean).map(String))],
      environments: (item.environments || []).filter((source) => source?.id && source?.kind),
    });
  }
  return [...unique.values()];
}

function publicProjectOptions(projects) {
  return projects.map(({ id, repository, label }) => ({ id, repository, label }));
}

function resolveProjectId(value, projects, config) {
  const requested = value && value !== "all" ? canonicalProjectId(value, projects) : "";
  if (projects.some((item) => item.id === requested)) return requested;
  const legacyGithub = (config.sources || []).find((item) => item.kind === "github" || item.id === "github");
  const legacyProject = canonicalProjectId(legacyGithub?.repository, projects);
  if (projects.some((item) => item.id === legacyProject)) return legacyProject;
  return projects[0]?.id || "unknown";
}

export function projectSourceConfigs(config, project) {
  const projects = registeredProjects(config);
  const selectedProject = resolveProjectId(project, projects, config);
  const registered = projects.find((item) => item.id === selectedProject);
  const legacyGithub = (config.sources || []).find((item) => item.kind === "github" || item.id === "github");
  const legacyOwner = canonicalProjectId(legacyGithub?.repository, projects);
  const configuredEnvironments = registered?.environments?.length
    ? registered.environments
    : selectedProject === legacyOwner
      ? (config.sources || []).filter((item) => item.id !== "local" && item.id !== "github" && item.kind !== "github")
      : [];
  return [
    { id: "local", kind: "local" },
    ...configuredEnvironments.map((source) => ({ ...source, projectId: selectedProject })),
    { id: "github", kind: "github", repository: selectedProject },
  ];
}

function publicConnection(source) {
  if (!source || ["local", "github"].includes(source.kind)) return undefined;
  const credential = source.credentialRef || {};
  return {
    method: source.kind === "ssh" ? "SSH" : "AWS Systems Manager",
    profile: source.sshProfile || source.awsProfile || credential.profile || "未指定",
    credentialProvider: credential.provider || (source.kind === "ssh" ? "OpenSSH" : "AWS CLI"),
    credentialStatus: credential.status || (source.sshProfile || source.awsProfile ? "configured" : "unknown"),
    accountId: source.accountId || "待登记",
    iamPrincipal: source.iamPrincipal || "待登记",
    instanceId: source.instanceId || "待登记",
    region: source.region || "待登记",
    availabilityZone: source.availabilityZone || "待登记",
    host: source.publicHost || source.privateHost || "由连接配置解析",
    osUser: source.osUser || "由连接配置解析",
    appPath: source.activeLink || source.appPath || "待登记",
  };
}

function projectSourceCards(config, projects, selectedProject, dockerAvailable) {
  const project = projects.find((item) => item.id === selectedProject);
  const diskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
  return projectSourceConfigs(config, selectedProject).map((source) => {
    if (source.id === "local") {
      return { id: "local", label: `Local ${diskRoot}`, kind: "local", status: dockerAvailable ? "connected" : "unavailable", detail: project?.label || selectedProject };
    }
    if (source.id === "github") {
      return { id: "github", label: "GitHub", kind: "github", status: "configured", detail: project?.repository || selectedProject };
    }
    return {
      id: source.id,
      label: source.displayName || (source.id === "production" ? "EC2 Production" : source.id === "staging" ? "EC2 Staging" : source.label || source.id),
      kind: "server",
      status: source.credentialRef?.status === "missing" ? "error" : "configured",
      detail: source.label || project?.label || selectedProject,
      connection: publicConnection(source),
    };
  });
}

function canonicalProjectId(value, projects) {
  const normalizedRepository = normalizeGithubRepository(value);
  const key = String(normalizedRepository || value || "").toLowerCase();
  const match = projects.find((item) => [item.id, item.repository, item.label, ...item.aliases]
    .some((candidate) => String(candidate || "").toLowerCase() === key));
  return match?.id || value || "unknown";
}

function worktreeInventory(config, projects) {
  const roots = [...new Set([
    process.env.RUNTIME_ASSET_GIT_ROOT,
    ...(config.gitRoots || []),
    ...projects.flatMap((item) => item.gitRoots || []),
  ].filter(Boolean))];
  if (!roots.length) roots.push(process.cwd());
  const blocksByPath = new Map();
  for (const root of roots) {
    const output = run("git", ["worktree", "list", "--porcelain"], { cwd: root });
    for (const block of output.split(/\r?\n\r?\n/).filter(Boolean)) {
      const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("worktree "));
      if (pathLine) blocksByPath.set(pathLine.slice("worktree ".length).toLowerCase(), block);
    }
  }
  return [...blocksByPath.values()].map((block) => {
    const fields = Object.fromEntries(block.split(/\r?\n/).map((line) => {
      const space = line.indexOf(" ");
      return space > 0 ? [line.slice(0, space), line.slice(space + 1)] : [line, true];
    }));
    const path = fields.worktree;
    const status = path ? run("git", ["status", "--short"], { cwd: path, timeout: 8_000 }) : "";
    const remote = path ? normalizeGithubRepository(run("git", ["remote", "get-url", "origin"], { cwd: path, timeout: 8_000 })) : "";
    const rootProject = projects.find((item) => item.gitRoots.some((root) => path?.toLowerCase().startsWith(root.toLowerCase())));
    const dirty = Boolean(status);
    return {
      id: path,
      name: path ? parse(path).base : "unknown",
      path,
      type: "worktree",
      project: canonicalProjectId(remote || rootProject?.id, projects),
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
  const measured = matching.reduce((value, asset) => value + Number(asset.sizeBytes || 0), 0);
  const total = type === "worktree" ? measured : Math.max(measured, Number(fallback.sizeBytes || 0));
  const activeBytes = sum("active");
  const protectedBytes = sum("protected");
  const reclaimableBytes = sum("reclaimable");
  return {
    type,
    totalBytes: total,
    count: Number(fallback.totalCount ?? matching.length),
    activeBytes,
    protectedBytes,
    retainedBytes: Math.max(0, total - activeBytes - protectedBytes - reclaimableBytes),
    reclaimableBytes,
    unit: type === "worktree" ? "count" : "bytes",
  };
}

export function collectDashboard({ scope = "project", source = "local", project = "all" } = {}) {
  const config = loadConfig();
  const projects = registeredProjects(config);
  const selectedProject = resolveProjectId(project, projects, config);
  const sourceConfigs = projectSourceConfigs(config, selectedProject);
  const selectedSource = sourceConfigs.some((item) => item.id === source) ? source : "local";
  const cacheKey = `${selectedSource}:${selectedProject}`;
  const cached = dashboardCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 20_000) return { ...cached.value, generatedAt: new Date().toISOString(), cached: true };
  const sources = projectSourceCards(config, projects, selectedProject, true);
  if (selectedSource !== "local") {
    const scopedConfig = { ...config, sources: sourceConfigs.filter((item) => item.id !== "local") };
    return collectRemoteDashboard({ source: selectedSource, scope: "project", project: selectedProject, config: scopedConfig, sources });
  }
  const docker = dockerInventory();
  const worktrees = worktreeInventory(config, projects);
  const allAssets = [...worktrees, ...docker.assets].map((asset) => ({ ...asset, project: canonicalProjectId(asset.project, projects) }));
  const filtered = allAssets.filter((asset) => asset.project === selectedProject);
  const diskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
  let disk = { totalBytes: 0, freeBytes: 0 };
  try {
    const stats = statfsSync(diskRoot);
    disk = { totalBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch { /* disk metrics are optional */ }
  const bars = [
    aggregate("worktree", filtered),
    aggregate("image", filtered),
    aggregate("volume", filtered),
    {
      type: "cache",
      totalBytes: 0,
      count: 0,
      activeBytes: 0,
      protectedBytes: 0,
      retainedBytes: 0,
      reclaimableBytes: 0,
      unit: "bytes",
    },
  ];
  const dashboard = {
    generatedAt: new Date().toISOString(),
    scope: "project",
    selectedSource,
    selectedProject,
    host: hostname(),
    dockerAvailable: docker.available,
    disk,
    bars,
    sources: projectSourceCards(config, projects, selectedProject, docker.available),
    projects: projects.map((item) => item.id),
    projectOptions: publicProjectOptions(projects),
    assets: filtered.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)).slice(0, 320),
    events: readLedger().filter((event) => canonicalProjectId(event.project, projects) === selectedProject),
    schedule: config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" },
  };
  dashboardCache.set(cacheKey, { createdAt: Date.now(), value: dashboard });
  return dashboard;
}

export function createCleanupPreview({ source = "local", project = "all", types = ["container", "image", "volume", "cache", "artifact", "actions_cache"] } = {}) {
  const dashboard = collectDashboard({ source, project });
  const selectedSource = dashboard.selectedSource || source;
  if (selectedSource !== "local" && !dashboard.remoteSnapshotAvailable) throw new Error(dashboard.remoteError || `${selectedSource} 快照不可用`);
  const allowlist = dashboard.assets.filter((asset) => {
    if (!types.includes(asset.type) || asset.classification !== "reclaimable") return false;
    if (selectedSource === "local" && asset.type === "container") return asset.labels?.[`${RUNTIME_PREFIX}disposable`] === "true";
    return selectedSource === "github"
      ? ["artifact", "actions_cache"].includes(asset.type)
      : ["image", "volume", "cache"].includes(asset.type);
  }).map((asset) => ({
    type: asset.type,
    id: asset.id,
    name: asset.name,
    project: asset.project,
    sizeBytes: asset.sizeBytes,
    reason: asset.reason,
    remoteKind: asset.remoteKind,
  }));
  if (selectedSource === "local" && types.includes("cache")) {
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
    source: selectedSource,
    project: dashboard.selectedProject || project,
    policy: selectedSource === "github"
      ? "只删除已过期制品、已关闭 PR 的缓存和超过 30 天未访问的缓存"
      : selectedSource === "local" ? "只删除未被任何容器引用的悬空/显式 disposable 镜像、未挂载且显式 disposable 的卷，以及 Docker 未使用的 Build Cache"
        : "只删除复核后仍未被容器引用的悬空/显式 disposable 镜像、未挂载且显式 disposable 的卷，以及 Docker 未使用的 Build Cache；容器和 release 永不进入清单",
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
    const baseSourceConfig = projectSourceConfigs(config, preview.project).find((item) => item.id === preview.source);
    const sourceConfig = preview.source === "github" && preview.project && preview.project !== "all"
      ? { ...baseSourceConfig, repository: preview.project }
      : baseSourceConfig;
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
  dashboardCache.clear();
  const current = collectDashboard({ source: "local", project: preview.project });
  const safeAssets = new Map(current.assets.filter((item) => item.classification === "reclaimable").map((item) => [`${item.type}:${item.id}`, item]));
  const currentCache = current.bars.find((item) => item.type === "cache");
  if (Number(currentCache?.reclaimableBytes || 0) > 0) {
    safeAssets.set("cache:docker-build-cache", {
      type: "cache",
      id: "docker-build-cache",
      sizeBytes: Number(currentCache.reclaimableBytes),
      reason: "Docker 明确认定为未使用且可回收的 Build Cache",
    });
  }
  const results = [];
  for (const requested of preview.allowlist) {
    const asset = safeAssets.get(`${requested.type}:${requested.id}`);
    if (!asset) {
      results.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前复核不再满足安全清理条件" });
      continue;
    }
    const args = asset.type === "container" ? ["container", "rm", asset.id]
      : asset.type === "image" ? ["image", "rm", asset.id]
        : asset.type === "volume" ? ["volume", "rm", asset.id]
          : asset.type === "cache" && asset.id === "docker-build-cache" ? ["builder", "prune", "--all", "--force"]
          : null;
    if (!args) continue;
    const output = run("docker", args, { timeout: 30_000 });
    results.push({ ...requested, sizeBytes: asset.sizeBytes, status: output ? "removed" : "failed", reclaimedBytes: output ? Number(asset.sizeBytes || 0) : 0 });
  }
  previewStore.delete(token);
  dashboardCache.clear();
  appendCleanupEvent("cleanup.executed", { previewToken: token, removed: String(results.filter((item) => item.status === "removed").length), failed: String(results.filter((item) => item.status === "failed").length) });
  return { completedAt: new Date().toISOString(), results };
}
