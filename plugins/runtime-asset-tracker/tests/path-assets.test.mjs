import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_RECONCILIATION_SCHEMA,
  canonicalPathContainment,
  discoverWorktreeAssets,
  executePathAssetCleanup,
  importPathRetirementReconciliation,
  pathAssetId,
  pathCleanupEvidence,
  safeDeleteHelperIntegrity,
  scanPathUsage,
  validatePathRetirementReconciliation,
} from "../mcp/path-assets.mjs";

function temporaryDirectory(name) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `${name}-`)));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
      const cleanupAsset = {
        id: pathAssetId("host_artifact", archive.path),
        type: "host_artifact",
        path: archive.path,
        classification: "reclaimable",
        sizeBytes: archive.sizeBytes,
        lineage: { allowedRoot: root, contentFingerprint: archive.fingerprint },
      };
      executePathAssetCleanup(cleanupAsset);
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
      const cleanupAsset = {
        id: pathAssetId("worktree_residual", root),
        type: "worktree_residual",
        path: root,
        classification: "reclaimable",
        sizeBytes: scan.sizeBytes,
        lineage: { path: root, allowedRoot: join(sandbox, "allowed"), contentFingerprint: scan.fingerprint },
      };
      executePathAssetCleanup(cleanupAsset);
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

  it("fails closed when the allowed root is replaced after preview validation", () => {
    const sandbox = temporaryDirectory("tracker-ancestry-race");
    const allowed = join(sandbox, "allowed");
    const holding = join(sandbox, "allowed-original");
    const target = join(allowed, "retired");
    const outside = join(sandbox, "outside");
    const outsideTarget = join(outside, "retired");
    mkdirSync(target, { recursive: true });
    mkdirSync(outsideTarget, { recursive: true });
    writeFileSync(join(target, "inside.txt"), "inside");
    writeFileSync(join(outsideTarget, "sentinel.txt"), "outside");
    const scan = scanPathUsage(target);
    try {
      const cleanup = () => executePathAssetCleanup({
        id: pathAssetId("worktree_residual", target),
        type: "worktree_residual",
        path: target,
        classification: "reclaimable",
        sizeBytes: scan.sizeBytes,
        lineage: { path: target, allowedRoot: allowed, contentFingerprint: scan.fingerprint },
      }, {
        beforeIsolation() {
          renameSync(allowed, holding);
          symlinkSync(outside, allowed, process.platform === "win32" ? "junction" : "dir");
        },
      });
      assert.throws(cleanup, /ancestry changed|canonical allowed root/i);
      assert.equal(existsSync(join(outsideTarget, "sentinel.txt")), true);
      assert.equal(existsSync(join(holding, "retired", "inside.txt")), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("makes an exact Windows filesystem attestation executable only with the provenance-bound helper", () => {
    const sandbox = temporaryDirectory("tracker-windows-path-helper");
    const root = join(sandbox, "managed");
    const target = join(root, "residual-v1");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "artifact.txt"), "retired");
    const scan = scanPathUsage(target);
    const event = {
      event: "asset.retired",
      status: "retired",
      asset: { type: "worktree_residual", id: pathAssetId("worktree_residual", target) },
      details: {
        disposable: "true",
        retention: "retired",
        path: target,
        expectedBytes: scan.sizeBytes,
        contentFingerprint: scan.fingerprint,
        recoverySource: "git:https://github.com/owner/project.git@" + "a".repeat(40),
      },
    };
    try {
      const asset = discoverWorktreeAssets({ residualRoots: [root], pathScan: { cacheTtlMs: 0 } }, [], [event]).find((item) => item.path.toLowerCase() === target.toLowerCase());
      assert.ok(asset);
      assert.equal(asset.classification, "reclaimable");
      assert.notEqual(asset.retirementBlocked, true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a same-path Windows target replacement after live validation", () => {
    if (process.platform !== "win32") return;
    const sandbox = temporaryDirectory("tracker-windows-target-race");
    const root = join(sandbox, "managed");
    const target = join(root, "retired");
    const holding = join(root, "retired-original");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "artifact.txt"), "same-bytes");
    const scan = scanPathUsage(target);
    try {
      const cleanup = () => executePathAssetCleanup({
        id: pathAssetId("worktree_residual", target),
        type: "worktree_residual",
        path: target,
        classification: "reclaimable",
        sizeBytes: scan.sizeBytes,
        lineage: { path: target, allowedRoot: root, contentFingerprint: scan.fingerprint },
      }, {
        beforeHandleOpen() {
          renameSync(target, holding);
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "artifact.txt"), "same-bytes");
        },
      });
      assert.throws(cleanup, /identity changed after preview validation/i);
      assert.equal(existsSync(join(holding, "artifact.txt")), true);
      assert.equal(existsSync(join(target, "artifact.txt")), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a same-path Windows managed-root replacement before native handle open", () => {
    if (process.platform !== "win32") return;
    const sandbox = temporaryDirectory("tracker-windows-root-race");
    const root = join(sandbox, "managed");
    const holding = join(sandbox, "managed-original");
    const target = join(root, "retired");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "artifact.txt"), "same-bytes");
    const scan = scanPathUsage(target);
    try {
      const cleanup = () => executePathAssetCleanup({
        id: pathAssetId("worktree_residual", target),
        type: "worktree_residual",
        path: target,
        classification: "reclaimable",
        sizeBytes: scan.sizeBytes,
        lineage: { path: target, allowedRoot: root, contentFingerprint: scan.fingerprint },
      }, {
        beforeHandleOpen() {
          renameSync(root, holding);
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "artifact.txt"), "same-bytes");
        },
      });
      assert.throws(cleanup, /managed root identity changed after preview validation/i);
      assert.equal(existsSync(join(holding, "retired", "artifact.txt")), true);
      assert.equal(existsSync(join(target, "artifact.txt")), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("removes an exact clean registered worktree and only its bound Git metadata", () => {
    const sandbox = temporaryDirectory("tracker-registered-worktree");
    const primary = join(sandbox, "project");
    const target = join(sandbox, "project-retired");
    const priorCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(sandbox, ".codex");
    mkdirSync(join(process.env.CODEX_HOME, "worktrees"), { recursive: true });
    mkdirSync(primary, { recursive: true });
    try {
      git(["init"], primary);
      git(["config", "user.name", "Runtime Asset Tracker Test"], primary);
      git(["config", "user.email", "tracker-test@example.invalid"], primary);
      writeFileSync(join(primary, "tracked.txt"), "recoverable");
      git(["add", "tracked.txt"], primary);
      git(["commit", "-m", "test fixture"], primary);
      git(["worktree", "add", "-b", "retired-test", target], primary);
      const scan = scanPathUsage(target);
      const event = {
        event: "asset.retired",
        status: "retired",
        asset: { type: "worktree", id: pathAssetId("worktree", target) },
        details: {
          disposable: "true",
          retention: "retired",
          path: target,
          expectedBytes: scan.sizeBytes,
          contentFingerprint: scan.fingerprint,
          recoverySource: `git:${primary}@${git(["rev-parse", "HEAD"], primary)}`,
        },
      };
      const discovered = discoverWorktreeAssets(
        { gitRoots: [primary], worktreeRoots: [sandbox], pathScan: { cacheTtlMs: 0 } },
        [{ id: "owner/project", gitRoots: [primary] }],
        [event],
      );
      const asset = discovered.find((item) => item.type === "worktree" && item.path.toLowerCase() === target.toLowerCase());
      assert.ok(asset, JSON.stringify(discovered.map((item) => ({ type: item.type, path: item.path, reason: item.reason }))));
      assert.equal(asset.classification, "reclaimable");
      assert.equal(asset.lineage.worktreeRemoval.ok, true);
      const approvedEvidence = pathCleanupEvidence(asset);
      assert.equal(approvedEvidence.path, process.platform === "win32" ? target.toLowerCase() : target);
      assert.equal(approvedEvidence.worktreeRemoval.metadataPath, process.platform === "win32" ? asset.lineage.worktreeRemoval.metadataPath.toLowerCase() : asset.lineage.worktreeRemoval.metadataPath);
      const metadataPath = asset.lineage.worktreeRemoval.metadataPath;
      assert.equal(existsSync(metadataPath), true);
      executePathAssetCleanup(asset);
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(metadataPath), false);
      assert.equal(git(["worktree", "list", "--porcelain"], primary).toLowerCase().includes(target.toLowerCase()), false);
      assert.equal(existsSync(join(primary, "tracked.txt")), true);
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly locked registered worktree non-executable", () => {
    const sandbox = temporaryDirectory("tracker-locked-worktree");
    const primary = join(sandbox, "project");
    const target = join(sandbox, "project-retired");
    const priorCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(sandbox, ".codex");
    mkdirSync(join(process.env.CODEX_HOME, "worktrees"), { recursive: true });
    mkdirSync(primary, { recursive: true });
    try {
      git(["init"], primary);
      git(["config", "user.name", "Runtime Asset Tracker Test"], primary);
      git(["config", "user.email", "tracker-test@example.invalid"], primary);
      writeFileSync(join(primary, "tracked.txt"), "recoverable");
      git(["add", "tracked.txt"], primary);
      git(["commit", "-m", "test fixture"], primary);
      git(["worktree", "add", "-b", "locked-test", target], primary);
      git(["worktree", "lock", "--reason", "operator-protected", target], primary);
      const scan = scanPathUsage(target);
      const event = {
        event: "asset.retired",
        status: "retired",
        asset: { type: "worktree", id: pathAssetId("worktree", target) },
        details: { disposable: "true", retention: "retired", path: target, expectedBytes: scan.sizeBytes, contentFingerprint: scan.fingerprint, recoverySource: "git:locked-fixture" },
      };
      const discovered = discoverWorktreeAssets(
        { gitRoots: [primary], worktreeRoots: [sandbox], pathScan: { cacheTtlMs: 0 } },
        [{ id: "owner/project", gitRoots: [primary] }],
        [event],
      );
      const asset = discovered.find((item) => item.type === "worktree" && item.path.toLowerCase() === target.toLowerCase());
      assert.ok(asset, JSON.stringify(discovered.map((item) => ({ type: item.type, path: item.path, reason: item.reason }))));
      assert.equal(asset.classification, "review");
      assert.equal(asset.retirementBlocked, true);
      assert.match(asset.reason, /explicitly locked/i);
      assert.equal(existsSync(target), true);
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uses provenance-bound handle-relative helpers instead of recursive string paths", () => {
    const posixHelper = readFileSync(new URL("../scripts/safe-delete-path.py", import.meta.url), "utf8");
    assert.match(posixHelper, /os\.O_DIRECTORY \| os\.O_NOFOLLOW/);
    assert.match(posixHelper, /dir_fd=parent_fd/);
    assert.match(posixHelper, /os\.listdir\(directory_fd\)/);
    assert.match(posixHelper, /follow_symlinks=False/);
    assert.match(posixHelper, /mnt_id:/);
    assert.match(posixHelper, /mount transition/i);
    assert.doesNotMatch(posixHelper, /shutil\.rmtree|os\.walk/);
    const windowsHelper = readFileSync(new URL("../scripts/safe-delete-path-windows.ps1", import.meta.url), "utf8");
    assert.match(windowsHelper, /NtCreateFile/);
    assert.match(windowsHelper, /RootDirectory = parent\.DangerousGetHandle\(\)/);
    assert.match(windowsHelper, /FILE_OPEN_REPARSE_POINT/);
    assert.match(windowsHelper, /NtQueryDirectoryFile/);
    assert.match(windowsHelper, /FileIdBothDirectoryInformation/);
    assert.match(windowsHelper, /childIdentity\.FileId != entry\.FileId/);
    assert.match(windowsHelper, /SetFileInformationByHandle/);
    assert.doesNotMatch(windowsHelper, /FILE_SHARE_WRITE/);
    assert.doesNotMatch(windowsHelper, /Remove-Item|rmSync|Directory\.Delete|File\.Delete/);
    const integrity = safeDeleteHelperIntegrity();
    assert.equal(typeof integrity.ok, "boolean");
    assert.match(String(integrity.observedSha256 || integrity.reason), /[0-9a-f]{64}|provenance/i);
    const source = readFileSync(new URL("../mcp/path-assets.mjs", import.meta.url), "utf8");
    assert.match(source, /"-c", helperSource/);
    assert.match(source, /input: helperSource/);
    assert.match(source, /executionSha256 !== integrity\.declaredSha256/);
    const inventorySource = readFileSync(new URL("../mcp/inventory.mjs", import.meta.url), "utf8");
    assert.match(inventorySource, /pathEvidence:.*pathCleanupEvidence/);
    assert.match(inventorySource, /requested\.pathEvidence.*pathCleanupEvidence\(asset\)/s);
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
