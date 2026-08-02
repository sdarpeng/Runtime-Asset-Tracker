import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectDashboard, createCleanupPreview, normalizeGithubRepository, parseBytes, registeredProjects } from "../mcp/inventory.mjs";

describe("runtime asset dashboard inventory", () => {
  it("parses Docker size units and clamps invalid negative values", () => {
    assert.equal(parseBytes("1.5GB"), 1_500_000_000);
    assert.equal(parseBytes("512MiB"), 512 * 1024 * 1024);
    assert.equal(parseBytes("-6.1GB"), 0);
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

  it("returns the four dashboard capacity bands without mutating Docker", () => {
    const dashboard = collectDashboard();
    assert.equal(dashboard.bars.length, 4);
    assert.deepEqual(dashboard.bars.map((item) => item.type), ["worktree", "image", "volume", "cache"]);
    assert.ok(Array.isArray(dashboard.assets));
    assert.ok(Array.isArray(dashboard.events));
  });

  it("creates an exact preview containing only assets that passed the safe classifier", () => {
    const preview = createCleanupPreview();
    assert.ok(preview.token);
    assert.ok(Array.isArray(preview.allowlist));
    assert.ok(preview.allowlist.every((item) => ["container", "image", "volume", "cache"].includes(item.type)));
  });
});
