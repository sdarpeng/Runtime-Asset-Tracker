import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyRemoteRetirementGovernance, detectSupersededBuildChains } from "../mcp/inventory.mjs";
import { importRetirementReconciliation, retirementAttestations, validateRetirementReconciliation } from "../mcp/reconciliation.mjs";
import { buildPostCleanupVerification, remoteImageRemovalArgs, validateRemoteRetirementApproval } from "../mcp/remote.mjs";

const IMAGE = `sha256:${"a".repeat(64)}`;
const CURRENT = `sha256:${"b".repeat(64)}`;
const ROLLBACK = `sha256:${"c".repeat(64)}`;
const REVISION = "1".repeat(40);
const CURRENT_REVISION = "2".repeat(40);
const RELEASE_REVISION = "3".repeat(40);
const PROJECT = "owner/repository";

function report() {
  return {
    schemaVersion: "sparkling.runtime-image-retirement-reconciliation/v1",
    readOnly: true,
    actionTaken: "none",
    target: { project: PROJECT, instanceId: "i-test" },
    neverDelete: {
      currentProduction: [{ id: CURRENT, revision: CURRENT_REVISION }],
      activeVerificationAndPreviewImageIds: [],
    },
    rollbackKeep: [{ id: ROLLBACK, revision: RELEASE_REVISION, reason: "release baseline" }],
    candidateGroups: [{
      group: "closed-line",
      confidence: "high",
      imageCount: 1,
      uniqueBytes: 123,
      images: [{ id: IMAGE, tags: ["example/api:one", "example/api:two"], revision: REVISION, uniqueBytes: 123 }],
    }],
  };
}

