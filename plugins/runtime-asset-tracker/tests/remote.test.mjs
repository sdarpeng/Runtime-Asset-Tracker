import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { awsBuildCacheCleanupScript, buildBars, classifyGithubAsset, collectRemoteDashboard, remoteSnapshotScript } from "../mcp/remote.mjs";

describe("remote read-only adapters", () => {
  it("keeps the EC2 collector free of cleanup and service mutation commands", () => {
    const script = remoteSnapshotScript();
    assert.doesNotMatch(script, /docker\s+(system\s+)?prune|docker\s+(image|volume|container)?\s*rm|systemctl|\brm\s+-/i);
    assert.match(script, /docker_available/);
    assert.match(script, /shutil\.disk_usage/);
  });

  it("maps Docker-reported Build Cache reclaimable bytes into the safe segment", () => {
    const bars = buildBars([], {
      "Build Cache": { totalCount: 999, sizeBytes: 7_894_000_000, reclaimableBytes: 7_894_000_000 },
    });
    const cache = bars.find((item) => item.type === "cache");
    assert.equal(cache.reclaimableBytes, 7_894_000_000);
    assert.equal(cache.retainedBytes, 0);
    assert.equal(cache.count, 999);
  });

  it("limits EC2 cleanup to unused Build Cache", () => {
    const script = awsBuildCacheCleanupScript();
    assert.match(script, /docker builder prune --all --force/);
    assert.doesNotMatch(script, /system prune|image prune|volume prune|container prune|\brm\b/i);
  });

  it("only classifies expired artifacts, closed PR caches, and 30-day stale caches as safe", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: true, now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: false, now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/74/merge", pullState: "closed", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/75/merge", pullState: "open", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/heads/master", lastAccessedAt: "2026-06-01T00:00:00Z", now }), "reclaimable");
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

  it("enables immediate cleanup for every connected source in the UI", () => {
    const source = readFileSync(new URL("../ui/src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /preview_cleanup", \{ source, types:/);
    assert.doesNotMatch(source, /disabled=\{source !== "local"\} onClick=\{requestPreview\}/);
    assert.match(source, /disabled=\{!snapshotOnline \|\| loading\} onClick=\{requestPreview\}/);
  });
});
