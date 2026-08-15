const RUNTIME_PREFIX = "com.codex.runtime.";
const GIB = 1024 ** 3;

function runtimeLabel(asset, key) {
  return asset?.labels?.[`${RUNTIME_PREFIX}${key}`];
}

function normalizedTags(asset) {
  return [...new Set((asset?.lineage?.tags || []).map(String).filter((tag) => tag && !tag.includes("<none>")))].sort();
}

function consumerList(asset) {
  return Array.isArray(asset?.lineage?.consumers) ? asset.lineage.consumers : [];
}

function imageRevision(asset) {
  return String(asset?.lineage?.revision || runtimeLabel(asset, "git-sha") || "").trim().toLowerCase();
}

function protectedIdentity(asset) {
  const tags = normalizedTags(asset);
  const text = [asset?.name, ...tags, runtimeLabel(asset, "release"), runtimeLabel(asset, "retention")].filter(Boolean).join(" ").toLowerCase();
  return ["active", "protected"].includes(asset?.classification)
    || runtimeLabel(asset, "disposable") === "false"
    || /(?:^|[-_/:])(current|rollback|recovery|restore|backup|primary)(?:$|[-_/:])/.test(text);
}

function repositoryName(asset) {
  const tagged = normalizedTags(asset)[0] || String(asset?.name || "");
  const withoutDigest = tagged.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return repository.toLowerCase().replace(/[^a-z0-9./_-]+/g, "-") || "unknown-repository";
}

function serviceFamily(asset) {
  const tags = normalizedTags(asset);
  const text = [asset?.name, ...tags, runtimeLabel(asset, "service")].filter(Boolean).join(" ").toLowerCase();
  const service = /(?:^|[-_:])ocr(?:[-_:]|$)/.test(text) ? "ocr"
    : /(?:^|[-_:])ai[-_]?worker(?:[-_:]|$)/.test(text) ? "ai-worker"
      : /(?:^|[-_:])transcode[-_]?worker(?:[-_:]|$)/.test(text) ? "transcode-worker"
        : /(?:^|[-_:])amazon[-_]?service(?:[-_:]|$)/.test(text) ? "amazon-service"
          : /(?:^|[-_:])web(?:[-_:]|$)/.test(text) ? "web"
            : /(?:^|[-_:])(?:api|migrate)(?:[-_:]|$)/.test(text) ? "api"
              : /(?:^|[-_:])worker(?:[-_:]|$)/.test(text) ? "worker" : "other";
  const project = String(asset?.project || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${project}:${repositoryName(asset)}:${service}`;
}

function effectiveCreatedAt(asset) {
  const tagged = normalizedTags(asset).flatMap((tag) => {
    const match = tag.match(/(20\d{6})t(\d{4,6})z/i);
    if (!match) return [];
    const time = match[2].padEnd(6, "0");
    return [Date.parse(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`)];
  }).filter(Number.isFinite);
  const created = Date.parse(asset?.createdAt || 0);
  return tagged.length ? Math.max(...tagged) : created;
}

function recoverySource(asset) {
  const explicit = String(runtimeLabel(asset, "recovery-source") || asset?.lineage?.recoverySource || asset?.lineage?.source || "").trim();
  if (explicit) return explicit;
  const revision = imageRevision(asset);
  const project = String(asset?.project || "").trim();
  return /^[0-9a-f]{7,40}$/.test(revision) && project && project !== "unknown" ? `git:${project}@${revision}` : "";
}

function buildEvidence(events, project, environment) {
  const failed = new Set();
  const successful = new Set();
  for (const event of events || []) {
    if (project && project !== "all" && String(event?.project || "") !== project) continue;
    if (environment && String(event?.environment || "") !== environment) continue;
    const id = String(event?.asset?.id || event?.details?.imageId || "");
    if (!id) continue;
    if (event?.event === "build.failed") failed.add(id);
    if (["build.completed", "build.succeeded"].includes(event?.event)) successful.add(id);
  }
  return { failed, successful };
}

export function capacityPressure(disk = {}, policy = {}) {
  const totalBytes = Number(disk.totalBytes || 0);
  const freeBytes = Number(disk.freeBytes || 0);
  const freePercent = totalBytes > 0 ? freeBytes / totalBytes * 100 : null;
  const warningFreePercent = Number(policy.warningFreePercent ?? 15);
  const criticalFreePercent = Number(policy.criticalFreePercent ?? 8);
  const warningFreeBytes = Number(policy.warningFreeBytes ?? 50 * GIB);
  const criticalFreeBytes = Number(policy.criticalFreeBytes ?? 20 * GIB);
  const level = totalBytes <= 0 ? "unknown"
    : freePercent <= criticalFreePercent || freeBytes <= criticalFreeBytes ? "critical"
      : freePercent <= warningFreePercent || freeBytes <= warningFreeBytes ? "warning" : "normal";
  return { level, totalBytes, freeBytes, freePercent, warningFreePercent, criticalFreePercent, warningFreeBytes, criticalFreeBytes };
}

