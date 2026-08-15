import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const UNIFIED_RECONCILIATION_SCHEMA = "sparkling.runtime-unified-retirement-reconciliation/v1";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/i;
const CONTAINER_ID = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;
const REMOTE_PATH_TYPES = new Set(["host_artifact", "worktree"]);
const SUPPORTED_TYPES = new Set(["container", "image", "volume", ...REMOTE_PATH_TYPES]);

function stateRoot() {
  if (process.env.RUNTIME_ASSET_STATE_DIR) return resolve(process.env.RUNTIME_ASSET_STATE_DIR);
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RuntimeAssetTracker");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "runtime-asset-tracker");
}

function stableStrings(values) {
  return [...new Set((Array.isArray(values) ? values : values == null ? [] : [values]).map(String).filter(Boolean))].sort();
}

function readJson(path) {
  const raw = readFileSync(path);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error("Reconciliation JSON must not contain a UTF-8 BOM.");
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}

function existingEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function normalizedMounts(mounts) {
  return (mounts || []).map((mount) => ({
    type: String(mount?.type || ""),
    name: String(mount?.name || ""),
    source: String(mount?.source || ""),
    destination: String(mount?.destination || ""),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function pathInsideRoot(path, root) {
  const cleanPath = String(path || "").replace(/\/+$/, "");
  const cleanRoot = String(root || "").replace(/\/+$/, "");
  return cleanPath.startsWith("/") && cleanRoot.startsWith("/home/") && cleanPath !== cleanRoot && cleanPath.startsWith(`${cleanRoot}/`);
}

function validateAsset(asset, group, source, managedRoots, protectedKeys, seen, errors) {
  const type = String(asset?.type || "");
  const id = String(asset?.id || "");
  const key = `${type}:${id}`;
  if (!SUPPORTED_TYPES.has(type)) errors.push(`Group ${group} contains unsupported asset type ${type || "<empty>"}.`);
  if (!id) errors.push(`Group ${group} contains an asset without an exact ID.`);
  if (seen.has(key)) errors.push(`Asset ${key} appears in more than one selected group.`);
  seen.add(key);
  if (protectedKeys.has(key)) errors.push(`Protected asset ${key} cannot be retired.`);
  if (asset.disposable !== true || asset.retention !== "retired") errors.push(`Asset ${key} lacks disposable=true and retention=retired.`);
  if (!String(asset.recoverySource || "").trim()) errors.push(`Asset ${key} lacks an explicit recovery source.`);
  if (!Number.isFinite(Number(asset.sizeBytes)) || Number(asset.sizeBytes) < 0) errors.push(`Asset ${key} has an invalid byte count.`);

  if (type === "image") {
    if (!IMAGE_ID.test(id)) errors.push(`Image ${id} has an invalid image ID.`);
    if (!COMMIT.test(String(asset.revision || ""))) errors.push(`Image ${id} lacks a full Git revision.`);
    const tags = stableStrings(asset.tags);
    if (!tags.length || tags.some((tag) => tag.includes("<none>")) || tags.length !== (asset.tags || []).length) errors.push(`Image ${id} lacks a unique exact tag set.`);
  }
  if (type === "container") {
    if (!CONTAINER_ID.test(id)) errors.push(`Container ${id} has an invalid container ID.`);
    if (!String(asset.name || "").trim() || !IMAGE_ID.test(String(asset.imageId || ""))) errors.push(`Container ${id} lacks an exact name or image ID.`);
    if (!String(asset.composeProject || "").trim()) errors.push(`Container ${id} lacks an exact Compose project.`);
    if (!['running', 'exited', 'created', 'dead'].includes(String(asset.state || ""))) errors.push(`Container ${id} has an unsupported expected state.`);
    if (asset.preserveVolumes !== true) errors.push(`Container ${id} must preserve volumes.`);
    if (asset.state === "running" && asset.stopBeforeRemoval !== true) errors.push(`Running container ${id} requires stopBeforeRemoval=true.`);
    if (!Array.isArray(asset.mounts)) errors.push(`Container ${id} lacks an exact mount set.`);
  }
  if (type === "volume") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(id)) errors.push(`Volume ${id} has an invalid exact name.`);
    if (Number(asset.expectedReferences) !== 0) errors.push(`Volume ${id} must attest zero container references.`);
  }
  if (REMOTE_PATH_TYPES.has(type)) {
    if (source === "local") errors.push(`Use the local path reconciliation schema for ${id}.`);
    if (!pathInsideRoot(id, asset.managedRoot)) errors.push(`Remote path ${id} is outside its configured managed root.`);
    if (managedRoots.length && !managedRoots.includes(String(asset.managedRoot || "").replace(/\/+$/, ""))) errors.push(`Remote path ${id} uses a managed root that is not registered for the environment.`);
    if (!FINGERPRINT.test(String(asset.fingerprint || ""))) errors.push(`Remote path ${id} lacks an exact metadata fingerprint.`);
    if (Number(asset.expectedReferences) !== 0) errors.push(`Remote path ${id} must attest zero runtime references.`);
  }
}

export function validateUnifiedRetirementReconciliation(report, { project, source, instanceId, groups, managedRoots = [] } = {}) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, errors: ["Report must be an object."] };
  if (report.schemaVersion !== UNIFIED_RECONCILIATION_SCHEMA) errors.push("Unsupported unified reconciliation schema.");
  if (report.readOnly !== true || report.actionTaken !== "none") errors.push("Only a read-only, non-executed reconciliation report can be imported.");
  if (project && report.target?.project !== project) errors.push("Report project does not match the selected project.");
  if (source && report.target?.source !== source) errors.push("Report source does not match the selected environment.");
  if (source && !["local", "production", "staging"].includes(source)) errors.push("Unified retirement imports are limited to local, production, or staging.");
  if (instanceId && report.target?.instanceId !== instanceId) errors.push("Report instance does not match the registered environment.");
  const selectedGroups = stableStrings(groups);
  if (!selectedGroups.length) errors.push("At least one exact candidate group is required.");
  const available = new Map((report.candidateGroups || []).map((group) => [String(group.group), group]));
  const protectedKeys = new Set((report.protectedAssets || []).map((asset) => `${asset.type}:${asset.id}`));
  const seen = new Set();
  let assetCount = 0;
  let totalBytes = 0;
  for (const name of selectedGroups) {
    const group = available.get(name);
    if (!group) { errors.push(`Unknown reconciliation group: ${name}.`); continue; }
    if (!String(group.confidence || "").startsWith("high")) errors.push(`Group ${name} is not high confidence.`);
    const lifecycle = group.lifecycle || {};
    if (lifecycle.kind !== "pull_request" || lifecycle.state !== "MERGED" || !Number.isInteger(Number(lifecycle.number)) || Number(lifecycle.number) <= 0) errors.push(`Group ${name} lacks authoritative merged pull-request evidence.`);
    if (!Number.isFinite(Date.parse(String(lifecycle.mergedAt || "")))) errors.push(`Group ${name} lacks a valid merge timestamp.`);
    if (lifecycle.coolingComplete !== true) errors.push(`Group ${name} has not completed its cooling period.`);
    if (!Array.isArray(group.assets) || group.assets.length !== Number(group.assetCount)) errors.push(`Group ${name} asset count is inconsistent.`);
    let groupBytes = 0;
    for (const asset of group.assets || []) {
      assetCount += 1;
      groupBytes += Number(asset.sizeBytes || 0);
      totalBytes += Number(asset.sizeBytes || 0);
      validateAsset(asset, name, source, stableStrings(managedRoots).map((root) => root.replace(/\/+$/, "")), protectedKeys, seen, errors);
    }
    if (groupBytes !== Number(group.totalBytes)) errors.push(`Group ${name} byte total is inconsistent.`);
  }
  return { ok: errors.length === 0, errors, selectedGroups, assetCount, totalBytes, protectedKeys: [...protectedKeys] };
}

