import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { collectRemoteDashboard, executeRemoteCleanup, expiryClassification, resolveExpiry } from "./remote.mjs";
import { importRetirementReconciliation, retirementAttestations } from "./reconciliation.mjs";
import { discoverWorktreeAssets, executePathAssetCleanup, importPathRetirementReconciliation } from "./path-assets.mjs";
import { importUnifiedRetirementReconciliation } from "./lifecycle-reconciliation.mjs";
import { buildUnifiedAssetTable, loadGithubAuthority, writeUnifiedAssetTable } from "./lifecycle-table.mjs";

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

function classification({ labels = {}, active = false, dangling = false, knownProtected = false, assetType = "generic", createdAt, expiresAt, now = Date.now() }) {
  if (active) return "active";
  if (knownProtected || labelValue(labels, "retention") === "protected" || labelValue(labels, "disposable") === "false") return "protected";
  const expiry = expiryClassification(resolveExpiry({ labels, createdAt, expiresAt }), now);
  if (expiry === "expiring") return "expiring";
  if (expiry === "retained") return assetType === "volume" ? "review" : "retained";
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

export function localBuildCacheBar(summary = {}) {
  const cache = Object.entries(summary).find(([type]) => String(type).toLowerCase() === "build cache")?.[1] || {};
  const totalBytes = Number(cache.sizeBytes || 0);
  const reclaimableBytes = Math.min(totalBytes, Number(cache.reclaimableBytes || 0));
  return {
    type: "cache",
    totalBytes,
    count: Number(cache.totalCount || 0),
    activeBytes: 0,
    protectedBytes: 0,
    expiringBytes: 0,
    retainedBytes: Math.max(0, totalBytes - reclaimableBytes),
    reclaimableBytes,
    unit: "bytes",
  };
}

function dockerInventory() {
  const available = Boolean(run("docker", ["version", "--format", "{{.Server.Version}}"]));
  if (!available) return { available: false, assets: [], summary: {} };
  const retirementOverrides = readRetirementOverrides();

  const containerRows = jsonLines(run("docker", ["ps", "-a", "--size", "--no-trunc", "--format", "{{json .}}"]));
  const containerDetails = inspectMany("container", containerRows.map((item) => item.ID));
  const verboseSizes = parseVerboseDockerSizes();
  const runningImageIds = new Set(containerDetails.filter((item) => item.State?.Running).map((item) => item.Image));
  const referencedImageIds = new Set(containerDetails.map((item) => item.Image).filter(Boolean));
  const allMountedVolumes = new Set(containerDetails.flatMap((item) => (item.Mounts || []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name)));
  const activeMountedVolumes = new Set(containerDetails.filter((item) => item.State?.Running).flatMap((item) =>
    (item.Mounts || []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name)));
  const imageConsumers = new Map();
  const volumeConsumers = new Map();
  for (const item of containerDetails) {
    const consumer = { id: item.Id, name: String(item.Name || "").replace(/^\//, ""), state: item.State?.Status || "unknown" };
    if (item.Image) imageConsumers.set(item.Image, [...(imageConsumers.get(item.Image) || []), consumer]);
    for (const mount of item.Mounts || []) {
      if (mount.Type !== "volume" || !mount.Name) continue;
      volumeConsumers.set(mount.Name, [...(volumeConsumers.get(mount.Name) || []), { ...consumer, destination: mount.Destination }]);
    }
  }

  const containers = containerDetails.map((item) => {
    const labels = {
      ...safeLabels(item.Config?.Labels),
      ...(retirementOverrides.get(`container:${item.Id}`) || {}),
    };
    const active = Boolean(item.State?.Running);
    return {
      id: item.Id,
      name: String(item.Name || "").replace(/^\//, ""),
      type: "container",
      project: projectFrom(labels),
      environment: environmentFrom(labels),
      status: item.State?.Status || "unknown",
      classification: classification({ labels, active, createdAt: item.Created }),
      sizeBytes: parseBytes(containerRows.find((row) => row.ID === item.Id)?.Size),
      createdAt: item.Created,
      expiresAt: resolveExpiry({ labels, createdAt: item.Created }),
      labels,
      lineage: {
        imageId: item.Image,
        mounts: (item.Mounts || []).map((mount) => ({ type: mount.Type, name: mount.Name, destination: mount.Destination })),
      },
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
    const labels = {
      ...safeLabels(item?.Config?.Labels),
      ...(retirementOverrides.get(`image:${row.ID}`) || {}),
    };
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
      classification: classification({ labels, active: referenced, dangling, assetType: "image", createdAt: item?.Created || row.CreatedAt }),
      sizeBytes: [...verboseSizes.imageUniqueSizes.entries()].find(([shortId]) => String(row.ID).includes(shortId))?.[1] || 0,
      createdAt: item?.Created || row.CreatedAt,
      expiresAt: resolveExpiry({ labels, createdAt: item?.Created || row.CreatedAt }),
      labels,
      lineage: {
        consumers: imageConsumers.get(row.ID) || [],
        tags,
        revision: labels["org.opencontainers.image.revision"],
        source: labels["org.opencontainers.image.source"],
      },
      reason: running ? "被运行容器引用" : referenced ? "仍被已停止容器引用" : policyProtected ? "保留策略明确保护" : labelValue(labels, "disposable") === "true" ? "未被任何容器引用且明确可丢弃" : dangling ? "未被任何容器引用的悬空镜像" : "未引用但没有可丢弃标签",
    };
  });

  const volumeRows = jsonLines(run("docker", ["volume", "ls", "--format", "{{json .}}"]));
  const volumeDetails = inspectMany("volume", volumeRows.map((item) => item.Name));
  const volumeSizes = verboseSizes.volumeSizes;
  const protectedName = /(postgres|mysql|maria|redis|valkey|uploads?|media|assets?|database|db[-_]?data|backup)/i;
  const volumes = volumeDetails.map((item) => {
    const labels = {
      ...safeLabels(item.Labels),
      ...(retirementOverrides.get(`volume:${item.Name}`) || {}),
    };
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
      classification: classification({ labels, active: mounted, knownProtected, assetType: "volume", createdAt: item.CreatedAt }),
      sizeBytes: volumeSizes.get(item.Name) || 0,
      createdAt: item.CreatedAt,
      expiresAt: resolveExpiry({ labels, createdAt: item.CreatedAt }),
      labels,
      lineage: { consumers: volumeConsumers.get(item.Name) || [], mountpoint: item.Mountpoint },
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
      assetPrefixes: [...new Set((item.assetPrefixes || []).filter(Boolean).map(String))],
      gitRoots: [...new Set((item.gitRoots || []).filter(Boolean).map(String))],
      environments: (item.environments || []).filter((source) => source?.id && source?.kind),
    });
  }
  return [...unique.values()];
}

function publicProjectOptions(projects) {
  return [
    { id: "all", repository: "local-host", label: "All local projects", hostScope: true },
    ...projects.map(({ id, repository, label }) => ({ id, repository, label })),
  ];
}

export function resolveProjectId(value, projects, config) {
  if (value === "all") return "all";
  const requested = value ? canonicalProjectId(value, projects) : "";
  if (projects.some((item) => item.id === requested)) return requested;
  const legacyGithub = (config.sources || []).find((item) => item.kind === "github" || item.id === "github");
  const legacyProject = canonicalProjectId(legacyGithub?.repository, projects);
  if (projects.some((item) => item.id === legacyProject)) return legacyProject;
  return projects[0]?.id || "unknown";
}

export function projectSourceConfigs(config, project) {
  const projects = registeredProjects(config);
  const selectedProject = resolveProjectId(project, projects, config);
  if (selectedProject === "all") return [{ id: "local", kind: "local", projectId: "all" }];
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
    ...configuredEnvironments.map((source) => ({
      ...source,
      projectId: selectedProject,
      projectAliases: registered?.aliases || [],
      assetPrefixes: registered?.assetPrefixes || [],
    })),
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
  if (selectedProject === "all") {
    const diskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
    return [{
      id: "local",
      label: `Local ${diskRoot}`,
      kind: "local",
      status: dockerAvailable ? "connected" : "unavailable",
      detail: "All registered and legacy local projects",
    }];
  }
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

function compactProjectToken(value) {
  const normalizedRepository = normalizeGithubRepository(value);
  return String(normalizedRepository || value || "").split("/").at(-1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalProjectId(value, projects) {
  const normalizedRepository = normalizeGithubRepository(value);
  const key = String(normalizedRepository || value || "").toLowerCase();
  const match = projects.find((item) => [item.id, item.repository, item.label, ...item.aliases]
    .some((candidate) => String(candidate || "").toLowerCase() === key));
  if (match) return match.id;
  const compact = compactProjectToken(value);
  const prefixed = projects.flatMap((item) => [item.repository, item.label, ...item.aliases].map((candidate) => ({
    project: item,
    token: compactProjectToken(candidate),
  }))).filter((candidate) => candidate.token.length >= 4 && compact.startsWith(candidate.token))
    .sort((left, right) => right.token.length - left.token.length)[0];
  return prefixed?.project.id || value || "unknown";
}

function legacyWorktreeInventory(config, projects) {
  const roots = [...new Set([
    process.env.RUNTIME_ASSET_GIT_ROOT,
    ...(config.gitRoots || []),
    ...projects.flatMap((item) => item.gitRoots || []),
  ].filter(Boolean))];
  if (!roots.length) roots.push(process.cwd());
  const blocksByPath = new Map();
  for (const root of roots) {
    if (!existsSync(join(root, ".git"))) continue;
    const output = run("git", ["worktree", "list", "--porcelain"], { cwd: root });
    for (const block of output.split(/\r?\n\r?\n/).filter(Boolean)) {
      const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("worktree "));
      if (pathLine) blocksByPath.set(pathLine.slice("worktree ".length).toLowerCase(), block);
    }
  }
  return [...blocksByPath.values()].map((block, index) => {
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
      lineage: { primary: index === 0, dirty, detached: Boolean(fields.detached), gitSha: fields.HEAD, branch: typeof fields.branch === "string" ? fields.branch.replace("refs/heads/", "") : "detached", remote },
      reason: dirty ? "包含未提交内容" : fields.detached ? "干净 detached worktree，可审查" : "干净分支 worktree，未证明可删除",
    };
  });
}

function worktreeInventory(config, projects) {
  return discoverWorktreeAssets(config, projects, readRawLedgerEvents());
}

function readLedger(limit = 24) {
  return readRawLedgerEvents().slice(-limit).reverse().map((item) => ({
    id: item.eventId,
    occurredAt: item.occurredAt,
    event: item.event,
    project: item.project,
    environment: item.environment,
    assetType: item.asset?.type,
    assetId: item.asset?.id,
    status: item.status,
  }));
}

function readRawLedgerEvents(maxBytes = 8 * 1024 * 1024) {
  const ledger = process.env.RUNTIME_ASSET_LEDGER_FILE || join(stateRoot(), "events.jsonl");
  if (!existsSync(ledger)) return [];
  const stats = statSync(ledger);
  const length = Math.min(stats.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(ledger, "r");
  readSync(fd, buffer, 0, length, stats.size - length);
  closeSync(fd);
  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (stats.size > length) lines.shift();
  return lines.filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch { return []; }
  });
}

export function retirementOverrideLabels(events) {
  const overrides = new Map();
  for (const event of events || []) {
    const type = String(event?.asset?.type || "");
    const id = String(event?.asset?.id || "");
    if (!id || !["image", "container", "volume"].includes(type)) continue;
    const key = `${type}:${id}`;
    if (event.event === "asset.retirement.revoked") {
      overrides.delete(key);
      continue;
    }
    if (event.event !== "asset.retired" || event.status !== "retired") continue;
    const details = event.details || {};
    const recoverySource = String(details.recoverySource || "").trim();
    const dataClassification = String(details.dataClassification || "").trim();
    const contentFingerprint = String(details.contentFingerprint || "").trim();
    const project = String(event.project || "").trim();
    const owner = String(event.owner || "").trim();
    if (String(details.disposable).toLowerCase() !== "true") continue;
    if (String(details.retention).toLowerCase() !== "retired") continue;
    if (!recoverySource || !project || project === "unknown" || !owner || owner === "unknown") continue;
    if (type === "volume" && (
      dataClassification !== "synthetic-test-fixture"
      || !/^sha256:[0-9a-f]{64}$/i.test(contentFingerprint)
    )) continue;
    const labels = {
      [`${RUNTIME_PREFIX}project`]: project,
      [`${RUNTIME_PREFIX}environment`]: String(event.environment || "local"),
      [`${RUNTIME_PREFIX}owner`]: owner,
      [`${RUNTIME_PREFIX}asset-kind`]: type,
      [`${RUNTIME_PREFIX}retention`]: "retired",
      [`${RUNTIME_PREFIX}disposable`]: "true",
      [`${RUNTIME_PREFIX}recovery-source`]: recoverySource,
    };
    if (event.release && event.release !== "unknown") labels[`${RUNTIME_PREFIX}release`] = String(event.release);
    if (event.gitSha && event.gitSha !== "unknown") labels[`${RUNTIME_PREFIX}git-sha`] = String(event.gitSha);
    if (type === "volume") {
      labels[`${RUNTIME_PREFIX}data-classification`] = dataClassification;
      labels[`${RUNTIME_PREFIX}content-fingerprint`] = contentFingerprint;
    }
    overrides.set(key, labels);
  }
  return overrides;
}

function readRetirementOverrides() {
  return retirementOverrideLabels(readRawLedgerEvents());
}

export function readRetirementGovernance(project, environment) {
  return retirementAttestations(readRawLedgerEvents(), { project, environment });
}

export function importReconciliation(input) {
  const result = importRetirementReconciliation(input);
  dashboardCache.clear();
  return result;
}

export function importPathReconciliation(input) {
  const result = importPathRetirementReconciliation(input);
  dashboardCache.clear();
  return result;
}

export function importUnifiedReconciliation(input) {
  const result = importUnifiedRetirementReconciliation(input);
  dashboardCache.clear();
  return result;
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
  const bytes = (asset) => Number(asset.accountedBytes ?? asset.sizeBytes ?? 0);
  const sum = (kind) => matching.filter((asset) => asset.classification === kind).reduce((total, asset) => total + bytes(asset), 0);
  const measured = matching.reduce((value, asset) => value + bytes(asset), 0);
  const total = ["worktree", "worktree_residual", "host_artifact"].includes(type) ? measured : Math.max(measured, Number(fallback.sizeBytes || 0));
  const activeBytes = sum("active");
  const protectedBytes = sum("protected");
  const expiringBytes = sum("expiring");
  const reclaimableBytes = sum("reclaimable");
  return {
    type,
    totalBytes: total,
    count: Number(fallback.totalCount ?? matching.length),
    activeBytes,
    protectedBytes,
    expiringBytes,
    retainedBytes: Math.max(0, total - activeBytes - protectedBytes - expiringBytes - reclaimableBytes),
    reclaimableBytes,
    unit: "bytes",
  };
}

export function collectDashboard({ scope = "project", source = "local", project = "all", includeAllAssets = false } = {}) {
  const config = loadConfig();
  const projects = registeredProjects(config);
  const selectedProject = resolveProjectId(project, projects, config);
  const sourceConfigs = projectSourceConfigs(config, selectedProject);
  const selectedSource = sourceConfigs.some((item) => item.id === source) ? source : "local";
  const cacheKey = `${selectedSource}:${selectedProject}:${includeAllAssets ? "full" : "bounded"}`;
  const cached = dashboardCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 20_000) return { ...cached.value, generatedAt: new Date().toISOString(), cached: true };
  const sources = projectSourceCards(config, projects, selectedProject, true);
  if (selectedSource !== "local") {
    const scopedConfig = { ...config, sources: sourceConfigs.filter((item) => item.id !== "local") };
    const dashboard = collectRemoteDashboard({ source: selectedSource, scope: "project", project: selectedProject, config: scopedConfig, sources, includeAllAssets });
    return applyRemoteRetirementGovernance(dashboard, readRetirementGovernance(selectedProject, selectedSource));
  }
  const docker = dockerInventory();
  const worktrees = worktreeInventory(config, projects);
  const allAssets = [...worktrees, ...docker.assets].map((asset) => ({ ...asset, project: canonicalProjectId(asset.project, projects) }));
  const hostScope = selectedProject === "all";
  const filtered = hostScope ? allAssets : allAssets.filter((asset) => asset.project === selectedProject);
  const diskRoot = process.env.RUNTIME_ASSET_DISK_ROOT || (platform() === "win32" ? "D:\\" : "/");
  let disk = { totalBytes: 0, freeBytes: 0 };
  try {
    const stats = statfsSync(diskRoot);
    disk = { totalBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch { /* disk metrics are optional */ }
  const bars = [
    aggregate("worktree", filtered),
    aggregate("worktree_residual", filtered),
    aggregate("host_artifact", filtered),
    aggregate("image", filtered),
    aggregate("volume", filtered),
    localBuildCacheBar(docker.summary),
  ];
  const dashboard = {
    generatedAt: new Date().toISOString(),
    scope: hostScope ? "host" : "project",
    hostScope,
    selectedSource,
    selectedProject,
    host: hostname(),
    dockerAvailable: docker.available,
    disk,
    bars,
    sources: projectSourceCards(config, projects, selectedProject, docker.available),
    projects: projects.map((item) => item.id),
    projectOptions: publicProjectOptions(projects),
    assets: filtered.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0)).slice(0, includeAllAssets ? undefined : 320),
    events: hostScope ? readLedger() : readLedger().filter((event) => canonicalProjectId(event.project, projects) === selectedProject),
    schedule: config.schedule || { enabled: false, cadence: "weekly", mode: "preview-only", day: "sunday", time: "03:00" },
  };
  dashboardCache.set(cacheKey, { createdAt: Date.now(), value: dashboard });
  return dashboard;
}

function normalizedTags(tags) {
  return [...new Set((tags || []).map(String).filter((tag) => tag && !tag.includes("<none>")))].sort();
}

export function createUnifiedAssetTable({ project, sources = ["local", "production", "staging"], authorityReportPath, outputPath, coolingHours = 24 } = {}) {
  const selectedSources = [...new Set(sources)].filter((source) => ["local", "production", "staging"].includes(source));
  if (!project || project === "all") throw new Error("A registered project is required for a unified asset table.");
  if (!selectedSources.length) throw new Error("At least one local, production, or staging source is required.");
  const dashboards = selectedSources.map((source) => ({
    source,
    dashboard: collectDashboard({ scope: "project", source, project, includeAllAssets: true }),
  }));
  const table = buildUnifiedAssetTable({
    project: resolveProjectId(project, registeredProjects(loadConfig()), loadConfig()),
    dashboards,
    githubAuthority: loadGithubAuthority(authorityReportPath),
    coolingHours: Math.max(1, Math.min(720, Number(coolingHours) || 24)),
  });
  const writtenTo = writeUnifiedAssetTable(table, outputPath);
  return writtenTo ? { ...table, writtenTo } : table;
}

export function applyRemoteRetirementGovernance(dashboard, governance) {
  if (!dashboard?.remoteSnapshotAvailable || dashboard.selectedSource === "github") return dashboard;
  const project = String(dashboard.selectedProject || "");
  const environment = String(dashboard.selectedSource || "");
  const assets = (dashboard.assets || []).map((asset) => {
    const key = `${asset.type}:${asset.id}`;
    const protection = governance?.protections?.get(key);
    const retirement = governance?.retirements?.get(key);
    const consumers = Array.isArray(asset.lineage?.consumers) ? asset.lineage.consumers : [];
    const referenced = consumers.length > 0;
    if (protection && protection.project === project && protection.environment === environment) {
      return {
        ...asset,
        classification: referenced ? "active" : "protected",
        retirementBlocked: true,
        lineage: { ...asset.lineage, protection },
        reason: referenced ? asset.reason : `Reconciliation protection: ${protection.reason}`,
      };
    }
    if (!retirement || retirement.project !== project || retirement.environment !== environment) return asset;
    if (asset.type === "container") {
      const expectedMounts = JSON.stringify(retirement.expectedMounts || []);
      const liveMounts = JSON.stringify((asset.lineage?.mounts || []).map((mount) => ({
        type: String(mount?.type || ""), name: String(mount?.name || ""), source: String(mount?.source || ""), destination: String(mount?.destination || ""),
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
      const identityMatches = asset.name === retirement.expectedName
        && asset.lineage?.imageId === retirement.expectedImageId
        && asset.lineage?.composeProject === retirement.expectedComposeProject
        && liveMounts === expectedMounts
        && retirement.preserveVolumes === true;
      if (!identityMatches) return { ...asset, classification: "retained", retirementBlocked: true, lineage: { ...asset.lineage, retirement }, reason: "Container retirement is blocked because its exact name, image, Compose project, mount set, or volume-preservation contract drifted." };
      return { ...asset, classification: "reclaimable", labels: { ...(asset.labels || {}), ...retirement.labels }, lineage: { ...asset.lineage, retirement }, reason: retirement.stopBeforeRemoval ? "Merged-PR container has exact retirement evidence; execution may stop it before removal and must preserve every volume." : "Stopped merged-PR container has exact retirement evidence and all volumes must be preserved." };
    }
    if (["host_artifact", "worktree"].includes(asset.type)) {
      const fingerprintMatches = String(asset.lineage?.fingerprint || "") === retirement.fingerprint;
      const rootMatches = String(asset.lineage?.managedRoot || "") === retirement.managedRoot;
      const sizeMatches = Number(asset.sizeBytes || 0) === Number(retirement.expectedSizeBytes || 0);
      if (consumers.length || !fingerprintMatches || !rootMatches || !sizeMatches) return { ...asset, classification: consumers.length ? "active" : "retained", retirementBlocked: true, lineage: { ...asset.lineage, retirement }, reason: consumers.length ? "Remote path retirement is blocked by a live or stopped container bind mount." : "Remote path retirement is blocked because its managed root, byte count, or metadata fingerprint drifted." };
      return { ...asset, classification: "reclaimable", labels: { ...(asset.labels || {}), ...retirement.labels }, lineage: { ...asset.lineage, retirement }, reason: "Merged-PR remote path has exact retirement evidence, zero bind-mount consumers, matching bytes, and matching metadata fingerprint." };
    }
    if (asset.type === "volume") {
      if (consumers.length || Number(retirement.expectedReferences) !== 0 || Number(asset.sizeBytes || 0) !== Number(retirement.expectedSizeBytes || 0)) return { ...asset, classification: consumers.length ? "active" : "review", retirementBlocked: true, lineage: { ...asset.lineage, retirement }, reason: "Volume retirement is blocked because references or expected bytes drifted." };
      return { ...asset, classification: "reclaimable", labels: { ...(asset.labels || {}), ...retirement.labels }, lineage: { ...asset.lineage, retirement }, reason: "Exact retirement evidence confirms zero references and matching bytes; recovery evidence remains bound." };
    }
    if (asset.type !== "image") return asset;
    const liveTags = normalizedTags(asset.lineage?.tags);
    const approvedTags = normalizedTags(retirement.approvedTags);
    const tagSetMatches = liveTags.length === approvedTags.length && liveTags.every((tag, index) => tag === approvedTags[index]);
    const revision = String(asset.lineage?.revision || asset.labels?.[`${RUNTIME_PREFIX}git-sha`] || "").toLowerCase();
    const revisionMatches = revision === retirement.revision;
    if (referenced) {
      return {
        ...asset,
        classification: "active",
        retirementBlocked: true,
        lineage: { ...asset.lineage, retirement },
        reason: "Retirement is blocked because a running or stopped container still references the image.",
      };
    }
    if (!tagSetMatches || !revisionMatches) {
      return {
        ...asset,
        classification: "retained",
        retirementBlocked: true,
        lineage: { ...asset.lineage, retirement, liveTags, approvedTags },
        reason: !tagSetMatches ? "Retirement is blocked because the exact image tag set drifted." : "Retirement is blocked because the Git revision drifted.",
      };
    }
    return {
      ...asset,
      classification: "reclaimable",
      labels: { ...(asset.labels || {}), ...retirement.labels },
      lineage: { ...asset.lineage, retirement },
      reason: "Exact remote retirement attestation, zero container references, matching revision, and matching atomic tag set.",
    };
  });
  const productionConsumers = assets.filter((asset) => asset.type === "image").flatMap((asset) => {
    const revision = String(asset.lineage?.revision || "").toLowerCase();
    return (asset.lineage?.consumers || []).filter((consumer) => /^sparkling-cms-prod-(?:api|web)-/i.test(String(consumer.name || "")) && consumer.state === "running")
      .map((consumer) => ({ imageId: asset.id, imageRevision: revision, consumer: consumer.name }));
  });
  const releaseRevision = String(dashboard.revision || "").toLowerCase();
  const mismatches = releaseRevision ? productionConsumers.filter((item) => item.imageRevision && item.imageRevision !== releaseRevision) : [];
  const protections = [...(governance?.protections?.values?.() || [])];
  const matchingReportProtections = mismatches.length > 0 && mismatches.every((item) => {
    const current = governance?.protections?.get(`image:${item.imageId}`);
    if (!current || current.project !== project || current.environment !== environment) return false;
    return protections.some((candidate) => candidate.project === project && candidate.environment === environment && candidate.revision === releaseRevision && candidate.reportSha256 === current.reportSha256);
  });
  const releaseRuntimeDrift = mismatches.length ? {
    detected: true,
    releaseRevision,
    mismatches,
    acknowledgedByProtectionReport: matchingReportProtections,
    cleanupBlocked: !matchingReportProtections,
  } : { detected: false, releaseRevision, mismatches: [], acknowledgedByProtectionReport: false, cleanupBlocked: false };
  return {
    ...dashboard,
    assets,
    bars: rebuildAnalyzedBars(dashboard.bars, assets),
    releaseRuntimeDrift,
  };
}

function rebuildAnalyzedBars(bars, assets) {
  return (bars || []).map((bar) => {
    const matching = assets.filter((asset) => asset.type === bar.type);
    const measure = (asset) => bar.unit === "count" ? 1 : Number(asset.accountedBytes ?? asset.sizeBytes ?? 0);
    const sum = (classification) => matching.filter((asset) => asset.classification === classification).reduce((total, asset) => total + measure(asset), 0);
    const activeBytes = sum("active");
    const protectedBytes = sum("protected");
    const expiringBytes = sum("expiring");
    const reclaimableBytes = Math.max(sum("reclaimable"), bar.type === "cache" ? Number(bar.reclaimableBytes || 0) : 0);
    const totalBytes = Math.max(Number(bar.totalBytes || 0), matching.reduce((total, asset) => total + measure(asset), 0));
    return {
      ...bar,
      activeBytes,
      protectedBytes,
      expiringBytes,
      retainedBytes: Math.max(0, totalBytes - activeBytes - protectedBytes - expiringBytes - reclaimableBytes),
      reclaimableBytes,
    };
  });
}

function lineageFinding(asset, dashboard) {
  const labels = asset.labels || {};
  const lineage = asset.lineage || {};
  const consumers = Array.isArray(lineage.consumers) ? lineage.consumers : [];
  const owner = labelValue(labels, "owner");
  const recoverySource = labelValue(labels, "recovery-source") || lineage.source || lineage.remote || (asset.type === "cache" ? "可由构建重新生成" : undefined);
  const revision = labelValue(labels, "git-sha") || lineage.revision || asset.gitSha;
  const release = labelValue(labels, "release");
  const retention = labelValue(labels, "retention");
  const matchingEvents = (dashboard.events || []).filter((event) => String(event.assetId || "") === String(asset.id || ""));
  const evidence = [
    owner && `归属：${owner}`,
    consumers.length > 0 ? `消费者：${consumers.length} 个` : lineage.consumers ? "消费者：0 个" : undefined,
    revision && `版本：${String(revision).slice(0, 12)}`,
    release && `Release：${release}`,
    retention && `保留策略：${retention}`,
    asset.expiresAt && `到期：${asset.expiresAt}`,
    recoverySource && `恢复来源：${recoverySource}`,
    matchingEvents.length > 0 && `事件账本：${matchingEvents.length} 条`,
  ].filter(Boolean);
  const missing = [];
  if (!owner && !["pull_request", "artifact", "actions_cache", "workflow_run", "cache", "worktree", "worktree_residual", "host_artifact"].includes(asset.type)) missing.push("owner");
  if (!recoverySource && !["container", "pull_request", "workflow_run"].includes(asset.type)) missing.push("恢复来源");
  if (!["active", "protected", "reclaimable"].includes(asset.classification) && !asset.expiresAt) missing.push("到期时间/TTL");
  if (["image", "volume"].includes(asset.type) && !Array.isArray(lineage.consumers)) missing.push("消费者关系");
  const suggestedLabels = [];
  if (missing.includes("owner")) suggestedLabels.push("com.codex.runtime.owner");
  if (missing.includes("恢复来源")) suggestedLabels.push("com.codex.runtime.recovery-source");
  if (missing.includes("到期时间/TTL")) suggestedLabels.push("com.codex.runtime.expires-at 或 ttl-days");
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    classification: asset.classification,
    sizeBytes: Number(asset.sizeBytes || 0),
    expiresAt: asset.expiresAt,
    reason: asset.reason,
    consumerCount: consumers.length,
    evidence,
    missing,
    suggestedLabels,
  };
}

export function detectSupersededBuildChains(assets) {
  const families = new Map();
  for (const asset of assets || []) {
    if (asset.type !== "image" || (asset.lineage?.consumers || []).length > 0) continue;
    const revision = String(asset.lineage?.revision || asset.labels?.[`${RUNTIME_PREFIX}git-sha`] || "").toLowerCase();
    const tags = normalizedTags(asset.lineage?.tags);
    const service = tags.some((tag) => /(?:^|[-_:])ocr(?:[-_:]|$)/i.test(tag)) ? "ocr"
      : tags.some((tag) => /(?:^|[-_:])ai[-_]?worker(?:[-_:]|$)/i.test(tag)) ? "ai-worker"
        : tags.some((tag) => /(?:^|[-_:])transcode[-_]?worker(?:[-_:]|$)/i.test(tag)) ? "transcode-worker"
          : tags.some((tag) => /(?:^|[-_:])amazon[-_]?service(?:[-_:]|$)/i.test(tag)) ? "amazon-service"
            : tags.some((tag) => /(?:^|[-_:])web(?:[-_:]|$)/i.test(tag)) ? "web"
              : tags.some((tag) => /(?:^|[-_:])(?:api|migrate)(?:[-_:]|$)/i.test(tag)) ? "api"
                : tags.some((tag) => /(?:^|[-_:])worker(?:[-_:]|$)/i.test(tag)) ? "worker" : "other";
    const attestedGroup = asset.lineage?.retirement?.group;
    const protectedSignal = tags.some((tag) => /(?:^|[-_:])(?:recovery|rollback|restore|backup)(?:[-_:]|$)/i.test(tag));
    if (!attestedGroup && protectedSignal) continue;
    const semanticSignals = ["audit", "candidate", "preview", "retry", "smoke", "latest", "staging", "production", "prod"]
      .filter((signal) => tags.some((tag) => new RegExp(`(?:^|[-_:])${signal}(?:[-_:]|$)`, "i").test(tag)));
    if (service === "other" && !String(asset.project || "").includes("/") && semanticSignals.length === 0) continue;
    const projectFamily = String(asset.project || "unknown").split("/").at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const family = `${projectFamily}-${service}`;
    const taggedTimes = tags.flatMap((tag) => {
      const match = tag.match(/(20\d{6})t(\d{4,6})z/i);
      if (!match) return [];
      const time = match[2].padEnd(6, "0");
      return [Date.parse(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`)];
    }).filter(Number.isFinite);
    const effectiveBuildAt = taggedTimes.length ? Math.max(...taggedTimes) : Date.parse(asset.createdAt || 0);
    const groupKey = attestedGroup ? `attested:${attestedGroup}` : `continuous:${family}`;
    const key = `${asset.project}\0${service}\0${groupKey}`;
    families.set(key, [...(families.get(key) || []), {
      id: asset.id,
      revision: /^[0-9a-f]{40}$/.test(revision) ? revision : "unknown",
      tags,
      createdAt: asset.createdAt,
      effectiveBuildAt: Number.isFinite(effectiveBuildAt) ? new Date(effectiveBuildAt).toISOString() : asset.createdAt,
      sizeBytes: Number(asset.sizeBytes || 0),
      classification: asset.classification,
      semanticSignals,
    }]);
  }
  const chains = [];
  for (const [key, images] of families.entries()) {
    const [project, service, groupKey] = key.split("\0");
    const ordered = images.sort((left, right) => Date.parse(right.effectiveBuildAt || 0) - Date.parse(left.effectiveBuildAt || 0)
      || right.tags.join("\0").localeCompare(left.tags.join("\0")));
    const attested = groupKey.startsWith("attested:");
    const group = groupKey.replace(/^(?:attested|continuous):/, "");
    const windows = attested ? [ordered] : ordered.reduce((result, image) => {
      const current = result.at(-1);
      if (!current || Math.abs(Date.parse(current.at(-1).effectiveBuildAt || 0) - Date.parse(image.effectiveBuildAt || 0)) > 72 * 60 * 60_000) result.push([image]);
      else current.push(image);
      return result;
    }, []);
    for (const window of windows) {
      if (!attested && window.length < 2) continue;
      chains.push({
        project,
        service,
        group: attested ? group : `continuous-${group}`,
        imageCount: window.length,
        revisions: [...new Set(window.map((item) => item.revision))],
        semanticSignals: [...new Set(window.flatMap((item) => item.semanticSignals || []))],
        images: window,
        keepLatest: window[0],
        supersededCandidates: window.slice(1),
        requiresAncestryProof: !attested,
        decision: "review-only",
        status: window.length > 1 ? "superseded-build-chain" : "single-retired-build",
      });
    }
  }
  return chains
    .sort((left, right) => right.images.reduce((sum, item) => sum + item.sizeBytes, 0) - left.images.reduce((sum, item) => sum + item.sizeBytes, 0))
    .slice(0, 20);
}

export function runDeepScan({ source = "local", project = "all" } = {}) {
  const dashboard = collectDashboard({ source, project, includeAllAssets: true });
  if (dashboard.selectedSource !== "local" && !dashboard.remoteSnapshotAvailable) {
    throw new Error(dashboard.remoteError || `${dashboard.selectedSource} 快照不可用`);
  }
  const sourceAssets = [...dashboard.assets];
  const cacheBar = dashboard.bars.find((item) => item.type === "cache");
  if (Number(cacheBar?.reclaimableBytes || 0) > 0 && !sourceAssets.some((asset) => asset.type === "cache" && asset.id === "docker-build-cache")) {
    sourceAssets.push({
      id: "docker-build-cache",
      name: "Docker Build Cache",
      type: "cache",
      project: dashboard.selectedProject,
      environment: dashboard.selectedSource,
      status: "unused-build-cache",
      classification: "reclaimable",
      sizeBytes: Number(cacheBar.reclaimableBytes),
      labels: {},
      lineage: { consumers: [], recoverySource: "可由构建重新生成" },
      reason: "Docker 明确认定为未使用且可回收的 Build Cache",
    });
  }
  const before = new Map(sourceAssets.map((asset) => [`${asset.type}:${asset.id}`, asset.classification]));
  const assets = sourceAssets.map((asset) => {
    const expiry = expiryClassification(asset.expiresAt);
    const disposable = labelValue(asset.labels || {}, "disposable") === "true";
    const noConsumers = Array.isArray(asset.lineage?.consumers) && asset.lineage.consumers.length === 0;
    let classification = asset.classification;
    if (!["active", "protected"].includes(classification) && expiry === "expiring") classification = "expiring";
    if (!["active", "protected"].includes(classification) && expiry === "expired" && disposable && noConsumers && ["image", "volume"].includes(asset.type)) classification = "reclaimable";
    return { ...asset, classification };
  });
  const findings = assets.map((asset) => lineageFinding(asset, dashboard));
  const sum = (classification) => findings.filter((item) => item.classification === classification).reduce((total, item) => total + Number(item.sizeBytes || 0), 0);
  const newlyReclaimable = findings.filter((item) => item.classification === "reclaimable" && before.get(`${item.type}:${item.id}`) !== "reclaimable");
  const report = {
    generatedAt: new Date().toISOString(),
    project: dashboard.selectedProject,
    source: dashboard.selectedSource,
    host: dashboard.host,
    readOnly: true,
    scannedCount: findings.length,
    reclaimableBytes: sum("reclaimable"),
    expiringBytes: sum("expiring"),
    reviewBytes: findings.filter((item) => ["review", "retained"].includes(item.classification)).reduce((total, item) => total + Number(item.sizeBytes || 0), 0),
    protectedBytes: sum("protected") + sum("active"),
    newlyReclaimableBytes: newlyReclaimable.reduce((total, item) => total + Number(item.sizeBytes || 0), 0),
    newlyReclaimableCount: newlyReclaimable.length,
    expiringCount: findings.filter((item) => item.classification === "expiring").length,
    unresolvedCount: findings.filter((item) => item.missing.length > 0).length,
    supersededBuildChains: detectSupersededBuildChains(assets),
    findings: findings
      .filter((item) => item.classification === "expiring" || item.classification === "reclaimable" || item.missing.length > 0)
      .sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0))
      .slice(0, 80),
  };
  return {
    report,
    dashboard: {
      ...dashboard,
      generatedAt: report.generatedAt,
      assets,
      bars: rebuildAnalyzedBars(dashboard.bars, assets),
      lineageScan: { generatedAt: report.generatedAt, scannedCount: report.scannedCount, unresolvedCount: report.unresolvedCount },
    },
  };
}

export function cleanupSourceSupportsType(source, type) {
  if (source === "github") return ["artifact", "actions_cache"].includes(type);
  if (source === "local") return ["container", "image", "volume", "cache", "worktree", "worktree_residual", "host_artifact"].includes(type);
  return ["container", "image", "volume", "cache", "worktree", "host_artifact"].includes(type);
}

export function createCleanupPreview({ source = "local", project = "all", types = ["container", "image", "volume", "cache", "worktree", "worktree_residual", "host_artifact", "artifact", "actions_cache"], assetIds } = {}) {
  const dashboard = collectDashboard({ source, project, includeAllAssets: true });
  const selectedSource = dashboard.selectedSource || source;
  if (dashboard.releaseRuntimeDrift?.cleanupBlocked) throw new Error("Cleanup is blocked by an unacknowledged release/runtime image revision drift.");
  const requestedIds = Array.isArray(assetIds) && assetIds.length ? new Set(assetIds.map(String)) : null;
  if (dashboard.selectedProject === "all" && !requestedIds) throw new Error("Host-wide cleanup preview requires exact assetIds; broad all-project cleanup is not allowed.");
  if (selectedSource !== "local" && !dashboard.remoteSnapshotAvailable) throw new Error(dashboard.remoteError || `${selectedSource} 快照不可用`);
  const allowlist = dashboard.assets.filter((asset) => {
    if (!types.includes(asset.type) || asset.classification !== "reclaimable") return false;
    if (requestedIds && !requestedIds.has(String(asset.id))) return false;
    if (selectedSource === "local" && asset.type === "container") return asset.labels?.[`${RUNTIME_PREFIX}disposable`] === "true";
    return cleanupSourceSupportsType(selectedSource, asset.type);
  }).map((asset) => ({
    type: asset.type,
    id: asset.id,
    name: asset.name,
    project: asset.project,
    sizeBytes: asset.sizeBytes,
    reason: asset.reason,
    recoverySource: labelValue(asset.labels || {}, "recovery-source") || asset.lineage?.source || asset.lineage?.remote,
    tags: asset.type === "image" ? normalizedTags(asset.lineage?.tags) : undefined,
    revision: asset.type === "image" ? asset.lineage?.revision : undefined,
    retirementEvidence: asset.lineage?.retirement ? {
      reportSha256: asset.lineage.retirement.reportSha256,
      group: asset.lineage.retirement.group,
      approvedTags: normalizedTags(asset.lineage.retirement.approvedTags),
      revision: asset.lineage.retirement.revision,
      assetType: asset.lineage.retirement.assetType,
      expectedSizeBytes: asset.lineage.retirement.expectedSizeBytes,
      expectedName: asset.lineage.retirement.expectedName,
      expectedState: asset.lineage.retirement.expectedState,
      expectedImageId: asset.lineage.retirement.expectedImageId,
      expectedComposeProject: asset.lineage.retirement.expectedComposeProject,
      expectedMounts: asset.lineage.retirement.expectedMounts,
      preserveVolumes: asset.lineage.retirement.preserveVolumes,
      stopBeforeRemoval: asset.lineage.retirement.stopBeforeRemoval,
      managedRoot: asset.lineage.retirement.managedRoot,
      fingerprint: asset.lineage.retirement.fingerprint,
      expectedReferences: asset.lineage.retirement.expectedReferences,
      lifecycle: asset.lineage.retirement.lifecycle,
    } : undefined,
    remoteKind: asset.remoteKind,
  }));
  if (requestedIds) {
    const selectedIds = new Set(allowlist.map((asset) => String(asset.id)));
    const missingIds = [...requestedIds].filter((id) => !selectedIds.has(id));
    if (missingIds.length) throw new Error(`Exact cleanup scope contains ${missingIds.length} asset(s) that are no longer safely reclaimable.`);
  }
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
    releaseRuntimeDrift: dashboard.releaseRuntimeDrift,
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

export function localCleanupArgs(asset) {
  if (asset.type === "container") return ["container", "rm", asset.id];
  if (asset.type === "image") {
    const tags = [...new Set((asset.lineage?.tags || []).filter((tag) => tag && !tag.startsWith("<none>")))];
    return ["image", "rm", ...(tags.length > 0 ? tags : [asset.id])];
  }
  if (asset.type === "volume") return ["volume", "rm", asset.id];
  if (asset.type === "cache" && asset.id === "docker-build-cache") return ["builder", "prune", "--all", "--force"];
  return null;
}

export function localCleanupTimeoutMs(asset) {
  return asset?.type === "cache" && asset?.id === "docker-build-cache" ? 15 * 60_000 : 30_000;
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
  const current = collectDashboard({ source: "local", project: preview.project, includeAllAssets: true });
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
    if (["worktree", "worktree_residual", "host_artifact"].includes(asset.type)) {
      try {
        executePathAssetCleanup(asset);
        results.push({ ...requested, sizeBytes: asset.sizeBytes, status: "removed", reclaimedBytes: Number(asset.sizeBytes || 0) });
      } catch (error) {
        results.push({ ...requested, sizeBytes: asset.sizeBytes, status: "failed", reclaimedBytes: 0, reason: error.message });
      }
      continue;
    }
    const args = localCleanupArgs(asset);
    if (!args) continue;
    if (asset.type === "image" && args.length > 3) {
      const currentTags = args.slice(2);
      const tagDrift = currentTags.some((tag) => run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { timeout: 10_000 }) !== asset.id);
      if (tagDrift) {
        results.push({ ...requested, status: "skipped", reclaimedBytes: 0, reason: "执行前发现镜像 tag 与已批准 image ID 不再一致" });
        continue;
      }
    }
    const output = run("docker", args, { timeout: localCleanupTimeoutMs(asset) });
    results.push({
      ...requested,
      sizeBytes: asset.sizeBytes,
      removedReferences: asset.type === "image" ? args.slice(2) : undefined,
      status: output ? "removed" : "failed",
      reclaimedBytes: output ? Number(asset.sizeBytes || 0) : 0,
    });
  }
  previewStore.delete(token);
  dashboardCache.clear();
  appendCleanupEvent("cleanup.executed", { previewToken: token, removed: String(results.filter((item) => item.status === "removed").length), failed: String(results.filter((item) => item.status === "failed").length) });
  return { completedAt: new Date().toISOString(), results };
}
