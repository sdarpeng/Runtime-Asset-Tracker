import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeCleanupPreview } from "../mcp/inventory.mjs";

function preview(overrides = {}) {
  return {
    token: "token-1",
    actorId: "actor-1",
    serverInstanceId: "server-1",
    confirmationDigest: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowlist: [],
    ...overrides,
  };
}

describe("cleanup authorization", () => {
  it("binds confirmation to the authenticated actor and server instance", () => {
    const store = new Map([["token-1", preview()]]);
    assert.throws(() => consumeCleanupPreview({ token: "token-1", confirmed: true, confirmationDigest: "a".repeat(64) }, { actorId: "actor-2", serverInstanceId: "server-1" }, store), /different authenticated actor/);
    assert.throws(() => consumeCleanupPreview({ token: "token-1", confirmed: true, confirmationDigest: "a".repeat(64) }, { actorId: "actor-1", serverInstanceId: "server-2" }, store), /different server instance/);
    assert.equal(store.has("token-1"), true);
  });

  it("rejects a changed allowlist digest without consuming the preview", () => {
    const store = new Map([["token-1", preview()]]);
    assert.throws(() => consumeCleanupPreview({ token: "token-1", confirmed: true, confirmationDigest: "b".repeat(64) }, { actorId: "actor-1", serverInstanceId: "server-1" }, store), /digest does not match/);
    assert.equal(store.has("token-1"), true);
  });

  it("atomically consumes a valid preview so the token cannot be replayed", () => {
    const store = new Map([["token-1", preview()]]);
    const input = { token: "token-1", confirmed: true, confirmationDigest: "a".repeat(64) };
    const context = { actorId: "actor-1", serverInstanceId: "server-1" };
    assert.equal(consumeCleanupPreview(input, context, store).token, "token-1");
    assert.equal(store.has("token-1"), false);
    assert.throws(() => consumeCleanupPreview(input, context, store), /missing or expired/);
  });

  it("removes an expired preview and requires a fresh one", () => {
    const store = new Map([["token-1", preview({ expiresAt: "2000-01-01T00:00:00.000Z" })]]);
    assert.throws(() => consumeCleanupPreview({ token: "token-1", confirmed: true, confirmationDigest: "a".repeat(64) }, { actorId: "actor-1", serverInstanceId: "server-1" }, store), /expired/);
    assert.equal(store.has("token-1"), false);
  });
});
