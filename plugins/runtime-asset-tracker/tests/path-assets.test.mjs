import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_RECONCILIATION_SCHEMA,
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