describe("runtime retirement reconciliation", () => {
  const temporaryRoots = [];
  afterEach(() => {
    delete process.env.RUNTIME_ASSET_STATE_DIR;
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("validates exact high-confidence groups and rejects protected overlap", () => {
    const valid = validateRetirementReconciliation(report(), { project: PROJECT, source: "production", instanceId: "i-test", groups: ["closed-line"] });
    assert.equal(valid.ok, true);
    assert.equal(valid.imageCount, 1);
    const invalidReport = report();
    invalidReport.rollbackKeep.push({ id: IMAGE, revision: REVISION });
    const invalid = validateRetirementReconciliation(invalidReport, { project: PROJECT, source: "production", instanceId: "i-test", groups: ["closed-line"] });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join(" "), /Protected image/);
  });

  it("imports idempotent retirement and protection events into the append-only ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-reconcile-"));
    temporaryRoots.push(root);
    process.env.RUNTIME_ASSET_STATE_DIR = root;
    writeFileSync(join(root, "dashboard-config.json"), JSON.stringify({ projects: [{ id: PROJECT, environments: [{ id: "production", instanceId: "i-test" }] }] }));
    const reportPath = join(root, "report.json");
    writeFileSync(reportPath, JSON.stringify(report()));
    const first = importRetirementReconciliation({ reportPath, source: "production", project: PROJECT, groups: ["closed-line"] });
    const second = importRetirementReconciliation({ reportPath, source: "production", project: PROJECT, groups: ["closed-line"] });
    assert.equal(first.retirementEventsAdded, 1);
    assert.equal(first.protectionEventsAdded, 2);
    assert.equal(second.retirementEventsAdded, 0);
    assert.equal(second.idempotentSkipCount, 1);
    const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const governance = retirementAttestations(events);
    assert.deepEqual(governance.retirements.get(`image:${IMAGE}`).approvedTags, ["example/api:one", "example/api:two"]);
    assert.equal(governance.protections.get(`image:${CURRENT}`).revision, CURRENT_REVISION);
    assert.equal(governance.protections.get(`image:${ROLLBACK}`).revision, RELEASE_REVISION);
  });

  it("normalizes legacy scalar approvedTags without crashing dashboard reconciliation", () => {
    const governance = retirementAttestations([{
      event: "asset.retired",
      status: "retired",
      project: PROJECT,
      environment: "production",
      owner: "platform",
      release: "legacy-import",
      gitSha: REVISION,
      asset: { type: "image", id: IMAGE },
      details: {
        disposable: "true",
        retention: "retired",
        recoverySource: `git:${REVISION}`,
        approvedTags: "example/api:legacy",
        reportSha256: "d".repeat(64),
        group: "legacy-import",
      },
    }]);
    assert.deepEqual(governance.retirements.get(`image:${IMAGE}`).approvedTags, ["example/api:legacy"]);
  });

  it("keeps identical remote image IDs scoped to their project environment", () => {
    const event = (environment, approvedTags) => ({
      event: "asset.retired",
      status: "retired",
      project: PROJECT,
      environment,
      owner: "platform",
      release: `merged-${environment}`,
      gitSha: REVISION,
      asset: { type: "image", id: IMAGE },
      details: {
        disposable: "true",
        retention: "retired",
        recoverySource: `git:${REVISION}`,
        approvedTags,
        reportSha256: environment === "production" ? "d".repeat(64) : "e".repeat(64),
        group: `merged-${environment}`,
      },
    });
    const events = [event("production", ["example/api:production"]), event("staging", ["example/api:staging"])];
    const production = retirementAttestations(events, { project: PROJECT, environment: "production" });
    const staging = retirementAttestations(events, { project: PROJECT, environment: "staging" });
    assert.deepEqual(production.retirements.get(`image:${IMAGE}`).approvedTags, ["example/api:production"]);
    assert.deepEqual(staging.retirements.get(`image:${IMAGE}`).approvedTags, ["example/api:staging"]);
  });

  it("imports exact local retirement without requiring a remote environment registration", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-reconcile-local-"));
    temporaryRoots.push(root);
    process.env.RUNTIME_ASSET_STATE_DIR = root;
    writeFileSync(join(root, "dashboard-config.json"), JSON.stringify({ projects: [{ id: PROJECT }] }));
    const localReport = report();
    delete localReport.target.instanceId;
    localReport.candidateGroups[0].images[0].recoverySource = `git:C:\\work\\repository@${REVISION}`;
    const reportPath = join(root, "local-report.json");
    writeFileSync(reportPath, JSON.stringify(localReport));

    const imported = importRetirementReconciliation({ reportPath, source: "local", project: PROJECT, groups: ["closed-line"] });
    assert.equal(imported.retirementEventsAdded, 1);
    const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const retirement = events.find((event) => event.event === "asset.retired");
    assert.equal(retirement.environment, "local");
    assert.match(retirement.details.recoverySource, /git:C:\\work\\repository/);
  });

  it("makes an exact remote retirement reclaimable and acknowledges protected release drift", () => {
    const reportSha256 = "d".repeat(64);
    const governance = retirementAttestations([
      {
        event: "asset.retired", status: "retired", project: PROJECT, environment: "production", owner: "platform", release: "closed-line", gitSha: REVISION,
        asset: { type: "image", id: IMAGE },
        details: { disposable: "true", retention: "retired", recoverySource: `git:${REVISION}`, approvedTags: ["example/api:one", "example/api:two"], reportSha256, group: "closed-line" },
      },
      { event: "asset.protection.bound", status: "protected", project: PROJECT, environment: "production", gitSha: CURRENT_REVISION, asset: { type: "image", id: CURRENT }, details: { reportSha256, reason: "current" } },
      { event: "asset.protection.bound", status: "protected", project: PROJECT, environment: "production", gitSha: RELEASE_REVISION, asset: { type: "image", id: ROLLBACK }, details: { reportSha256, reason: "rollback" } },
    ]);
    const dashboard = applyRemoteRetirementGovernance({
      remoteSnapshotAvailable: true,
      selectedSource: "production",
      selectedProject: PROJECT,
      revision: RELEASE_REVISION,
      bars: [{ type: "image", totalBytes: 500, unit: "bytes" }],
      assets: [
        { type: "image", id: IMAGE, project: PROJECT, classification: "protected", sizeBytes: 123, labels: { "com.codex.runtime.disposable": "false" }, lineage: { tags: ["example/api:two", "example/api:one"], revision: REVISION, consumers: [] } },
        { type: "image", id: CURRENT, project: PROJECT, classification: "active", sizeBytes: 200, labels: {}, lineage: { tags: ["example/api:current"], revision: CURRENT_REVISION, consumers: [{ name: "sparkling-cms-prod-api-1", state: "running" }] } },
        { type: "image", id: ROLLBACK, project: PROJECT, classification: "protected", sizeBytes: 177, labels: {}, lineage: { tags: ["example/api:rollback"], revision: RELEASE_REVISION, consumers: [] } },
      ],
    }, governance);
    const retired = dashboard.assets.find((asset) => asset.id === IMAGE);
    assert.equal(retired.classification, "reclaimable");
    assert.equal(dashboard.releaseRuntimeDrift.detected, true);
    assert.equal(dashboard.releaseRuntimeDrift.acknowledgedByProtectionReport, true);
    assert.equal(dashboard.releaseRuntimeDrift.cleanupBlocked, false);
  });

  it("fails closed on tag drift and validates atomic remote removal", () => {
    const requested = {
      type: "image", id: IMAGE, project: PROJECT, tags: ["example/api:one", "example/api:two"],
      retirementEvidence: { reportSha256: "d".repeat(64), revision: REVISION, approvedTags: ["example/api:one", "example/api:two"] },
    };
    const current = { type: "image", id: IMAGE, lineage: { tags: ["example/api:one", "example/api:two"], revision: REVISION, consumers: [] } };
    assert.equal(validateRemoteRetirementApproval(requested, current, { projectId: PROJECT }), true);
    assert.equal(validateRemoteRetirementApproval({ ...requested, tags: ["example/api:one"] }, current, { projectId: PROJECT }), false);
    assert.deepEqual(remoteImageRemovalArgs(requested), ["image", "rm", "example/api:one", "example/api:two"]);
    assert.equal(remoteImageRemovalArgs(requested).includes("--force"), false);
  });

  it("reports post-cleanup container and image invariants plus disk delta", () => {
    const before = { disk: { freeBytes: 100 }, assets: [{ type: "container", id: "container", name: "api", classification: "active" }, { type: "image", id: IMAGE }] };
    const after = { disk: { freeBytes: 223 }, assets: [{ type: "container", id: "container", name: "api", classification: "active" }] };
    const verification = buildPostCleanupVerification(before, after, [{ type: "image", id: IMAGE, status: "removed" }]);
    assert.equal(verification.status, "pass");
    assert.equal(verification.freeBytesDelta, 123);
  });

  it("surfaces repeated candidate builds as a superseded chain without auto-retiring them", () => {
    const assets = [0, 1].map((index) => ({
      type: "image", id: `sha256:${String(index + 4).repeat(64)}`, project: PROJECT, classification: "retained", createdAt: `2026-08-0${index + 1}T00:00:00Z`, sizeBytes: 10,
      labels: {}, lineage: { consumers: [], revision: String(index + 4).repeat(40), tags: [`example-api:candidate-retry-${index}`] },
    }));
    const chains = detectSupersededBuildChains(assets);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].status, "superseded-build-chain");
    assert.ok(assets.every((asset) => asset.classification === "retained"));
  });

  it("surfaces close ordinary builds of the same service family and keeps recovery images out", () => {
    const assets = [
      { type: "image", id: `sha256:${"6".repeat(64)}`, project: PROJECT, classification: "retained", createdAt: "2026-08-14T01:00:00Z", sizeBytes: 10, labels: {}, lineage: { consumers: [], revision: "6".repeat(40), tags: ["example-staging-api:first"] } },
      { type: "image", id: `sha256:${"7".repeat(64)}`, project: PROJECT, classification: "retained", createdAt: "2026-08-14T03:00:00Z", sizeBytes: 11, labels: {}, lineage: { consumers: [], revision: "7".repeat(40), tags: ["example-production-api:second"] } },
      { type: "image", id: `sha256:${"8".repeat(64)}`, project: PROJECT, classification: "protected", createdAt: "2026-08-14T04:00:00Z", sizeBytes: 12, labels: {}, lineage: { consumers: [], revision: "8".repeat(40), tags: ["example-recovery-api:rollback"] } },
    ];
    const chains = detectSupersededBuildChains(assets);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].keepLatest.id, assets[1].id);
    assert.deepEqual(chains[0].supersededCandidates.map((item) => item.id), [assets[0].id]);
    assert.equal(chains[0].requiresAncestryProof, true);
    assert.equal(chains[0].decision, "review-only");
  });

  it("surfaces unlabeled OCR audit rebuilds without treating them as deletion authorization", () => {
    const assets = [
      { type: "image", id: `sha256:${"9".repeat(64)}`, project: "sdarpeng/FinPortEx", classification: "retained", createdAt: "2026-07-06T16:47:37Z", sizeBytes: 1_941_000_000, labels: {}, lineage: { consumers: [], tags: ["finportex-ocr-audit:25284-1783356301457"] } },
      { type: "image", id: `sha256:${"a".repeat(64)}`, project: "sdarpeng/FinPortEx", classification: "retained", createdAt: "2026-07-06T16:52:12Z", sizeBytes: 528_300_000, labels: {}, lineage: { consumers: [], tags: ["finportex-ocr-audit:9916-1783356583065"] } },
      { type: "image", id: `sha256:${"b".repeat(64)}`, project: "sdarpeng/FinPortEx", classification: "retained", createdAt: "2026-07-06T16:52:13Z", sizeBytes: 528_300_000, labels: {}, lineage: { consumers: [], tags: ["finportex-ocr-audit:23040-1783356921768"] } },
    ];
    const chains = detectSupersededBuildChains(assets);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].project, "sdarpeng/FinPortEx");
    assert.equal(chains[0].service, "ocr");
    assert.equal(chains[0].imageCount, 3);
    assert.equal(chains[0].semanticSignals.includes("audit"), true);
    assert.equal(chains[0].decision, "review-only");
    assert.equal(chains[0].requiresAncestryProof, true);
  });

  it("does not report ordinary external base-image versions as failed application builds", () => {
    const assets = [
      { type: "image", id: `sha256:${"c".repeat(64)}`, project: "node", classification: "retained", createdAt: "2026-08-01T00:00:00Z", sizeBytes: 10, labels: {}, lineage: { consumers: [], tags: ["node:20-bookworm"] } },
      { type: "image", id: `sha256:${"d".repeat(64)}`, project: "node", classification: "retained", createdAt: "2026-08-02T00:00:00Z", sizeBytes: 11, labels: {}, lineage: { consumers: [], tags: ["node:20-bookworm-slim"] } },
    ];
    assert.deepEqual(detectSupersededBuildChains(assets), []);
  });
});
