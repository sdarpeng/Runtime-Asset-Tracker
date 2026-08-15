import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const UNIFIED_ASSET_TABLE_SCHEMA = "sparkling.runtime-unified-asset-table/v1";

const RUNTIME_PREFIX = "com.codex.runtime.";
const REMOVABLE_TYPES = new Set(["container", "image", "volume", "worktree", "worktree_residual", "host_artifact", "cache"]);

function normalizeSha(value) {
  const sha = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "";
}

function runtimeLabel(asset, name) {
  return asset?.labels?.[`${RUNTIME_PREFIX}${name}`];
}

function assetRevision(asset) {
  const direct = [
    asset?.lineage?.revision,
    runtimeLabel(asset, "git-sha"),
    asset?.labels?.["org.opencontainers.image.revision"],
    asset?.gitSha,
  ].map(normalizeSha).find(Boolean);
  if (direct) return direct;
  const text = [asset?.name, runtimeLabel(asset, "release"), asset?.lineage?.composeProject, ...(asset?.lineage?.tags || [])].filter(Boolean).join(" ");
  return normalizeSha(text.match(/(?:^|[^0-9a-f])([0-9a-f]{7,40})(?:$|[^0-9a-f])/i)?.[1]);
}

function pullRequestHint(asset) {
  const label = Number(runtimeLabel(asset, "pull-request"));
  if (Number.isInteger(label) && label > 0) return { number: label, source: "runtime-label" };
  const text = [asset?.id, asset?.name, runtimeLabel(asset, "release"), asset?.lineage?.composeProject, ...(asset?.lineage?.tags || [])].filter(Boolean).join(" ");
  const match = text.match(/(?:^|[-_/])pr-?(\d{1,7})(?:$|[-_/])/i);
  return match ? { number: Number(match[1]), source: "name-hint" } : null;
}

function githubLineage(authority = {}) {
  return authority.lineage && typeof authority.lineage === "object" ? authority.lineage : authority;
}

