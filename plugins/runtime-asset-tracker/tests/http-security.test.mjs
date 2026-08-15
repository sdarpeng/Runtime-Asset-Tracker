import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function rawStatus(url, headers) {
  return await new Promise((resolve, reject) => {
    const req = request(url, { headers }, (response) => { response.resume(); resolve(response.statusCode); });
    req.once("error", reject);
    req.end();
  });
}

describe("authenticated loopback HTTP", () => {
  let child;
  let baseUrl;
  let bootstrapUrl;

  before(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["mcp/server.mjs", "--http"], {
      cwd: new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
      env: { ...process.env, RUNTIME_ASSET_DASHBOARD_HOST: "127.0.0.1", RUNTIME_ASSET_DASHBOARD_PORT: String(port), RUNTIME_ASSET_HTTP_TOKEN: "f".repeat(64) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    bootstrapUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("HTTP server did not print a bootstrap URL")), 10_000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/Runtime Asset Tracker dashboard: (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
  });

  after(() => { child?.kill(); });

  it("requires authentication and consumes the bootstrap nonce exactly once", async () => {
    assert.equal((await fetch(`${baseUrl}/api/version`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/`)).status, 401);
    const bootstrap = await fetch(bootstrapUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.match(cookie || "", /^rat_session=[0-9a-f]{64}$/);
    assert.equal((await fetch(bootstrapUrl, { redirect: "manual" })).status, 401);
    assert.equal((await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } })).status, 200);
  });

  it("rejects poisoned Host and cross-origin requests", async () => {
    assert.equal(await rawStatus(`${baseUrl}/api/version`, { Host: "evil.example" }), 403);
    assert.equal((await fetch(`${baseUrl}/api/dashboard`, { headers: { Authorization: `Bearer ${"f".repeat(64)}`, Origin: "https://evil.example" } })).status, 403);
  });
});
