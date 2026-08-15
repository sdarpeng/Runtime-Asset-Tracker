import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capacityPressure, discoverRetirementCandidates } from "../mcp/candidate-policy.mjs";

function image(id, createdAt, { consumers = [], tags = [], revision, classification = "retained", labels = {}, source = "https://github.com/example/cms" } = {}) {
  return {
    id,
    name: tags[0] || id,
    type: "image",
    project: "cms",
    environment: "local",
    createdAt,
    classification,
    sizeBytes: 100,
    labels,
    lineage: { consumers, tags, revision, source },
  };
}

describe("candidate policy", () => {
  it("discovers an unlabelled superseded build and makes it executable from machine lineage", () => {
    const result = discoverRetirementCandidates([
      image("sha256:old", "2026-08-10T00:00:00Z", { tags: ["cms-api:build-1"], revision: "a".repeat(40) }),
      image("sha256:new", "2026-08-10T01:00:00Z", { tags: ["cms-api:build-2"], revision: "b".repeat(40) }),
    ], {
      source: "local",
      project: "cms",
      now: Date.parse("2026-08-14T00:00:00Z"),
      events: [{ event: "build.completed", project: "cms", environment: "local", asset: { id: "sha256:new" } }],
    });
    const old = result.assets.find((asset) => asset.id === "sha256:old");
    assert.equal(old.retirementState, "executable-candidate");
    assert.equal(old.retirementCandidate.automaticEvidence.basis, "superseded-build");
    assert.equal(old.retirementCandidate.automaticEvidence.successorImageId, "sha256:new");
  });

  it("discovers a superseded build but blocks execution when successor success is unproven", () => {
    const result = discoverRetirementCandidates([
      image("sha256:old", "2026-08-10T00:00:00Z", { tags: ["cms-api:build-1"], revision: "a".repeat(40) }),
      image("sha256:new", "2026-08-10T01:00:00Z", { tags: ["cms-api:build-2"], revision: "b".repeat(40) }),
    ], { source: "local", project: "cms", now: Date.parse("2026-08-14T00:00:00Z") });
    const old = result.assets.find((asset) => asset.id === "sha256:old");
    assert.equal(old.retirementState, "blocked-candidate");
    assert.equal(old.retirementCandidate.blockedBy.some((item) => item.type === "successor-success-unproven"), true);
  });

  it("does not combine same-service images from different repositories", () => {
    const result = discoverRetirementCandidates([
      image("sha256:one", "2026-08-10T00:00:00Z", { tags: ["cms-api:build-1"], revision: "a".repeat(40) }),
      image("sha256:two", "2026-08-10T01:00:00Z", { tags: ["payments-api:build-2"], revision: "b".repeat(40) }),
    ], { source: "local", project: "cms", now: Date.parse("2026-08-14T00:00:00Z") });
    assert.equal(result.assets.every((asset) => asset.retirementState === "retained"), true);
  });

  it("keeps referenced superseded builds visible as blocked candidates", () => {
    const result = discoverRetirementCandidates([
      image("sha256:old", "2026-08-10T00:00:00Z", { tags: ["cms-web:build-1"], revision: "a".repeat(40), consumers: [{ id: "container-1", state: "exited" }] }),
      image("sha256:new", "2026-08-10T01:00:00Z", { tags: ["cms-web:build-2"], revision: "b".repeat(40) }),
    ], { source: "local", project: "cms", now: Date.parse("2026-08-14T00:00:00Z") });
    const old = result.assets.find((asset) => asset.id === "sha256:old");
    assert.equal(old.retirementState, "blocked-candidate");
    assert.equal(old.retirementCandidate.blockedBy[0].id, "container-1");
  });

  it("never downgrades rollback identities under capacity pressure", () => {
    const result = discoverRetirementCandidates([
      image("sha256:rollback", "2026-07-01T00:00:00Z", { tags: ["cms-api:rollback-1"], revision: "a".repeat(40) }),
      image("sha256:new", "2026-08-10T01:00:00Z", { tags: ["cms-api:build-2"], revision: "b".repeat(40) }),
    ], { source: "local", project: "cms", disk: { totalBytes: 1000, freeBytes: 1 }, now: Date.parse("2026-08-14T00:00:00Z") });
    assert.equal(result.assets.find((asset) => asset.id === "sha256:rollback").retirementState, "protected");
  });

  it("classifies disk pressure without authorizing deletion", () => {
    assert.equal(capacityPressure({ totalBytes: 1000, freeBytes: 70 }, { criticalFreeBytes: 0, warningFreeBytes: 0 }).level, "critical");
    const result = discoverRetirementCandidates([
      image("sha256:orphan", "2026-07-01T00:00:00Z", { tags: ["misc:old"], source: null }),
    ], { source: "local", project: "cms", disk: { totalBytes: 1000, freeBytes: 100 }, policy: { criticalFreeBytes: 0, warningFreeBytes: 0 }, now: Date.parse("2026-08-14T00:00:00Z") });
    assert.equal(result.assets[0].retirementState, "blocked-candidate");
    assert.equal(result.assets[0].retirementCandidate.blockedBy[0].type, "missing-recovery-source");
  });
});