export function importUnifiedRetirementReconciliation({ reportPath, source, project, groups, owner = "platform-engineering" } = {}) {
  if (!isAbsolute(String(reportPath || ""))) throw new Error("Unified reconciliation report path must be absolute.");
  const { raw, value: report } = readJson(reportPath);
  const root = stateRoot();
  const configPath = process.env.RUNTIME_ASSET_DASHBOARD_CONFIG || join(root, "dashboard-config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { projects: [] };
  const registeredProject = (config.projects || []).find((item) => String(item.id || item.repository) === String(project));
  const environment = source === "local" ? { id: "local" } : registeredProject?.environments?.find((item) => item.id === source);
  if (!registeredProject || !environment) throw new Error("Selected project/environment is not registered in Tracker configuration.");
  const managedRoots = [
    ...(environment.managedPaths || []).map((item) => item.path),
    environment.releaseRoot,
  ].filter(Boolean);
  const validation = validateUnifiedRetirementReconciliation(report, { project, source, instanceId: environment.instanceId, groups, managedRoots });
  if (!validation.ok) throw new Error(`Unified reconciliation report is invalid: ${validation.errors.join("; ")}`);
  const reportSha256 = createHash("sha256").update(raw).digest("hex");
  const ledgerPath = process.env.RUNTIME_ASSET_LEDGER_FILE || join(root, "events.jsonl");
  const existing = existingEvents(ledgerPath);
  const existingKeys = new Set(existing.filter((event) => event.event === "asset.retired").map((event) => `${event.asset?.type}:${event.asset?.id}\0${event.details?.reportSha256}\0${event.details?.group}`));
  const selected = new Set(validation.selectedGroups);
  const events = [];
  for (const group of report.candidateGroups || []) {
    if (!selected.has(group.group)) continue;
    for (const asset of group.assets) {
      const key = `${asset.type}:${asset.id}\0${reportSha256}\0${group.group}`;
      if (existingKeys.has(key)) continue;
      events.push({
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        event: "asset.retired",
        host: hostname(),
        project,
        environment: source,
        release: `merged-pr-${group.lifecycle.number}`,
        gitSha: COMMIT.test(String(asset.revision || "")) ? String(asset.revision).toLowerCase() : "unknown",
        owner,
        asset: { type: asset.type, id: asset.id, service: String(asset.service || "") },
        status: "retired",
        details: {
          disposable: "true",
          retention: "retired",
          recoverySource: String(asset.recoverySource),
          reportSha256,
          reportPath,
          group: group.group,
          confidence: group.confidence,
          lifecycle: group.lifecycle,
          expectedSizeBytes: Number(asset.sizeBytes || 0),
          expectedName: asset.name,
          expectedState: asset.state,
          expectedImageId: asset.imageId,
          expectedComposeProject: asset.composeProject,
          expectedMounts: normalizedMounts(asset.mounts),
          preserveVolumes: asset.preserveVolumes === true,
          stopBeforeRemoval: asset.stopBeforeRemoval === true,
          approvedTags: stableStrings(asset.tags),
          revision: asset.revision,
          managedRoot: asset.managedRoot,
          fingerprint: asset.fingerprint,
          expectedReferences: Number(asset.expectedReferences || 0),
        },
      });
    }
  }
  if (events.length) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return {
    importedAt: new Date().toISOString(), reportPath, reportSha256, source, project,
    groups: validation.selectedGroups, candidateAssetCount: validation.assetCount,
    candidateBytes: validation.totalBytes, retirementEventsAdded: events.length,
    idempotentSkipCount: validation.assetCount - events.length,
  };
}
