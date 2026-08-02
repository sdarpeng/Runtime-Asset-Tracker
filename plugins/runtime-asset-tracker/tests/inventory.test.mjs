import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectDashboard, createCleanupPreview, parseBytes } from "../mcp/inventory.mjs";

describe("runtime asset dashboard inventory", () => {
  it("parses Docker size units and clamps invalid negative values", () => {
    assert.equal(parseBytes("1.5GB"), 1_500_000_000);
    assert.equal(parseBytes("512MiB"), 512 * 1024 * 1024);
    assert.equal(parseBytes("-6.1GB"), 0);
  });

  it("returns the four dashboard capacity bands without mutating Docker", () => {
    const dashboard = collectDashboard();
    assert.equal(dashboard.bars.length, 4);
    assert.deepEqual(dashboard.bars.map((item) => item.type), ["worktree", "image", "volume", "cache"]);
    assert.ok(Array.isArray(dashboard.assets));
    assert.ok(Array.isArray(dashboard.events));
  });

  it("creates an exact preview containing only explicitly disposable assets", () => {
    const preview = createCleanupPreview();
    assert.ok(preview.token);
    assert.ok(Array.isArray(preview.allowlist));
    assert.ok(preview.allowlist.every((item) => ["container", "image", "volume"].includes(item.type)));
  });
});
