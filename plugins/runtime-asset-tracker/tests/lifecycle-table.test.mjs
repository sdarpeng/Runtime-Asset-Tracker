import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUnifiedAssetTable, UNIFIED_ASSET_TABLE_SCHEMA } from "../mcp/lifecycle-table.mjs";

const PROJECT = "owner/cms";
const REVISION = "a".repeat(40);
const MERGED_AT = "2026-08-01T00:00:00Z";

function authority() {
  return { lineage: { [REVISION]: { existsOnGitHub: true, pullRequests: [{ number: 28, state: "MERGED", mergedAt: MERGED_AT, url: "https://example.invalid/pr/28" }] } } };
}

function asset(overrides = {}) {
  return {
    id: overrides.id || "b".repeat(64),
    name: overrides.name || "cms-pr28-api",
    type: overrides.type || "container",
    status: overrides.status || "exited",
    classification: overrides.classification || "retained",
    sizeBytes: overrides.sizeBytes ?? 100,
    ...overrides,
    labels: { "org.opencontainers.image.revision": REVISION, ...(overrides.labels || {}) },
    lineage: { consumers: [], imageId: `sha256:${"c".repeat(64)}`, composeProject: "cms-pr28", mounts: [], ...(overrides.lineage || {}) },
  };
}

describe("unified runtime asset table", () => {
  it("correlates merged PR authority but preserves current Production runtime", () => {
    const workerRevision = "d".repeat(40);
    const githubAuthority = authority();
    githubAuthority.lineage[workerRevision] = { existsOnGitHub: true, pullRequests: [{ number: 29, state: "MERGED", mergedAt: MERGED_AT, url: "https://example.invalid/pr/29" }] };
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority,
      dashboards: [{ source: "production", dashboard: { assets: [
        asset({ name: "cms-prod-api-1", status: "running", classification: "active", reason: "current-production", lineage: { consumers: [{ id: "x", state: "running" }], protection: { reason: "current-production" } } }),
        asset({ id: "d".repeat(64), name: "cms-pr28-worker", status: "running", labels: { "org.opencontainers.image.revision": workerRevision } }),
      ] } }],
    });
    assert.equal(table.schemaVersion, UNIFIED_ASSET_TABLE_SCHEMA);
    assert.equal(table.assets.find((row) => row.exactIdentity.name === "cms-pr28-worker").decision, "candidate-stop-then-remove");
    assert.equal(table.assets.find((row) => row.exactIdentity.name === "cms-pr28-worker").exactIdentity.state, "running");
    assert.equal(table.assets.find((row) => row.exactIdentity.name === "cms-prod-api-1").decision, "protected");
    assert.equal(table.summary.candidateCount, 1);
  });

  it("blocks referenced assets and leaves name-only PR hints for review", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "staging", dashboard: { assets: [
        asset({ type: "image", id: `sha256:${"e".repeat(64)}`, lineage: { revision: REVISION, tags: ["cms:pr28"], consumers: [{ id: "container", state: "exited" }] } }),
        asset({ id: "f".repeat(64), labels: { "org.opencontainers.image.revision": "" }, lineage: { consumers: [], imageId: "image", composeProject: "cms-pr28", mounts: [] } }),
      ] } }],
    });
    assert.equal(table.assets.find((row) => row.type === "image").decision, "blocked-referenced");
    assert.equal(table.assets.find((row) => row.type === "container").decision, "review");
  });

  it("requires exact managed-path fingerprint evidence", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "staging", dashboard: { assets: [
        asset({ type: "host_artifact", id: "/managed/pr28", name: REVISION, lineage: { revision: REVISION, consumers: [], managedRoot: "/managed" } }),
        asset({ type: "host_artifact", id: "/managed/pr28-good", name: REVISION, lineage: { revision: REVISION, consumers: [], managedRoot: "/managed", fingerprint: `sha256:${"f".repeat(64)}` } }),
      ] } }],
    });
    assert.equal(table.assets.find((row) => row.exactIdentity.id === "/managed/pr28").decision, "review");
    assert.equal(table.assets.find((row) => row.exactIdentity.id === "/managed/pr28-good").decision, "candidate-retirement");
  });

  it("lets every Tracker protected classification override merged-PR retirement", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "production", dashboard: { assets: [
        asset({ type: "image", id: `sha256:${"9".repeat(64)}`, name: "cms-api:previous", classification: "protected", reason: "Immediate previous API image", lineage: { revision: REVISION, consumers: [], tags: ["cms-api:previous"] } }),
      ] } }],
    });
    assert.equal(table.assets[0].decision, "protected");
  });

  it("atomically protects a multi-tag image when any tag is rollback or recovery", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "production", dashboard: { assets: [
        asset({ type: "image", id: `sha256:${"8".repeat(64)}`, name: "cms-api:feature", classification: "retained", lineage: { revision: REVISION, consumers: [], tags: ["cms-api:feature", "cms-api:rollback-feature"] } }),
      ] } }],
    });
    assert.equal(table.assets[0].decision, "protected");
  });

  it("does not inherit a legacy reclaimable container without an exact Compose contract", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      dashboards: [{ source: "production", dashboard: { assets: [
        asset({ classification: "reclaimable", lineage: { imageId: `sha256:${"c".repeat(64)}`, composeProject: null, mounts: [] } }),
      ] } }],
    });
    assert.equal(table.assets[0].decision, "review");
  });

  it("accepts a unique GitHub revision prefix in a managed path but not a date token", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "staging", dashboard: { assets: [
        asset({ type: "host_artifact", id: `/managed/pr28-${REVISION.slice(0, 8)}`, name: `pr28-${REVISION.slice(0, 8)}`, lineage: { consumers: [], managedRoot: "/managed", fingerprint: `sha256:${"1".repeat(64)}` } }),
        asset({ type: "host_artifact", id: "/managed/pr28-20260814", name: "pr28-20260814", labels: { "org.opencontainers.image.revision": "" }, lineage: { consumers: [], managedRoot: "/managed", fingerprint: `sha256:${"2".repeat(64)}` } }),
      ] } }],
    });
    assert.equal(table.assets.find((row) => row.exactIdentity.name.includes(REVISION.slice(0, 8))).decision, "candidate-retirement");
    assert.equal(table.assets.find((row) => row.exactIdentity.name.includes("20260814")).decision, "review");
  });

  it("propagates current and rollback revision protection to related Production paths", () => {
    const table = buildUnifiedAssetTable({
      project: PROJECT,
      generatedAt: "2026-08-14T00:00:00Z",
      githubAuthority: authority(),
      dashboards: [{ source: "production", dashboard: { revision: REVISION, assets: [
        asset({ type: "image", id: `sha256:${"7".repeat(64)}`, name: "cms-api:rollback", classification: "protected", lineage: { revision: REVISION, consumers: [], tags: ["cms-api:rollback"] } }),
        asset({ type: "worktree", id: `/releases/release-${REVISION.slice(0, 8)}`, name: `release-${REVISION.slice(0, 8)}`, classification: "retained", lineage: { consumers: [], managedRoot: "/releases", fingerprint: `sha256:${"6".repeat(64)}` } }),
      ] } }],
    });
    assert.deepEqual(table.assets.map((row) => row.decision), ["protected", "protected"]);
  });
});
