import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendCleanupEvent, readAuthoritativeLedgerEvents, retirementOverrideLabels } from "../mcp/inventory.mjs";

function event(kind, environment, details = {}) {
  return {
    schemaVersion: 1,
    eventId: `${kind}-${environment}-${Math.random()}`,
    occurredAt: "2026-08-14T00:00:00Z",
    event: kind,
    project: "cms",
    environment,
    owner: "platform",
    status: kind === "asset.protection.bound" ? "protected" : "retired",
    asset: { type: "image", id: "sha256:shared" },
    details: {
      disposable: "true",
      retention: "retired",
      recoverySource: "git:cms@abc",
      ...details,
    },
  };
}

describe("authoritative ledger state", () => {
  it("does not let staging retirement authorize a local image", () => {
    const staging = event("asset.retired", "staging");
    assert.equal(retirementOverrideLabels([staging], { project: "cms", environment: "local" }).size, 0);
    assert.equal(retirementOverrideLabels([staging], { project: "cms", environment: "staging" }).size, 1);
  });

  it("makes protection win over retirement regardless of event order", () => {
    const retirement = event("asset.retired", "local");
    const protection = event("asset.protection.bound", "local", { reason: "rollback" });
    for (const events of [[retirement, protection], [protection, retirement]]) {
      const labels = retirementOverrideLabels(events, { project: "cms", environment: "local" }).get("image:sha256:shared");
      assert.equal(labels["com.codex.runtime.retention"], "protected");
      assert.equal(labels["com.codex.runtime.disposable"], "false");
    }
  });

  it("retains protection authority beyond the old 8 MiB tail", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-authority-"));
    const ledger = join(root, "events.jsonl");
    const protection = event("asset.protection.bound", "local", { reason: "rollback" });
    const filler = { schemaVersion: 1, eventId: "filler", occurredAt: "2026-08-14T00:01:00Z", event: "diagnostic.noise", details: { payload: "x".repeat(9 * 1024 * 1024) } };
    const retirement = { ...event("asset.retired", "local"), occurredAt: "2026-08-14T00:02:00Z" };
    writeFileSync(ledger, `${JSON.stringify(protection)}\n${JSON.stringify(filler)}\n${JSON.stringify(retirement)}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      const events = readAuthoritativeLedgerEvents();
      const labels = retirementOverrideLabels(events, { project: "cms", environment: "local" }).get("image:sha256:shared");
      assert.equal(labels["com.codex.runtime.retention"], "protected");
      assert.ok(events.some((item) => item.event === "asset.protection.bound"));
      assert.ok(events.some((item) => item.event === "asset.retired"));
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("preserves physical append order for terminal build state despite timestamp skew", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-build-order-"));
    const ledger = join(root, "events.jsonl");
    const build = (kind, occurredAt) => ({
      schemaVersion: 1, eventId: `${kind}-${Math.random()}`, occurredAt, event: kind,
      project: "cms", environment: "local", asset: { type: "image", id: "sha256:new" }, details: {},
    });
    const success = build("build.succeeded", "2026-08-10T01:02:00Z");
    const failure = build("build.failed", "2026-08-10T01:01:00Z");
    const filler = { schemaVersion: 1, eventId: "build-order-filler", occurredAt: "2026-08-10T01:03:00Z", event: "diagnostic.noise", details: { payload: "x".repeat(9 * 1024 * 1024) } };
    writeFileSync(ledger, `${JSON.stringify(success)}\n${JSON.stringify(filler)}\n${JSON.stringify(failure)}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      const builds = readAuthoritativeLedgerEvents().filter((item) => item.event.startsWith("build."));
      assert.deepEqual(builds.map((item) => item.event), ["build.failed"]);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("keeps the final recovery success across incremental cache resume", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-build-resume-"));
    const ledger = join(root, "events.jsonl");
    const occurredAt = "2026-08-10T01:01:00Z";
    const build = (kind, suffix) => ({
      schemaVersion: 1, eventId: `${kind}-${suffix}`, occurredAt, event: kind,
      project: "cms", environment: "local", asset: { type: "image", id: "sha256:new" }, details: {},
    });
    writeFileSync(ledger, `${JSON.stringify(build("build.succeeded", "one"))}\n${JSON.stringify(build("build.failed", "two"))}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      assert.deepEqual(readAuthoritativeLedgerEvents().filter((item) => item.event.startsWith("build.")).map((item) => item.event), ["build.failed"]);
      writeFileSync(ledger, `${JSON.stringify(build("build.succeeded", "one"))}\n${JSON.stringify(build("build.failed", "two"))}\n${JSON.stringify(build("build.succeeded", "three"))}\n`, "utf8");
      assert.deepEqual(readAuthoritativeLedgerEvents().filter((item) => item.event.startsWith("build.")).map((item) => item.event), ["build.succeeded"]);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("does not reuse authority from a ledger replaced by a larger file", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-replaced-"));
    const ledger = join(root, "events.jsonl");
    const replacement = join(root, "replacement.jsonl");
    writeFileSync(ledger, `${JSON.stringify(event("asset.retired", "local"))}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      assert.equal(retirementOverrideLabels(readAuthoritativeLedgerEvents(), { project: "cms", environment: "local" }).get("image:sha256:shared")?.["com.codex.runtime.retention"], "retired");
      writeFileSync(replacement, `${JSON.stringify(event("asset.protection.bound", "local", { reason: "replacement" }))}\n${JSON.stringify({ event: "diagnostic.noise", details: { payload: "x".repeat(4096) } })}\n`, "utf8");
      renameSync(replacement, ledger);
      assert.equal(retirementOverrideLabels(readAuthoritativeLedgerEvents(), { project: "cms", environment: "local" }).get("image:sha256:shared")?.["com.codex.runtime.retention"], "protected");
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("fully rescans after a same-inode truncate and larger rewrite", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-rewritten-"));
    const ledger = join(root, "events.jsonl");
    writeFileSync(ledger, `${JSON.stringify(event("asset.retired", "local"))}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      readAuthoritativeLedgerEvents();
      const identity = `${statSync(ledger).dev}:${statSync(ledger).ino}`;
      writeFileSync(ledger, `${JSON.stringify(event("asset.protection.bound", "local", { reason: "rewrite", padding: "x".repeat(4096) }))}\n`, "utf8");
      assert.equal(`${statSync(ledger).dev}:${statSync(ledger).ino}`, identity);
      assert.equal(retirementOverrideLabels(readAuthoritativeLedgerEvents(), { project: "cms", environment: "local" }).get("image:sha256:shared")?.["com.codex.runtime.retention"], "protected");
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("fully rescans a same-size ledger rewrite", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-same-size-"));
    const ledger = join(root, "events.jsonl");
    const retired = event("asset.retired", "local", { padding: "x".repeat(256) });
    const protectedEvent = event("asset.protection.bound", "local", { reason: "rewrite", padding: "" });
    let protectedLine = `${JSON.stringify(protectedEvent)}\n`;
    const retiredLine = `${JSON.stringify(retired)}\n`;
    protectedEvent.details.padding = "x".repeat(Buffer.byteLength(retiredLine) - Buffer.byteLength(protectedLine));
    protectedLine = `${JSON.stringify(protectedEvent)}\n`;
    assert.equal(Buffer.byteLength(protectedLine), Buffer.byteLength(retiredLine));
    writeFileSync(ledger, retiredLine, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      readAuthoritativeLedgerEvents();
      writeFileSync(ledger, protectedLine, "utf8");
      assert.equal(retirementOverrideLabels(readAuthoritativeLedgerEvents(), { project: "cms", environment: "local" }).get("image:sha256:shared")?.["com.codex.runtime.retention"], "protected");
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("restarts verification when an append lands at the scan boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-ledger-boundary-"));
    const ledger = join(root, "events.jsonl");
    writeFileSync(ledger, `${JSON.stringify(event("asset.retired", "local"))}\n`, "utf8");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      let injected = false;
      const events = readAuthoritativeLedgerEvents({ afterScan() {
        if (injected) return;
        injected = true;
        appendFileSync(ledger, `${JSON.stringify(event("asset.protection.bound", "local", { reason: "boundary" }))}\n`, "utf8");
      } });
      assert.equal(retirementOverrideLabels(events, { project: "cms", environment: "local" }).get("image:sha256:shared")?.["com.codex.runtime.retention"], "protected");
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });

  it("fails a cleanup authority write before mutation when the durable flush fails", () => {
    const steps = [];
    const io = {
      exists() { steps.push("exists"); return true; },
      mkdir() { steps.push("mkdir"); },
      open() { steps.push("open"); return 41; },
      write(_fd, _payload, _offset, length) { steps.push("write"); return length; },
      fsync() { steps.push("fsync"); throw new Error("injected flush failure"); },
      close() { steps.push("close"); },
    };
    assert.throws(() => appendCleanupEvent("cleanup.operation.started", { operationId: "operation-failure", allowlist: [{ type: "image", id: "sha256:one" }] }, "production", io), /injected flush failure/);
    assert.deepEqual(steps, ["exists", "exists", "mkdir", "open", "write", "fsync", "close"]);
  });

  it("recovers an exact cleanup allowlist from the fsynced authoritative ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "rat-cleanup-authority-"));
    const ledger = join(root, "events.jsonl");
    const previous = process.env.RUNTIME_ASSET_LEDGER_FILE;
    process.env.RUNTIME_ASSET_LEDGER_FILE = ledger;
    try {
      appendCleanupEvent("cleanup.operation.started", { operationId: "operation-durable", source: "production", project: "cms", allowlist: [{ type: "image", id: "sha256:durable", sizeBytes: 10 }] }, "production");
      const started = readAuthoritativeLedgerEvents().find((item) => item.event === "cleanup.operation.started" && item.details?.operationId === "operation-durable");
      assert.deepEqual(started?.details?.allowlist, [{ type: "image", id: "sha256:durable", sizeBytes: 10 }]);
      const source = readFileSync(new URL("../mcp/inventory.mjs", import.meta.url), "utf8");
      assert.ok(source.indexOf('appendCleanupEvent("cleanup.operation.started"') < source.indexOf('if (preview.source !== "local")'));
      assert.match(source, /FS_CONSTANTS\.O_WRONLY \| FS_CONSTANTS\.O_CREAT \| FS_CONSTANTS\.O_APPEND/);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_ASSET_LEDGER_FILE;
      else process.env.RUNTIME_ASSET_LEDGER_FILE = previous;
    }
  });
});
