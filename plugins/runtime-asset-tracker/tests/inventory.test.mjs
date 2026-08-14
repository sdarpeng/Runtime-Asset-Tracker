import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalProjectId, collectDashboard, createCleanupPreview, localBuildCacheBar, localCleanupArgs, localCleanupTimeoutMs, normalizeGithubRepository, parseBytes, projectSourceConfigs, registeredProjects, resolveProjectId, retirementOverrideLabels } from "../mcp/inventory.mjs";

describe("runtime asset dashboard inventory", () => {
  it("parses Docker size units and clamps invalid negative values", () => {
    assert.equal(parseBytes("1.5GB"), 1_500_000_000);
    assert.equal(parseBytes("512MiB"), 512 * 1024 * 1024);
    assert.equal(parseBytes("-6.1GB"), 0);
  });

  it("maps the Docker 29 Build Cache summary into the local reclaimable bar", () => {
    assert.deepEqual(localBuildCacheBar({
      "Build Cache": { totalCount: 285, sizeBytes: 107_500_000_000, reclaimableBytes: 11_290_000_000 },
    }), {
      type: "cache",
      totalBytes: 107_500_000_000,
      count: 285,
      activeBytes: 0,
      protectedBytes: 0,
      expiringBytes: 0,
      retainedBytes: 96_210_000_000,
      reclaimableBytes: 11_290_000_000,
      unit: "bytes",
    });
  });

  it("allows a bounded long timeout for a large local Build Cache prune", () => {
    assert.equal(localCleanupTimeoutMs({ type: "cache", id: "docker-build-cache" }), 15 * 60_000);
    assert.equal(localCleanupTimeoutMs({ type: "image", id: "sha256:test" }), 30_000);
  });

  it("uses registered GitHub repositories as project authority", () => {
    const projects = registeredProjects({
      projects: [
        { id: "owner/alpha", repository: "https://github.com/owner/alpha.git", label: "Alpha", aliases: ["alpha-app"] },
        { id: "owner/beta", repository: "owner/beta", label: "Beta" },
      ],
      sources: [{ id: "github", kind: "github", repository: "owner/legacy" }],
    });
    assert.deepEqual(projects.map((item) => item.id), ["owner/alpha", "owner/beta"]);
    assert.equal(projects[0].label, "Alpha");
    assert.ok(projects[0].aliases.includes("alpha-app"));
    assert.equal(normalizeGithubRepository("git@github.com:owner/alpha.git"), "owner/alpha");
  });

  it("keeps the legacy single GitHub repository config compatible", () => {
    const projects = registeredProjects({ sources: [{ id: "github", kind: "github", repository: "owner/legacy" }] });
    assert.deepEqual(projects.map((item) => item.id), ["owner/legacy"]);
  });

  it("binds EC2 environments to their registered project", () => {
    const config = {
      projects: [
        {
          repository: "owner/cms",
          environments: [
            { id: "production", kind: "aws-ssm", instanceId: "i-cms-production" },
            { id: "staging", kind: "aws-ssm", instanceId: "i-cms-staging" },
          ],
        },
        { repository: "owner/finportex" },
      ],
      sources: [],
    };
    assert.deepEqual(projectSourceConfigs(config, "owner/cms").map((item) => item.id), ["local", "production", "staging", "github"]);
    assert.deepEqual(projectSourceConfigs(config, "owner/finportex").map((item) => item.id), ["local", "github"]);
  });

  it("does not leak legacy EC2 sources into another project", () => {
    const config = {
      projects: [{ repository: "owner/cms" }, { repository: "owner/finportex" }],
      sources: [
        { id: "production", kind: "aws-ssm", instanceId: "i-cms-production" },
        { id: "github", kind: "github", repository: "owner/cms" },
      ],
    };
    assert.deepEqual(projectSourceConfigs(config, "owner/cms").map((item) => item.id), ["local", "production", "github"]);
    assert.deepEqual(projectSourceConfigs(config, "owner/finportex").map((item) => item.id), ["local", "github"]);
  });

  it("preserves all as an explicit host-wide local scope", () => {
    const config = {
      projects: [
        { repository: "owner/cms", environments: [{ id: "production", kind: "aws-ssm", instanceId: "i-cms" }] },
        { repository: "owner/finportex" },
      ],
      sources: [{ id: "github", kind: "github", repository: "owner/cms" }],
    };
    const projects = registeredProjects(config);
    assert.equal(resolveProjectId("all", projects, config), "all");
    assert.deepEqual(projectSourceConfigs(config, "all"), [{ id: "local", kind: "local", projectId: "all" }]);
  });

  it("maps legacy repository-prefixed Docker names to registered projects", () => {
    const projects = registeredProjects({
      projects: [
        { repository: "sdarpeng/SparklingCMS", aliases: ["sparklingplaycms", "SparklingCMS"] },
        { repository: "sdarpeng/FinPortEx", aliases: ["finportex"] },
        { repository: "sdarpeng/normalizer" },
      ],
    });
    assert.equal(canonicalProjectId("sparkling-cms-api", projects), "sdarpeng/SparklingCMS");
    assert.equal(canonicalProjectId("sparklingplaycms-api", projects), "sdarpeng/SparklingCMS");
    assert.equal(canonicalProjectId("finportex-ocr-audit", projects), "sdarpeng/FinPortEx");
    assert.equal(canonicalProjectId("normalizer-clean-deps-20260801-normalizer-api", projects), "sdarpeng/normalizer");
  });

  it("keeps SSH credentials as profile references on the owning project", () => {
    const config = {
      projects: [
        { repository: "owner/cms" },
        {
          repository: "owner/finportex",
          environments: [{
            id: "production",
            kind: "ssh",
            sshProfile: "finportex-prod",
            instanceId: "i-finportex",
          }],
        },
      ],
      sources: [],
    };
    const production = projectSourceConfigs(config, "owner/finportex").find((item) => item.id === "production");
    assert.equal(production.kind, "ssh");
    assert.equal(production.sshProfile, "finportex-prod");
    assert.equal(production.projectId, "owner/finportex");
    assert.equal(projectSourceConfigs(config, "owner/cms").some((item) => item.id === "production"), false);
  });

  it("returns the four dashboard capacity bands without mutating Docker", () => {
    const dashboard = collectDashboard();
    assert.equal(dashboard.selectedProject, "all");
    assert.equal(dashboard.scope, "host");
    assert.equal(dashboard.bars.length, 4);
    assert.deepEqual(dashboard.bars.map((item) => item.type), ["worktree", "image", "volume", "cache"]);
    assert.ok(Array.isArray(dashboard.assets));
    assert.ok(Array.isArray(dashboard.events));
  });

  it("requires exact asset IDs before a host-wide cleanup preview", () => {
    assert.throws(() => createCleanupPreview(), /Host-wide cleanup preview requires exact assetIds/);
  });

  it("applies an exact ledger retirement only with disposable and recovery evidence", () => {
    const imageId = "sha256:retired-image";
    const overrides = retirementOverrideLabels([
      {
        event: "asset.retired",
        status: "retired",
        project: "sparklingplaycms",
        environment: "local",
        owner: "platform-engineering",
        release: "bulk-upload-closed",
        gitSha: "abc123",
        asset: { type: "image", id: imageId },
        details: {
          disposable: "true",
          retention: "retired",
          recoverySource: "git:https://github.com/sdarpeng/SparklingCMS.git@abc123",
        },
      },
    ]);
    assert.equal(overrides.get(`image:${imageId}`)["com.codex.runtime.disposable"], "true");
    assert.equal(overrides.get(`image:${imageId}`)["com.codex.runtime.retention"], "retired");
    assert.match(overrides.get(`image:${imageId}`)["com.codex.runtime.recovery-source"], /abc123/);
  });

  it("accepts a synthetic test volume retirement with a content fingerprint", () => {
    const volumeId = "a".repeat(64);
    const overrides = retirementOverrideLabels([
      {
        event: "asset.retired",
        status: "retired",
        project: "sdarpeng/FinPortEx",
        environment: "local",
        owner: "platform-engineering",
        release: "integration-test-harness",
        gitSha: "abc123",
        asset: { type: "volume", id: volumeId },
        details: {
          disposable: "true",
          retention: "retired",
          recoverySource: "git:finportex@abc123; rerun integration test",
          dataClassification: "synthetic-test-fixture",
          contentFingerprint: `sha256:${"b".repeat(64)}`,
        },
      },
    ]);
    assert.equal(overrides.get(`volume:${volumeId}`)["com.codex.runtime.disposable"], "true");
    assert.equal(overrides.get(`volume:${volumeId}`)["com.codex.runtime.data-classification"], "synthetic-test-fixture");
  });

  it("fails closed for unattested volumes, missing recovery evidence, and revoked retirement", () => {
    const valid = {
      event: "asset.retired",
      status: "retired",
      project: "sparklingplaycms",
      environment: "local",
      owner: "platform-engineering",
      asset: { type: "image", id: "sha256:one" },
      details: { disposable: "true", retention: "retired", recoverySource: "git:abc" },
    };
    const overrides = retirementOverrideLabels([
      { ...valid, asset: { type: "volume", id: "database" } },
      { ...valid, asset: { type: "image", id: "sha256:missing" }, details: { disposable: "true", retention: "retired" } },
      valid,
      { event: "asset.retirement.revoked", asset: valid.asset },
    ]);
    assert.equal(overrides.size, 0);
  });

  it("removes every exact tag of a multi-tag image without force", () => {
    const args = localCleanupArgs({
      type: "image",
      id: "sha256:multi-tag",
      lineage: { tags: ["example/api:one", "example/api:two", "example/api:one"] },
    });
    assert.deepEqual(args, ["image", "rm", "example/api:one", "example/api:two"]);
    assert.equal(args.includes("--force"), false);
  });

  it("falls back to an exact image ID for a dangling image", () => {
    assert.deepEqual(localCleanupArgs({ type: "image", id: "sha256:dangling", lineage: { tags: ["<none>:<none>"] } }), ["image", "rm", "sha256:dangling"]);
  });
});