function authorityMaps(authority = {}) {
  const byRevision = new Map();
  const byPullRequest = new Map();
  for (const [revision, value] of Object.entries(githubLineage(authority))) {
    const normalized = normalizeSha(revision);
    if (!normalized) continue;
    const pullRequests = Array.isArray(value?.pullRequests) ? value.pullRequests : [];
    const record = { revision: normalized, ...value, pullRequests };
    byRevision.set(normalized, record);
    for (const pullRequest of pullRequests) {
      const number = Number(pullRequest?.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      const existing = byPullRequest.get(number) || [];
      existing.push({ revision: normalized, ...pullRequest });
      byPullRequest.set(number, existing);
    }
  }
  return { byRevision, byPullRequest };
}

function uniquePrefixRecord(revision, byRevision) {
  if (!revision) return null;
  if (byRevision.has(revision)) return { record: byRevision.get(revision), match: "exact" };
  const matches = [...byRevision.entries()].filter(([candidate]) => candidate.startsWith(revision) || revision.startsWith(candidate));
  return matches.length === 1 ? { record: matches[0][1], match: "unique-prefix" } : null;
}

function lifecycleAuthority(asset, maps, now, coolingHours) {
  const revision = assetRevision(asset);
  const revisionAuthority = uniquePrefixRecord(revision, maps.byRevision);
  const hint = pullRequestHint(asset);
  let pullRequests = revisionAuthority?.record?.pullRequests || [];
  let binding = revisionAuthority ? revisionAuthority.match : "none";
  if (!pullRequests.length && hint?.source === "runtime-label") {
    pullRequests = maps.byPullRequest.get(hint.number) || [];
    binding = pullRequests.length ? "runtime-label" : "none";
  }
  const merged = pullRequests.filter((item) => String(item?.state || "").toUpperCase() === "MERGED" && item?.mergedAt);
  const open = pullRequests.filter((item) => String(item?.state || "").toUpperCase() === "OPEN");
  const selected = merged.sort((left, right) => String(right.mergedAt).localeCompare(String(left.mergedAt)))[0] || open[0] || null;
  const mergedAtMs = selected?.mergedAt ? Date.parse(selected.mergedAt) : Number.NaN;
  const coolingComplete = Boolean(selected && String(selected.state).toUpperCase() === "MERGED" && Number.isFinite(mergedAtMs) && now - mergedAtMs >= coolingHours * 3_600_000);
  return {
    revision: revision || null,
    revisionExists: revisionAuthority?.record?.existsOnGitHub ?? null,
    binding,
    pullRequest: selected ? { number: Number(selected.number), state: String(selected.state).toUpperCase(), mergedAt: selected.mergedAt || null, url: selected.url || null } : hint ? { number: hint.number, state: "UNVERIFIED", mergedAt: null, url: null } : null,
    coolingHours,
    coolingComplete,
    conflictingOpenPullRequest: open.length > 0,
  };
}

function consumers(asset) {
  return Array.isArray(asset?.lineage?.consumers) ? asset.lineage.consumers : [];
}

function isProtected(asset, source) {
  const reason = String(asset?.lineage?.protection?.reason || asset?.reason || "").toLowerCase();
  const name = String(asset?.name || "").toLowerCase();
  const identityText = [name, runtimeLabel(asset, "release"), ...(asset?.lineage?.tags || [])].filter(Boolean).join(" ").toLowerCase();
  const running = String(asset?.status || "").toLowerCase() === "running" || consumers(asset).some((item) => item?.state === "running");
  if (asset?.classification === "protected") return true;
  if (/(?:^|[-_/:])(rollback|recovery)(?:$|[-_/:])/.test(identityText)) return true;
  if (["active", "protected"].includes(asset?.classification) && /(current|rollback|release|recovery)/.test(reason)) return true;
  if (asset?.retirementBlocked && /(current|rollback|release)/.test(reason)) return true;
  if (source === "production" && running && /(?:^|[-_])prod(?:uction)?(?:$|[-_])/.test(name)) return true;
  return runtimeLabel(asset, "disposable") === "false" && runtimeLabel(asset, "retention") === "protected";
}

function revisionMatches(left, right) {
  const first = normalizeSha(left);
  const second = normalizeSha(right);
  return Boolean(first && second && (first.startsWith(second) || second.startsWith(first)));
}

function decisionFor(asset, source, lifecycle, protectedRevision = false) {
  const refs = consumers(asset);
  if (!REMOVABLE_TYPES.has(asset.type)) return { decision: "inventory-only", reason: "Asset type is not supported by an exact cleanup executor." };
  if (protectedRevision) return { decision: "protected", reason: "Asset revision is bound to current, rollback, or recovery state in this environment." };
  if (isProtected(asset, source)) return { decision: "protected", reason: "Current, rollback, recovery, or explicitly protected runtime binding." };
  if (lifecycle.conflictingOpenPullRequest) return { decision: "review", reason: "GitHub authority still reports an open pull request for the bound revision." };
  if (asset.classification === "reclaimable") {
    if (asset.type === "container" && (!asset?.lineage?.imageId || !asset?.lineage?.composeProject || !Array.isArray(asset?.lineage?.mounts))) {
      return { decision: "review", reason: "Legacy container retirement evidence lacks the v0.4 exact image, Compose project, or mount contract." };
    }
    return { decision: "candidate-existing-attestation", reason: "Tracker already has exact retirement evidence; live state must still be revalidated at execution." };
  }
  if (lifecycle.pullRequest?.state !== "MERGED") return { decision: "review", reason: lifecycle.pullRequest ? "Pull-request hint is not authoritatively merged." : "No authoritative merged-PR binding." };
  if (!lifecycle.coolingComplete) return { decision: "retained-cooling", reason: "Merged PR has not completed the configured cooling period." };
  if (!["exact", "unique-prefix", "runtime-label"].includes(lifecycle.binding)) return { decision: "review", reason: "Lifecycle relationship is inferred only from a name and is not authoritative." };
  if (asset.type === "image" && refs.length) return { decision: "blocked-referenced", reason: "One or more containers still reference this image." };
  if (["host_artifact", "worktree"].includes(asset.type) && refs.length) return { decision: "blocked-referenced", reason: "A container bind mount still references this managed path." };
  if (asset.type === "volume" && refs.length) return { decision: "blocked-referenced", reason: "One or more containers still reference this volume." };
  if (["host_artifact", "worktree"].includes(asset.type) && (!asset?.lineage?.managedRoot || !asset?.lineage?.fingerprint)) return { decision: "review", reason: "Managed-root or metadata-fingerprint evidence is incomplete." };
  if (asset.type === "container") {
    const state = String(asset.status || "unknown").toLowerCase();
    return state === "running"
      ? { decision: "candidate-stop-then-remove", reason: "Merged-PR container may be stopped and removed only with an exact mount contract; volumes remain preserved." }
      : { decision: "candidate-remove", reason: "Stopped merged-PR container can be removed with an exact identity and mount contract; volumes remain preserved." };
  }
  return { decision: "candidate-retirement", reason: "Authoritatively merged, cooling complete, unprotected, and zero runtime references." };
}

function exactIdentity(asset) {
  return {
    id: String(asset.id || ""),
    name: String(asset.name || ""),
    tags: [...(asset?.lineage?.tags || [])].map(String).sort(),
    imageId: asset?.lineage?.imageId || null,
    state: asset?.status || null,
    composeProject: asset?.lineage?.composeProject || null,
    mounts: [...(asset?.lineage?.mounts || [])],
    managedRoot: asset?.lineage?.managedRoot || null,
    fingerprint: asset?.lineage?.fingerprint || null,
    references: consumers(asset),
    sizeBytes: Number(asset.sizeBytes || 0),
  };
}

function summarize(rows) {
  const summary = { assetCount: rows.length, bytes: 0, decisions: {}, environments: {}, types: {} };
  for (const row of rows) {
    summary.bytes += row.exactIdentity.sizeBytes;
    summary.decisions[row.decision] = (summary.decisions[row.decision] || 0) + 1;
    summary.environments[row.source] = (summary.environments[row.source] || 0) + 1;
    summary.types[row.type] = (summary.types[row.type] || 0) + 1;
  }
  summary.candidateCount = rows.filter((row) => row.decision.startsWith("candidate-")).length;
  summary.candidateBytesUpperBound = rows.filter((row) => row.decision.startsWith("candidate-")).reduce((total, row) => total + row.exactIdentity.sizeBytes, 0);
  return summary;
}

export function buildUnifiedAssetTable({ project, dashboards = [], githubAuthority = {}, generatedAt = new Date().toISOString(), coolingHours = 24 } = {}) {
  if (!project) throw new Error("project is required");
  if (!Array.isArray(dashboards) || dashboards.length === 0) throw new Error("At least one environment dashboard is required");
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(now)) throw new Error("generatedAt must be an ISO timestamp");
  const maps = authorityMaps(githubAuthority);
  const rows = dashboards.flatMap(({ source, dashboard }) => {
    const prepared = (dashboard?.assets || []).map((asset) => ({ asset, lifecycle: lifecycleAuthority(asset, maps, now, coolingHours) }));
    const protectedRevisions = new Set([
      source === "production" ? normalizeSha(dashboard?.revision) : "",
      ...prepared.filter(({ asset }) => isProtected(asset, source)).map(({ lifecycle }) => normalizeSha(lifecycle.revision)),
    ].filter(Boolean));
    return prepared.map(({ asset, lifecycle }) => {
      const protectedRevision = [...protectedRevisions].some((revision) => revisionMatches(revision, lifecycle.revision));
      const decision = decisionFor(asset, source, lifecycle, protectedRevision);
      return {
        key: `${source}:${asset.type}:${asset.id}`,
        project,
        source,
        type: asset.type,
        classification: asset.classification || "unknown",
        ...decision,
        lifecycle,
        exactIdentity: exactIdentity(asset),
        recoverySource: runtimeLabel(asset, "recovery-source") || asset?.lineage?.source || (lifecycle.revision ? `git:${project}@${lifecycle.revision}` : null),
      };
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
  const authorityDigest = createHash("sha256").update(JSON.stringify(githubAuthority)).digest("hex");
  return {
    schemaVersion: UNIFIED_ASSET_TABLE_SCHEMA,
    generatedAt,
    readOnly: true,
    actionTaken: "none",
    project,
    policy: { coolingHours, mergedDoesNotImplyDisposable: true, unknownOwnershipBlocksCleanup: true, volumesPreservedByDefault: true },
    authority: { kind: "github-revision-pull-request-lineage", sha256: authorityDigest },
    summary: summarize(rows),
    assets: rows,
  };
}

export function loadGithubAuthority(authorityReportPath) {
  if (!authorityReportPath) return {};
  return JSON.parse(readFileSync(resolve(authorityReportPath), "utf8"));
}

export function writeUnifiedAssetTable(table, outputPath) {
  if (!outputPath) return null;
  const absolutePath = resolve(outputPath);
  writeFileSync(absolutePath, `${JSON.stringify(table, null, 2)}\n`, "utf8");
  return absolutePath;
}
