import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const RECONCILIATION_SCHEMA = "sparkling.runtime-image-retirement-reconciliation/v1";
const RUNTIME_PREFIX = "com.codex.runtime.";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const REPORT_SHA = /^[0-9a-f]{64}$/i;

function defaultStateRoot() {
  if (process.env.RUNTIME_ASSET_STATE_DIR) return resolve(process.env.RUNTIME_ASSET_STATE_DIR);
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RuntimeAssetTracker");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "runtime-asset-tracker");
}

function stableStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))].sort();
}

function readJson(path) {
  const raw = readFileSync(path);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error("Reconciliation JSON must not contain a UTF-8 BOM.");
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}

function existingLedgerEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function reportProtectionIds(report) {
  return new Set([
    ...(report.neverDelete?.currentProduction || []).map((item) => item.id),
    ...(report.neverDelete?.activeVerificationAndPreviewImageIds || []),
    ...(report.rollbackKeep || []).map((item) => item.id),
  ].filter(Boolean));
}

export function validateRetirementReconciliation(report, { project, source, instanceId, groups } = {}) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, errors: ["Report must be an object."] };
  if (report.schemaVersion !== RECONCILIATION_SCHEMA) errors.push("Unsupported reconciliation schema.");
  if (report.readOnly !== true || report.actionTaken !== "none") errors.push("Only a read-only, non-executed reconciliation report can be imported.");
  if (project && report.target?.project !== project) errors.push("Report project does not match the selected project.");
  if (source && !["local", "production", "staging"].includes(source)) errors.push("Retirement imports are limited to local, production, or staging.");
  if (instanceId && report.target?.instanceId !== instanceId) errors.push("Report instance does not match the registered environment.");
  const selectedGroups = stableStrings(groups);
  if (selectedGroups.length === 0) errors.push("At least one exact candidate group is required.");
  const available = new Map((report.candidateGroups || []).map((group) => [String(group.group), group]));
  const protectedIds = reportProtectionIds(report);
  const seen = new Set();
  let imageCount = 0;
  let uniqueBytes = 0;
  for (const name of selectedGroups) {
    const group = available.get(name);
    if (!group) {
      errors.push(`Unknown reconciliation group: ${name}.`);
      continue;
    }
    if (!String(group.confidence || "").startsWith("high")) errors.push(`Group ${name} is not high confidence.`);
    if (!Array.isArray(group.images) || group.images.length !== group.imageCount) errors.push(`Group ${name} image count is inconsistent.`);
    let groupBytes = 0;
    for (const image of group.images || []) {
      imageCount += 1;
      groupBytes += Number(image.uniqueBytes || 0);
      uniqueBytes += Number(image.uniqueBytes || 0);
      if (!IMAGE_ID.test(String(image.id || ""))) errors.push(`Group ${name} contains an invalid image ID.`);
      if (seen.has(image.id)) errors.push(`Image ${image.id} appears in more than one selected group.`);
      seen.add(image.id);
      if (protectedIds.has(image.id)) errors.push(`Protected image ${image.id} cannot be retired.`);
      if (!COMMIT.test(String(image.revision || ""))) errors.push(`Image ${image.id} lacks a full Git revision.`);
      if (source === "local" && !String(image.recoverySource || "").trim()) errors.push(`Local image ${image.id} lacks an explicit recovery source.`);
      if (!Array.isArray(image.tags) || image.tags.length === 0 || image.tags.some((tag) => !tag || String(tag).startsWith("<none>"))) errors.push(`Image ${image.id} lacks an exact tag set.`);
      if (stableStrings(image.tags).length !== image.tags.length) errors.push(`Image ${image.id} has duplicate tags.`);
      if (!Number.isFinite(Number(image.uniqueBytes)) || Number(image.uniqueBytes) < 0) errors.push(`Image ${image.id} has an invalid unique byte count.`);
    }
    if (groupBytes !== Number(group.uniqueBytes)) errors.push(`Group ${name} unique byte total is inconsistent.`);
  }
  return { ok: errors.length === 0, errors, selectedGroups, imageCount, uniqueBytes, protectedIds: [...protectedIds] };
}

export function retirementAttestations(events) {
  const retirements = new Map();
  const protections = new Map();
  for (const event of events || []) {
    const type = String(event?.asset?.type || "");
    const id = String(event?.asset?.id || "");
    if (type !== "image" || !IMAGE_ID.test(id)) continue;
    const key = `image:${id}`;
    if (event.event === "asset.retirement.revoked") {
      retirements.delete(key);
      continue;
    }
    if (event.event === "asset.protection.bound" && event.status === "protected") {
      protections.set(key, {
        project: String(event.project || ""),
        environment: String(event.environment || ""),
        revision: COMMIT.test(String(event.gitSha || "")) ? String(event.gitSha).toLowerCase() : undefined,
        reportSha256: String(event.details?.reportSha256 || ""),
        reason: String(event.details?.reason || "reconciliation-protected"),
      });
      retirements.delete(key);
      continue;
    }
    if (event.event !== "asset.retired" || event.status !== "retired") continue;
    const details = event.details || {};
    const approvedTags = stableStrings(details.approvedTags);
    const reportSha256 = String(details.reportSha256 || "").toLowerCase();
    const revision = String(event.gitSha || "").toLowerCase();
    const project = String(event.project || "");
    const environment = String(event.environment || "");
    const owner = String(event.owner || "");
    const recoverySource = String(details.recoverySource || "");
    if (String(details.disposable).toLowerCase() !== "true" || String(details.retention).toLowerCase() !== "retired") continue;
    if (!approvedTags.length || !REPORT_SHA.test(reportSha256) || !COMMIT.test(revision) || !project || !environment || !owner || !recoverySource) continue;
    retirements.set(key, {
      project,
      environment,
      owner,
      release: String(event.release || "retired"),
      revision,
      approvedTags,
      expectedUniqueBytes: Number(details.expectedUniqueBytes || 0),
      reportSha256,
      group: String(details.group || ""),
      recoverySource,
      labels: {
        [`${RUNTIME_PREFIX}project`]: project,
        [`${RUNTIME_PREFIX}environment`]: environment,
        [`${RUNTIME_PREFIX}owner`]: owner,
        [`${RUNTIME_PREFIX}asset-kind`]: "image",
        [`${RUNTIME_PREFIX}retention`]: "retired",
        [`${RUNTIME_PREFIX}disposable`]: "true",
        [`${RUNTIME_PREFIX}recovery-source`]: recoverySource,
        [`${RUNTIME_PREFIX}git-sha`]: revision,
        [`${RUNTIME_PREFIX}release`]: String(event.release || "retired"),
        [`${RUNTIME_PREFIX}retirement-report-sha256`]: reportSha256,
        [`${RUNTIME_PREFIX}retirement-group`]: String(details.group || ""),
      },
    });
  }
  return { retirements, protections };
}

