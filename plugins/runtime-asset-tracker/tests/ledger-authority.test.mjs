import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readAuthoritativeLedgerEvents, retirementOverrideLabels } from "../mcp/inventory.mjs";

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
});
