import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { awsBuildCacheCleanupScript, awsDockerCleanupScript, buildBars, buildGithubBars, classifyDockerImage, classifyDockerVolume, classifyGithubAsset, collectRemoteDashboard, decodeSnapshotPayload, remoteSnapshotScript, resolveExpiry, ssmMutationCommand } from "../mcp/remote.mjs";

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
    assert.match(script, /return label\(labels, "project"\) or DEFAULT_PROJECT or fallback or "unknown"/);
    assert.match(script, /"composeProject":labels\.get\("com\.docker\.compose\.project"\)/);
  });

  it("stages oversized SSM snapshots in a private file for checksum-verified chunk reads", () => {
    const script = remoteSnapshotScript({ transportPath: "/tmp/runtime-asset-tracker-test.b64" });
    assert.match(script, /len\(encoded_payload\) > 16000/);
    assert.match(script, /os\.O_WRONLY \| os\.O_CREAT \| os\.O_TRUNC, 0o600/);
    assert.match(script, /RAT2:%d:%s/);
    assert.match(script, /hashlib\.sha256/);
    const source = readFileSync(new URL("../mcp/remote.mjs", import.meta.url), "utf8");
    assert.match(source, /const chunkSize = 16_000/);
    assert.match(source, /os\.path\.exists\(p\) and os\.remove\(p\)/);
    assert.doesNotMatch(source, /snapshot temp cleanup[^\n]+\brm\b/);
  });

  it("rejects truncated or corrupted chunked snapshot payloads", () => {
    const value = { host: "staging", assets: [{ id: "asset-1" }] };
    const encoded = gzipSync(JSON.stringify(value)).toString("base64");
    const sha256 = createHash("sha256").update(encoded, "ascii").digest("hex");
    assert.deepEqual(decodeSnapshotPayload(encoded, { expectedLength: encoded.length, expectedSha256: sha256 }), value);
    assert.throws(() => decodeSnapshotPayload(encoded.slice(0, -4), { expectedLength: encoded.length, expectedSha256: sha256 }), /长度不一致/);
    assert.throws(() => decodeSnapshotPayload(`${encoded.slice(0, -1)}A`, { expectedLength: encoded.length, expectedSha256: sha256 }), /校验失败/);
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

  it("separates near-expiry capacity without making it cleanup eligible", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    const labels = {
      "com.codex.runtime.disposable": "true",
      "com.codex.runtime.expires-at": "2026-08-05T12:00:00Z",
    };
    assert.equal(classifyDockerImage({ labels, now }), "expiring");
    assert.equal(classifyDockerVolume({ labels, now }), "expiring");
    assert.equal(resolveExpiry({ labels }), "2026-08-05T12:00:00.000Z");
    assert.equal(classifyDockerVolume({ labels: { ...labels, "com.codex.runtime.disposable": "false" }, now }), "protected");
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

  it("reports expiring bytes independently from retained and reclaimable bytes", () => {
    const bars = buildBars([
      { type: "image", classification: "expiring", sizeBytes: 50 },
      { type: "image", classification: "retained", sizeBytes: 75 },
      { type: "image", classification: "reclaimable", sizeBytes: 25 },
    ], { Images: { totalCount: 3, sizeBytes: 150, reclaimableBytes: 25 } });
    const images = bars.find((item) => item.type === "image");
    assert.equal(images.expiringBytes, 50);
    assert.equal(images.retainedBytes, 75);
    assert.equal(images.reclaimableBytes, 25);
  });

  it("limits EC2 cleanup to unused Build Cache", () => {
    const script = awsBuildCacheCleanupScript();
    assert.match(script, /docker builder prune --all --force/);
    assert.doesNotMatch(script, /system prune|image prune|volume prune|container prune|\brm\b/i);
  });

  it("uses exact non-force image and volume removal with a second reference check", () => {
    const script = awsDockerCleanupScript([
      {
        type: "image", id: "sha256:abc", name: "retired", sizeBytes: 12,
        tags: ["example/api:retired"], revision: "a".repeat(40),
        retirementEvidence: {
          reportSha256: "b".repeat(64), group: "closed-line",
          approvedTags: ["example/api:retired"], revision: "a".repeat(40),
        },
      },
      { type: "volume", id: "temporary_cache", name: "temporary_cache", sizeBytes: 34 },
    ]);
    assert.match(script, /ancestor=/);
    assert.match(script, /volume=/);
    assert.match(script, /\["image", "rm"\].+requested_tags/);
    assert.match(script, /\["volume", "rm", identifier\]/);
    assert.match(script, /inspect\("image", identifier\) is None/);
    assert.match(script, /com\.codex\.runtime\./);
    assert.doesNotMatch(script, /system.+prune|image.+prune|volume.+prune|\["image", "rm", "--force"|\["volume", "rm", "--force"/i);
    const encodedPayload = script.match(/items = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)/)?.[1];
    assert.ok(encodedPayload);
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"));
    assert.deepEqual(payload[0].tags, ["example/api:retired"]);
    assert.equal(payload[0].retirementEvidence.reportSha256, "b".repeat(64));
    assert.deepEqual(payload[0].retirementEvidence.approvedTags, ["example/api:retired"]);
    assert.equal(payload[0].retirementEvidence.revision, "a".repeat(40));
  });

  it("gzip-bounds a 29-image retirement command below the SSM command safety limit", () => {
    const allowlist = Array.from({ length: 29 }, (_, index) => ({
      type: "image",
      id: `sha256:${String((index % 10)).repeat(64)}`,
      name: `retired-${index}`,
      sizeBytes: 7_990_000_000,
      tags: [`example/api:candidate-${index}-20260814T120000Z`],
      revision: String((index + 1) % 10).repeat(40),
      retirementEvidence: {
        reportSha256: "e".repeat(64),
        group: index < 14 ? "closed-bulk-upload" : "superseded-transcode-chain",
        approvedTags: [`example/api:candidate-${index}-20260814T120000Z`],
        revision: String((index + 1) % 10).repeat(40),
      },
    }));
    const python = awsDockerCleanupScript(allowlist);
    const inner = ssmMutationCommand(`echo '${Buffer.from(python).toString("base64")}' | base64 -d | python3`);
    assert.ok(Buffer.byteLength(inner, "utf8") < 20_000, `compressed command was ${Buffer.byteLength(inner, "utf8")} bytes`);
    assert.match(inner, /gzip -d \| bash$/);
  });

  it("only classifies expired artifacts, closed PR caches, and 30-day stale caches as safe", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: true, now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: false, now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/74/merge", pullState: "closed", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/pull/75/merge", pullState: "open", lastAccessedAt: "2026-08-02T11:00:00Z", now }), "retained");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/heads/master", lastAccessedAt: "2026-06-01T00:00:00Z", now }), "reclaimable");
    assert.equal(classifyGithubAsset({ kind: "artifact", expired: false, expiresAt: "2026-08-05T12:00:00Z", now }), "expiring");
    assert.equal(classifyGithubAsset({ kind: "actions-cache", ref: "refs/heads/master", lastAccessedAt: "2026-07-08T00:00:00Z", now }), "expiring");
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
    assert.match(source, /disabled=\{!snapshotOnline \|\| loading \|\| deepScanning\} onClick=\{requestPreview\}/);
  });

  it("renders expiring capacity and a read-only deep scan before cleanup actions", () => {
    const source = readFileSync(new URL("../ui/src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /expiring: \{ label: "即将到期"/);
    assert.match(source, /deep_scan_runtime_lineage/);
    assert.match(source, /即将到期仍不会进入清理清单/);
    assert.ok(source.indexOf(">深度检索<") < source.indexOf(">定时清理<"));
    assert.ok(source.indexOf(">定时清理<") < source.indexOf(">立即清理<"));
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