export function importRetirementReconciliation({ reportPath, source, project, groups, owner = "platform-engineering" } = {}) {
  if (!isAbsolute(String(reportPath || ""))) throw new Error("Reconciliation report path must be absolute.");
  const { raw, value: report } = readJson(reportPath);
  const stateDirectory = defaultStateRoot();
  const configPath = process.env.RUNTIME_ASSET_DASHBOARD_CONFIG || join(stateDirectory, "dashboard-config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { projects: [] };
  const registeredProject = (config.projects || []).find((item) => String(item.id || item.repository) === String(project));
  const environment = source === "local"
    ? { id: "local" }
    : registeredProject?.environments?.find((item) => item.id === source);
  if (!registeredProject || !environment) throw new Error("Selected project/environment is not registered in Tracker configuration.");
  const validation = validateRetirementReconciliation(report, { project, source, instanceId: environment.instanceId, groups });
  if (!validation.ok) throw new Error(`Reconciliation report is invalid: ${validation.errors.join("; ")}`);
  const reportSha256 = createHash("sha256").update(raw).digest("hex");
  const ledgerPath = process.env.RUNTIME_ASSET_LEDGER_FILE || join(stateDirectory, "events.jsonl");
  const existing = existingLedgerEvents(ledgerPath);
  const existingKeys = new Set(existing.filter((event) => event.event === "asset.retired").map((event) => `${event.asset?.id}\0${event.details?.reportSha256}\0${event.details?.group}`));
  const events = [];
  const selected = new Set(validation.selectedGroups);
  for (const group of report.candidateGroups || []) {
    if (!selected.has(group.group)) continue;
    for (const image of group.images) {
      const key = `${image.id}\0${reportSha256}\0${group.group}`;
      if (existingKeys.has(key)) continue;
      const recoverySource = String(image.recoverySource || `git:https://github.com/${project}.git@${image.revision}`).trim();
      events.push({
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        event: "asset.retired",
        host: hostname(),
        project,
        environment: source,
        release: `reconciled-${group.group}`,
        gitSha: image.revision,
        owner,
        asset: { type: "image", id: image.id, service: image.tags.some((tag) => /(?:^|[-_:])web(?:[-_:]|$)/i.test(tag)) ? "web" : "api" },
        status: "retired",
        details: {
          disposable: "true",
          retention: "retired",
          recoverySource: `${recoverySource}; report-sha256:${reportSha256}; group:${group.group}`,
          approvedTags: stableStrings(image.tags),
          expectedUniqueBytes: Number(image.uniqueBytes || 0),
          reportSha256,
          reportPath,
          group: group.group,
          confidence: group.confidence,
        },
      });
    }
  }
  const protections = [
    ...(report.neverDelete?.currentProduction || []).map((item) => ({ id: item.id, revision: item.revision, reason: "current-production" })),
    ...(report.neverDelete?.activeVerificationAndPreviewImageIds || []).map((id) => ({ id, reason: "active-verification-or-preview" })),
    ...(report.rollbackKeep || []).map((item) => ({ id: item.id, revision: item.revision, reason: item.reason || "rollback-keep" })),
  ];
  const protectedKeys = new Set(existing.filter((event) => event.event === "asset.protection.bound").map((event) => `${event.asset?.id}\0${event.details?.reportSha256}`));
  for (const item of protections) {
    if (!IMAGE_ID.test(String(item.id || "")) || protectedKeys.has(`${item.id}\0${reportSha256}`)) continue;
    events.push({
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      event: "asset.protection.bound",
      host: hostname(),
      project,
      environment: source,
      release: "reconciliation-protection",
      gitSha: COMMIT.test(String(item.revision || "")) ? String(item.revision).toLowerCase() : "unknown",
      owner,
      asset: { type: "image", id: item.id },
      status: "protected",
      details: { reportSha256, reportPath, reason: item.reason },
    });
  }
  if (events.length) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return {
    importedAt: new Date().toISOString(),
    reportPath,
    reportSha256,
    source,
    project,
    groups: validation.selectedGroups,
    candidateImageCount: validation.imageCount,
    candidateUniqueBytes: validation.uniqueBytes,
    retirementEventsAdded: events.filter((event) => event.event === "asset.retired").length,
    protectionEventsAdded: events.filter((event) => event.event === "asset.protection.bound").length,
    idempotentSkipCount: validation.imageCount - events.filter((event) => event.event === "asset.retired").length,
  };
}
