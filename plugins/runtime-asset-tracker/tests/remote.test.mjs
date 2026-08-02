import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { collectRemoteDashboard, remoteSnapshotScript } from "../mcp/remote.mjs";

describe("remote read-only adapters", () => {
  it("keeps the EC2 collector free of cleanup and service mutation commands", () => {
    const script = remoteSnapshotScript();
    assert.doesNotMatch(script, /docker\s+(system\s+)?prune|docker\s+(image|volume|container)?\s*rm|systemctl|\brm\s+-/i);
    assert.match(script, /docker_available/);
    assert.match(script, /shutil\.disk_usage/);
  });

  it("fails closed when a remote source is not configured", () => {
    const result = collectRemoteDashboard({
      source: "production",
      scope: "environment",
      project: "all",
      config: { sources: [] },
      sources: [],
    });
    assert.equal(result.remoteSnapshotAvailable, false);
    assert.equal(result.assets.length, 0);
    assert.match(result.remoteError, /尚未配置/);
  });

  it("uses the product title instead of the scaffold title", () => {
    const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
    assert.match(html, /<title>Runtime Asset Tracker<\/title>/);
    assert.doesNotMatch(html, /<title>Prototype<\/title>/);
  });
});
