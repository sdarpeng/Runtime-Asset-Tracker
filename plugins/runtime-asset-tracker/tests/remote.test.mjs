import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { awsBuildCacheCleanupScript, awsDockerCleanupScript, buildBars, buildGithubBars, classifyDockerImage, classifyDockerVolume, classifyGithubAsset, collectRemoteDashboard, remoteSnapshotScript } from "../mcp/remote.mjs";

describe("remote read-only adapters", () => {
  it("keeps the EC2 collector free of cleanup and service mutation commands", () => {
    const script = remoteSnapshotScript();
    assert.doesNotMatch(script, /docker\s+(system\s+)?prune|docker\s+(image|volume|container)?\s*rm|systemctl|\brm\s+-/i);
    assert.match(script, /docker_available/);
    assert.match(script, /shutil\.disk_usage/);
  });

  it("scopes remote release discovery to the selected project configuration", () => {
    const script = remoteSnapshotScript({
      projectId: "owner/finportex",
      id: "production",
      activeLink: "/home/ubuntu/apps/finportex",
      releaseRoot: "",
    });
    const encoded = script.match(/CONTEXT = json\.loads\(base64\.b64decode\("([^"]+)"\)\)/)?.[1];
    assert.ok(encoded);
    const context = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(context.project, "owner/finportex");
    assert.equal(context.activeLink, "/home/ubuntu/apps/finportex");
    assert.equal(context.releaseRoot, "");
    assert.match(script, /"project":DEFAULT_PROJECT/);
  });

  it("uses OpenSSH profile references without embedding private-key material", () => {
    const source = readFileSync(new URL("../mcp/remote.mjs", import.meta.url), "utf8");
    assert.match(source, /function collectSshSnapshot/);
    assert.match(source, /"BatchMode=yes"/);
    assert.match(source, /"StrictHostKeyChecking=yes"/);
    assert.match(source, /sourceConfig\.sshProfile/);
    assert.doesNotMatch(source, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
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

  it("classifies only unreferenced dangling or disposable images as safely reclaimable", () => {
    assert.equal(classifyDockerImage({ referenced: true, dangling: true }), "active");
    assert.equal(classifyDockerImage({ dangling: true }), "reclaimable");
    assert.equal(classifyDockerImage({ labels: { "com.codex.runtime.disposable": "true" } }), "reclaimable");
    assert.equal(classifyDockerImage({ labels: { "com.codex.runtime.disposable": "false" }, dangling: true }), "protected");
    assert.equal(classifyDockerImage({ dangling: false }), "retained");
  });

  it("requires zero references and an explicit disposable label for safe volume cleanup", () => {
    const disposable = { "com.codex.runtime.disposable": "true" };
    assert.equal(classifyDockerVolume({ labels: disposable, referenced: true }), "active");
    assert.equal(classifyDockerVolume({ labels: disposable }), "reclaimable");
    assert.equal(classifyDockerVolume({ labels: disposable, protectedName: true }), "protected");
    assert.equal(classifyDockerVolume({}), "review");
  });

  it("maps exact safe image unique bytes and volume bytes into their chart segments", () => {
    const bars = buildBars([
      { type: "image", classification: "reclaimable", sizeBytes: 125 },
      { type: "image", classification: "retained", sizeBytes: 75 },
      { type: "volume", classification: "reclaimable", sizeBytes: 40 },
      { type: "volume", classification: "protected", sizeBytes: 60 },
    ], {
      Images: { totalCount: 2, sizeBytes: 250, reclaimableBytes: 200 },
      "Local Volumes": { totalCount: 2, sizeBytes: 100, reclaimableBytes: 40 },
    });
    assert.equal(bars.find((item) => item.type === "image").reclaimableBytes, 125);
    assert.equal(bars.find((item) => item.type === "volume").reclaimableBytes, 40);
  });

  it("limits EC2 cleanup to unused Build Cache", () => {
    const script = awsBuildCacheCleanupScript();
    assert.match(script, /docker builder prune --all --force/);
    assert.doesNotMatch(script, /system prune|image prune|volume prune|container prune|\brm\b/i);
  });

  it("uses exact non-force image and volume removal with a second reference check", () => {
    const script = awsDockerCleanupScript([
      { type: "image", id: "sha256:abc", name: "dangling", sizeBytes: 12 },
      { type: "volume", id: "temporary_cache", name: "temporary_cache", sizeBytes: 34 },
    ]);
    assert.match(script, /ancestor=/);
    assert.match(script, /volume=/);
    assert.match(script, /\["image", "rm", identifier\]/);
    assert.match(script, /\["volume", "rm", identifier\]/);
    assert.match(script, /com\.codex\.runtime\./);
    assert.doesNotMatch(script, /system.+prune|image.+prune|volume.+prune|\["image", "rm", "--force"|\["volume", "rm", "--force"/i);
  });

  it("only classifies expired artifacts, closed PR caches, and 30-day stale caches as safe", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: true, now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: false, now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/74/merge", pullState: "closed", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/75/merge", pullState: "open", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/heads/master", lastAccessedAt: "2026-06-01T00:00:00Z", now }), "reclaimable");
  });

  it("uses GitHub-native categories instead of Docker categories", () => {
    const bars = buildGithubBars([
      { type: "pull_request", classification: "active", sizeBytes: 1 },
      { type: "pull_request", classification: "retained", sizeBytes: 1 },
      { type: "artifact", classification: "reclaimable", sizeBytes: 120 },
      { type: "actions_cache", classification: "retained", sizeBytes: 300 },
      { type: "workflow_run", classification: "active", sizeBytes: 1 },
    ]);
    assert.deepEqual(bars.map((item) => item.type), ["pull_request", "artifact", "actions_cache", "workflow_run"]);
    assert.equal(bars.find((item) => item.type === "pull_request").unit, "count");
    assert.equal(bars.find((item) => item.type === "pull_request").activeBytes, 1);
    assert.equal(bars.find((item) => item.type === "artifact").reclaimableBytes, 120);
    assert.equal(bars.find((item) => item.type === "actions_cache").totalBytes, 300);
    assert.equal(bars.find((item) => item.type === "workflow_run").unit, "count");
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
    assert.match(source, /preview_cleanup", \{ source, project: effectiveProject, types:/);
    assert.doesNotMatch(source, /disabled=\{source !== "local"\} onClick=\{requestPreview\}/);
    assert.match(source, /disabled=\{!snapshotOnline \|\| loading\} onClick=\{requestPreview\}/);
  });

  it("uses one global project selector and renders GitHub delivery categories", () => {
    const source = readFileSync(new URL("../ui/src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /pull_request: \{ label: "Pull Requests"/);
    assert.match(source, /artifact: \{ label: "Actions Artifacts"/);
    assert.match(source, /actions_cache: \{ label: "Actions Cache"/);
    assert.match(source, /workflow_run: \{ label: "Workflow Runs"/);
    assert.match(source, /next === "github" \? "pull_request" : "image"/);
    assert.match(source, /Open \/ Draft PR/);
    assert.doesNotMatch(source, /className="repository-toolbar card"/);
    assert.doesNotMatch(source, /className="repository-picker"/);
    assert.doesNotMatch(source, /scope-toggle/);
    assert.doesNotMatch(source, /selectScope/);
    assert.doesNotMatch(source, /repository-metric/);
    assert.match(source, />当前项目（全局）</);
    assert.match(source, /projectOptions\.map/);
    assert.match(source, /setSource\("local"\)/);
    assert.doesNotMatch(source, /setProject\("all"\)/);
  });

  it("renders project-bound EC2 identity and disk capacity KPIs", () => {
    const source = readFileSync(new URL("../ui/src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /AWS Account ID/);
    assert.match(source, /凭据引用/);
    assert.match(source, /EC2 根盘容量/);
    assert.match(source, /总空间/);
    assert.match(source, /已使用/);
    assert.match(source, /剩余空间/);
    assert.match(source, /使用率/);
    assert.match(source, /私钥、密码、Access Key 与会话令牌不会进入/);
    assert.match(source, /disk: \{ totalBytes: 0, freeBytes: 0 \}/);
  });
});
