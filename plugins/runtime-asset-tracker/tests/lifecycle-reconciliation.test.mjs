import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyRemoteRetirementGovernance } from "../mcp/inventory.mjs";
import { importUnifiedRetirementReconciliation, validateUnifiedRetirementReconciliation } from "../mcp/lifecycle-reconciliation.mjs";
import { retirementAttestations } from "../mcp/reconciliation.mjs";
import { validateRemoteRetirementApproval } from "../mcp/remote.mjs";

const PROJECT = "owner/cms";
const INSTANCE = "i-test";
const CONTAINER = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;
const PATH = "/home/ec2-user/apps/cms-evaluations/pr28";
const ROOT = "/home/ec2-user/apps/cms-evaluations";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;

function report() {
  const assets = [
    {
      type: "container", id: CONTAINER, name: "cms-pr28-api", imageId: IMAGE, composeProject: "cms-pr28", state: "running", mounts: [],
      sizeBytes: 12, disposable: true, retention: "retired", recoverySource: "git:owner/cms@pr-28", preserveVolumes: true, stopBeforeRemoval: true,
    },
    {
      type: "host_artifact", id: PATH, name: "pr28", managedRoot: ROOT, fingerprint: FINGERPRINT, expectedReferences: 0,
      sizeBytes: 34, disposable: true, retention: "retired", recoverySource: "git:owner/cms@pr-28",
    },
  ];
  return {
    schemaVersion: "sparkling.runtime-unified-retirement-reconciliation/v1", readOnly: true, actionTaken: "none",
    target: { project: PROJECT, source: "staging", instanceId: INSTANCE }, protectedAssets: [],
    candidateGroups: [{
      group: "merged-pr-28", confidence: "high", lifecycle: { kind: "pull_request", number: 28, state: "MERGED", mergedAt: "2026-08-01T00:00:00Z", coolingComplete: true },
      assetCount: assets.length, totalBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), assets,
    }],
  };
}

describe("merged pull-request lifecycle reconciliation", () => {
  const roots = [];
  afterEach(() => {
    delete process.env.RUNTIME_ASSET_STATE_DIR;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("validates exact containers and managed paths only after merge cooling completes", () => {
    const valid = validateUnifiedRetirementReconciliation(report(), { project: PROJECT, source: "staging", instanceId: INSTANCE, groups: ["merged-pr-28"], managedRoots: [ROOT] });
    assert.equal(valid.ok, true);
    assert.equal(valid.assetCount, 2);
    const unsafe = report();
    unsafe.candidateGroups[0].lifecycle.coolingComplete = false;
    unsafe.candidateGroups[0].assets[1].managedRoot = "/home/ec2-user/apps/other";
    const invalid = validateUnifiedRetirementReconciliation(unsafe, { project: PROJECT, source: "staging", instanceId: INSTANCE, groups: ["merged-pr-28"], managedRoots: [ROOT] });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join(" "), /cooling period/);
    assert.match(invalid.errors.join(" "), /not registered/);
  });

  it("imports non-destructive exact attestations idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-unified-"));
    roots.push(root);
    process.env.RUNTIME_ASSET_STATE_DIR = root;
    writeFileSync(join(root, "dashboard-config.json"), JSON.stringify({ projects: [{ id: PROJECT, environments: [{ id: "staging", instanceId: INSTANCE, managedPaths: [{ path: ROOT }] }] }] }));
    const reportPath = join(root, "report.json");
    writeFileSync(reportPath, JSON.stringify(report()));
    const first = importUnifiedRetirementReconciliation({ reportPath, source: "staging", project: PROJECT, groups: ["merged-pr-28"] });
    const second = importUnifiedRetirementReconciliation({ reportPath, source: "staging", project: PROJECT, groups: ["merged-pr-28"] });
    assert.equal(first.retirementEventsAdded, 2);
    assert.equal(second.retirementEventsAdded, 0);
    const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const governance = retirementAttestations(events);
    assert.equal(governance.retirements.get(`container:${CONTAINER}`).preserveVolumes, true);
    assert.equal(governance.retirements.get(`host_artifact:${PATH}`).fingerprint, FINGERPRINT);
  });

  it("makes only exact matching remote container and path assets reclaimable", () => {
    const events = [
      { event: "asset.retired", status: "retired", project: PROJECT, environment: "staging", owner: "platform", asset: { type: "container", id: CONTAINER }, details: { disposable: "true", retention: "retired", recoverySource: "git:pr28", reportSha256: "d".repeat(64), group: "merged-pr-28", expectedName: "cms-pr28-api", expectedState: "running", expectedImageId: IMAGE, expectedComposeProject: "cms-pr28", expectedMounts: [], preserveVolumes: true, stopBeforeRemoval: true, expectedSizeBytes: 12, lifecycle: { state: "MERGED", coolingComplete: true } } },
      { event: "asset.retired", status: "retired", project: PROJECT, environment: "staging", owner: "platform", asset: { type: "host_artifact", id: PATH }, details: { disposable: "true", retention: "retired", recoverySource: "git:pr28", reportSha256: "d".repeat(64), group: "merged-pr-28", managedRoot: ROOT, fingerprint: FINGERPRINT, expectedReferences: 0, expectedSizeBytes: 34, lifecycle: { state: "MERGED", coolingComplete: true } } },
    ];
    const dashboard = applyRemoteRetirementGovernance({ remoteSnapshotAvailable: true, selectedSource: "staging", selectedProject: PROJECT, bars: [], assets: [
      { type: "container", id: CONTAINER, name: "cms-pr28-api", status: "running", sizeBytes: 12, labels: {}, lineage: { imageId: IMAGE, composeProject: "cms-pr28", mounts: [] } },
      { type: "host_artifact", id: PATH, name: "pr28", status: "retained-host-artifact", sizeBytes: 34, labels: {}, lineage: { managedRoot: ROOT, fingerprint: FINGERPRINT, consumers: [] } },
    ] }, retirementAttestations(events));
    assert.deepEqual(dashboard.assets.map((asset) => asset.classification), ["reclaimable", "reclaimable"]);
    const requested = { ...dashboard.assets[0], project: PROJECT, retirementEvidence: dashboard.assets[0].lineage.retirement };
    assert.equal(validateRemoteRetirementApproval(requested, { ...dashboard.assets[0], classification: "active" }, { projectId: PROJECT }), true);
  });
});
