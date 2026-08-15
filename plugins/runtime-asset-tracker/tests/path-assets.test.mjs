import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_RECONCILIATION_SCHEMA,
  canonicalPathContainment,
  discoverWorktreeAssets,
  executePathAssetCleanup,
  importPathRetirementReconciliation,
  pathAssetId,
  scanPathUsage,
  validatePathRetirementReconciliation,
} from "../mcp/path-assets.mjs";

function temporaryDirectory(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

describe("worktree and host artifact lifecycle", () => {
  it("expands Codex hash buckets into project roots without counting the bucket twice", () => {
    const sandbox = temporaryDirectory("tracker-codex-bucket");
    const codexHome = join(sandbox, ".codex");
    const project = join(codexHome, "worktrees", "a1b2", "ExampleProject");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "tracked.txt"), "bytes");
    const priorCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const assets = discoverWorktreeAssets({}, [], []);
      const roots = assets.filter((asset) => asset.type === "worktree_residual").map((asset) => asset.path);
      assert.deepEqual(roots.map((item) => item.toLowerCase()), [project.toLowerCase()]);
      assert.equal(roots.map((item) => item.toLowerCase()).includes(join(codexHome, "worktrees", "a1b2").toLowerCase()), false);
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("measures real bytes, identifies generated assets, and produces a stable fingerprint", () => {
    const root = temporaryDirectory("tracker-scan");
    try {
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(root, "source.js"), "source");
      writeFileSync(join(root, "node_modules", "pkg", "index.js"), "dependency");
      writeFileSync(join(root, "candidate-images.tar.gz"), Buffer.alloc(1024));
      const first = scanPathUsage(root);
      const second = scanPathUsage(root);
      assert.equal(first.sizeBytes, 6 + 10 + 1024);
      assert.equal(first.fingerprint, second.fingerprint);
      assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
      const dependency = first.artifacts.find((item) => item.path.endsWith("node_modules"));
      const archive = first.artifacts.find((item) => item.path.endsWith("candidate-images.tar.gz"));
      assert.ok(dependency);
      assert.ok(archive);
      assert.equal(scanPathUsage(dependency.path).fingerprint, dependency.fingerprint);
      executePathAssetCleanup({
        id: pathAssetId("host_artifact", archive.path),
        type: "host_artifact",
        path: archive.path,
        classification: "reclaimable",
        sizeBytes: archive.sizeBytes,
        lineage: { allowedRoot: root, contentFingerprint: archive.fingerprint },
      });
      assert.equal(existsSync(archive.path), false);
      assert.equal(existsSync(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts an artifact directory once and does not rediscover nested archives", () => {
    const root = temporaryDirectory("tracker-artifact-dedup");
    try {
      const execution = join(root, ".codex-execution-final", "stage");
      mkdirSync(execution, { recursive: true });
      writeFileSync(join(execution, "candidate.tar"), Buffer.alloc(2048));
      const scan = scanPathUsage(root);
      assert.equal(scan.artifacts.length, 1);
      assert.equal(scan.artifacts[0].path, join(root, ".codex-execution-final"));
      assert.equal(scan.artifacts[0].sizeBytes, 2048);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never exposes Git object files as independently removable host artifacts", () => {
    const root = temporaryDirectory("tracker-git-object-safety");
    try {
      const objectDirectory = join(root, ".git", "objects", "aa");
      mkdirSync(objectDirectory, { recursive: true });
      writeFileSync(join(objectDirectory, "large-object"), Buffer.alloc(1024));
      const scan = scanPathUsage(root, { largeFileBytes: 512 });
      assert.equal(scan.artifacts.length, 0);
      assert.equal(scan.sizeBytes, 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assigns sibling residuals to the longest repository path prefix", () => {
    const sandbox = temporaryDirectory("tracker-project-owner");
    const codexHome = join(sandbox, ".codex");
    const finportex = join(sandbox, "FinPortEx-Quarantine");
    const sparkling = join(sandbox, "SparklingPlayCMS-evidence");
    mkdirSync(join(codexHome, "worktrees"), { recursive: true });
    mkdirSync(finportex, { recursive: true });
    mkdirSync(sparkling, { recursive: true });
    const priorCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const projects = [
        { id: "owner/SparklingCMS", gitRoots: [join(sandbox, "SparklingPlayCMS")] },
        { id: "owner/FinPortEx", gitRoots: [join(sandbox, "FinPortEx")] },
      ];
      const assets = discoverWorktreeAssets({ worktreeRoots: [sandbox] }, projects, []);
      assert.equal(assets.find((asset) => asset.path.toLowerCase() === finportex.toLowerCase())?.project, "owner/FinPortEx");
      assert.equal(assets.find((asset) => asset.path.toLowerCase() === sparkling.toLowerCase())?.project, "owner/SparklingCMS");
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not follow directory junctions while scanning or deleting a residual", () => {
    const sandbox = temporaryDirectory("tracker-no-follow");
    const outside = join(sandbox, "outside");
    const root = join(sandbox, "allowed", "residual");
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "sentinel.bin"), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(join(root, "small.txt"), "safe");
    let junctionCreated = false;
    try {
      symlinkSync(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");
      junctionCreated = true;
      const scan = scanPathUsage(root);
      assert.ok(scan.sizeBytes < 2 * 1024 * 1024);
      assert.equal(scan.reparsePoints.length, 1);
      executePathAssetCleanup({
        id: pathAssetId("worktree_residual", root),
        type: "worktree_residual",
        path: root,
        classification: "reclaimable",
        sizeBytes: scan.sizeBytes,
        lineage: { path: root, allowedRoot: join(sandbox, "allowed"), contentFingerprint: scan.fingerprint },
      });
      assert.equal(existsSync(root), false);
      assert.equal(existsSync(join(outside, "sentinel.bin")), true);
    } finally {
      if (!junctionCreated && existsSync(root)) rmSync(root, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a junction or symlink in the allowed-root ancestry", () => {
    const sandbox = temporaryDirectory("tracker-canonical-root");
    const outside = join(sandbox, "outside");
    const victim = join(outside, "victim");
    const lexicalRoot = join(sandbox, "managed-link");
    mkdirSync(victim, { recursive: true });
    try {
      symlinkSync(outside, lexicalRoot, process.platform === "win32" ? "junction" : "dir");
      assert.equal(canonicalPathContainment(join(lexicalRoot, "victim"), lexicalRoot), false);
      assert.equal(existsSync(victim), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects vague retirement reports and imports exact path attestations idempotently", () => {
    const sandbox = temporaryDirectory("tracker-path-report");
    const state = join(sandbox, "state");
    const path = join(sandbox, "root", "worktree-v1");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "artifact.txt"), "retired");
    const scan = scanPathUsage(path);
    const report = {
      schemaVersion: PATH_RECONCILIATION_SCHEMA,
      readOnly: true,
      actionTaken: "none",
      target: { project: "owner/project" },
      assets: [{
        id: pathAssetId("worktree_residual", path),
        type: "worktree_residual",
        path,
        expectedBytes: scan.sizeBytes,
        contentFingerprint: scan.fingerprint,
        disposable: true,
        retention: "retired",
        recoverySource: "git:https://github.com/owner/project.git@abc123",
        confidence: "high-exact",
      }],
    };
    const invalid = structuredClone(report);
    invalid.assets[0].recoverySource = "";
    assert.equal(validatePathRetirementReconciliation(invalid).ok, false);
    const reportPath = join(sandbox, "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const priorState = process.env.RUNTIME_ASSET_STATE_DIR;
    process.env.RUNTIME_ASSET_STATE_DIR = state;
    try {
      const first = importPathRetirementReconciliation({ reportPath });
      const second = importPathRetirementReconciliation({ reportPath });
      assert.equal(first.retirementEventsAdded, 1);
      assert.equal(second.retirementEventsAdded, 0);
      const events = readFileSync(join(state, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(events[0].details.expectedBytes, scan.sizeBytes);
      assert.equal(events[0].details.contentFingerprint, scan.fingerprint);
    } finally {
      if (priorState === undefined) delete process.env.RUNTIME_ASSET_STATE_DIR;
      else process.env.RUNTIME_ASSET_STATE_DIR = priorState;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