export function discoverRetirementCandidates(assets = [], {
  source = "local",
  project = "all",
  environment = source,
  disk = {},
  events = [],
  now = Date.now(),
  policy = {},
} = {}) {
  const coolingMs = Math.max(1, Number(policy.coolingHours ?? 24)) * 60 * 60_000;
  const orphanMs = Math.max(1, Number(policy.orphanAfterDays ?? 7)) * 24 * 60 * 60_000;
  const pressure = capacityPressure(disk, policy);
  const builds = buildEvidence(events, project, environment);
  const superseded = new Map();
  const imageFamilies = new Map();

  for (const asset of assets) {
    if (asset.type !== "image") continue;
    const key = serviceFamily(asset);
    imageFamilies.set(key, [...(imageFamilies.get(key) || []), asset]);
  }
  for (const [family, images] of imageFamilies.entries()) {
    const ordered = [...images].sort((left, right) => effectiveCreatedAt(right) - effectiveCreatedAt(left) || String(right.id).localeCompare(String(left.id)));
    if (ordered.length < 2) continue;
    const keepLatest = Math.max(1, Number(policy.keepLatestSuccessful ?? 1));
    const retained = ordered.slice(0, keepLatest);
    for (const asset of ordered.slice(keepLatest)) {
      const successor = retained[0];
      if (!Number.isFinite(effectiveCreatedAt(asset)) || !Number.isFinite(effectiveCreatedAt(successor))) continue;
      const successorSuccessful = builds.successful.has(String(successor.id))
        || successor.classification === "active"
        || consumerList(successor).some((consumer) => ["running", "created", "restarting"].includes(String(consumer?.state || "").toLowerCase()));
      superseded.set(String(asset.id), {
        family,
        successorImageId: successor.id,
        successorCreatedAt: successor.createdAt,
        successorTags: normalizedTags(successor),
        successorSuccessful,
      });
    }
  }

  const enriched = assets.map((asset) => {
    const consumers = consumerList(asset);
    const protectedAsset = protectedIdentity(asset);
    const createdAt = effectiveCreatedAt(asset);
    const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
    const supersededEvidence = superseded.get(String(asset.id));
    const failedBuild = builds.failed.has(String(asset.id));
    const existingExecutable = asset.classification === "reclaimable";
    const pressureOrphan = asset.type === "image" && pressure.level !== "normal" && consumers.length === 0 && ageMs >= orphanMs;
    const recovery = recoverySource(asset);
    const discoveryReasons = [
      existingExecutable && "existing-safe-classification",
      supersededEvidence && "superseded-build",
      failedBuild && "failed-build",
      pressureOrphan && "capacity-pressure-orphan",
    ].filter(Boolean);

    if (protectedAsset) return { ...asset, retirementState: "protected", retirementCandidate: { state: "protected", reasons: ["active-or-protected-identity"], blockedBy: [] } };
    if (!discoveryReasons.length) return { ...asset, retirementState: "retained", retirementCandidate: { state: "retained", reasons: [], blockedBy: [] } };

    const blockedBy = [];
    if (consumers.length > 0) blockedBy.push(...consumers.map((consumer) => ({ type: "runtime-reference", id: consumer.id, name: consumer.name, state: consumer.state })));
    if (asset.type === "image" && !recovery && !existingExecutable && !failedBuild) blockedBy.push({ type: "missing-recovery-source" });
    if (supersededEvidence && !supersededEvidence.successorSuccessful && !failedBuild) blockedBy.push({ type: "successor-success-unproven", successorImageId: supersededEvidence.successorImageId });
    if (asset.type === "image" && ageMs < coolingMs && !existingExecutable) blockedBy.push({ type: "cooling-period", remainingMs: coolingMs - ageMs });
    if (source !== "local" && !existingExecutable) blockedBy.push({ type: "remote-automatic-execution-not-enabled" });
    if (asset.type === "volume" && !existingExecutable) blockedBy.push({ type: "persistent-volume-requires-exact-attestation" });

    const executable = blockedBy.length === 0 && (existingExecutable || (asset.type === "image" && Boolean(supersededEvidence || failedBuild)));
    const state = executable ? "executable-candidate" : blockedBy.length ? "blocked-candidate" : "suspected-retired";
    const automaticEvidence = supersededEvidence || failedBuild ? {
      schemaVersion: "sparkling.runtime-automatic-retirement/v1",
      basis: failedBuild ? "failed-build" : "superseded-build",
      observedAt: new Date(now).toISOString(),
      imageId: asset.id,
      tags: normalizedTags(asset),
      revision: imageRevision(asset) || null,
      recoverySource: recovery || null,
      ...supersededEvidence,
    } : undefined;
    return {
      ...asset,
      retirementState: state,
      retirementCandidate: { state, reasons: discoveryReasons, blockedBy, recoverySource: recovery || null, automaticEvidence },
      lineage: automaticEvidence ? { ...asset.lineage, automaticRetirement: automaticEvidence } : asset.lineage,
    };
  });

  const candidates = enriched.filter((asset) => ["suspected-retired", "blocked-candidate", "executable-candidate"].includes(asset.retirementState));
  return {
    assets: enriched,
    pressure,
    summary: {
      suspectedCount: candidates.filter((asset) => asset.retirementState === "suspected-retired").length,
      blockedCount: candidates.filter((asset) => asset.retirementState === "blocked-candidate").length,
      executableCount: candidates.filter((asset) => asset.retirementState === "executable-candidate").length,
      candidateBytes: candidates.reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0),
      blockedBytes: candidates.filter((asset) => asset.retirementState === "blocked-candidate").reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0),
      executableBytes: candidates.filter((asset) => asset.retirementState === "executable-candidate").reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0),
    },
  };
}
