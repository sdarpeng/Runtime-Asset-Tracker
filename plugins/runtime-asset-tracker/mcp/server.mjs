import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { collectDashboard, createCleanupPreview, createUnifiedAssetTable, executeCleanup, importPathReconciliation, importReconciliation, importUnifiedReconciliation, resumeCleanup, runDeepScan, runtimeInstanceId, saveSchedule } from "./inventory.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_URI = "ui://runtime-asset-tracker/dashboard-v1.html";
const dashboardPath = [join(moduleDirectory, "dashboard.html"), join(moduleDirectory, "..", "dist", "dashboard.html")].find(existsSync);
if (!dashboardPath) throw new Error("Runtime Asset Tracker dashboard.html is missing; run npm run build.");
const dashboardHtml = readFileSync(dashboardPath, "utf8");
const pluginRoot = join(moduleDirectory, "..");

function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function runtimeIdentity() {
  const manifest = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const packageJson = readJson(join(pluginRoot, "package.json"));
  const provenance = readJson(join(pluginRoot, "dist", "build-provenance.json"));
  const serverPath = fileURLToPath(import.meta.url);
  const serverSha256 = createHash("sha256").update(readFileSync(serverPath)).digest("hex");
  return {
    pluginId: String(manifest.name || "runtime-asset-tracker"),
    manifestVersion: String(manifest.version || "unknown"),
    packageVersion: String(packageJson.version || "unknown"),
    sourceCommit: provenance.sourceCommit || null,
    sourceTree: provenance.sourceTree || null,
    sourceDirty: provenance.sourceDirty ?? null,
    sourceDigest: provenance.sourceDigest || null,
    buildDigest: provenance.buildDigest || serverSha256,
    serverSha256,
    serverInstanceId: runtimeInstanceId(),
  };
}

function toolResult(structuredContent, text) {
  return {
    structuredContent,
    content: [{ type: "text", text }],
  };
}

export function createRuntimeAssetServer(context = {}) {
  const identity = runtimeIdentity();
  const actorContext = { actorId: String(context.actorId || "mcp-stdio"), serverInstanceId: identity.serverInstanceId };
  const server = new McpServer(
    { name: "runtime-asset-tracker", version: identity.packageVersion },
    { instructions: "Use open_runtime_dashboard for a visual inventory. Always call preview_cleanup before execute_cleanup. Never infer that an unlabeled volume is disposable." },
  );

  registerAppResource(server, "Runtime Asset Dashboard", DASHBOARD_URI, {
    description: "Full-screen cross-project dashboard for worktrees, Docker assets, cache, and lifecycle events.",
  }, async () => ({
    contents: [{
      uri: DASHBOARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: dashboardHtml,
      _meta: { ui: { prefersBorder: false } },
    }],
  }));

  registerAppTool(server, "open_runtime_dashboard", {
    title: "Open runtime asset dashboard",
    description: "Open or refresh the visual runtime asset dashboard for local Docker, worktrees, configured EC2 environments, and GitHub.",
    inputSchema: {
      scope: z.enum(["environment", "project"]).optional(),
      source: z.enum(["local", "production", "staging", "github"]).optional(),
      project: z.string().max(128).optional(),
    },
    outputSchema: { dashboard: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI } },
  }, async (input) => {
    const dashboard = collectDashboard(input);
    return toolResult({ dashboard }, `Runtime asset dashboard refreshed at ${dashboard.generatedAt}.`);
  });

  registerAppTool(server, "preview_cleanup", {
    title: "Preview runtime asset cleanup",
    description: "Generate an exact, expiring cleanup allowlist. This tool never deletes assets.",
    inputSchema: {
      source: z.enum(["local", "production", "staging", "github"]).optional(),
      project: z.string().optional(),
      types: z.array(z.enum(["container", "image", "volume", "cache", "worktree", "worktree_residual", "host_artifact", "pull_request", "artifact", "actions_cache", "workflow_run"])).optional(),
      assetIds: z.array(z.string().min(1).max(1024)).max(320).optional(),
    },
    outputSchema: { preview: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const preview = createCleanupPreview(input, actorContext);
    return toolResult({ preview }, `Cleanup preview contains ${preview.allowlist.length} explicitly disposable assets.`);
  });

  registerAppTool(server, "import_retirement_reconciliation", {
    title: "Import exact retirement reconciliation",
    description: "Validate a machine-readable reconciliation report and append exact remote image retirement/protection attestations. This never deletes images.",
    inputSchema: {
      reportPath: z.string().min(3).max(1024),
      source: z.enum(["production", "staging"]),
      project: z.string().min(3).max(128),
      groups: z.array(z.string().min(1).max(128)).min(1).max(32),
      owner: z.string().min(1).max(128).optional(),
    },
    outputSchema: { reconciliation: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const reconciliation = importReconciliation(input);
    return toolResult({ reconciliation }, `Imported ${reconciliation.retirementEventsAdded} exact image retirement attestations and ${reconciliation.protectionEventsAdded} protection bindings.`);
  });

  registerAppTool(server, "import_path_retirement_reconciliation", {
    title: "Import exact path retirement reconciliation",
    description: "Validate a machine-readable worktree/residual/artifact retirement report and append exact attestations. This never deletes paths.",
    inputSchema: {
      reportPath: z.string().min(3).max(1024),
      owner: z.string().min(1).max(128).optional(),
    },
    outputSchema: { reconciliation: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const reconciliation = importPathReconciliation(input);
    return toolResult({ reconciliation }, `Imported ${reconciliation.retirementEventsAdded} exact path retirement attestations.`);
  });

  registerAppTool(server, "import_unified_retirement_reconciliation", {
    title: "Import merged-PR asset retirement reconciliation",
    description: "Validate a merged-PR reconciliation containing exact containers, images, volumes, and managed remote paths, then append retirement attestations. It never deletes assets.",
    inputSchema: {
      reportPath: z.string().min(3).max(1024),
      source: z.enum(["local", "production", "staging"]),
      project: z.string().min(3).max(128),
      groups: z.array(z.string().min(1).max(128)).min(1).max(32),
      owner: z.string().min(1).max(128).optional(),
    },
    outputSchema: { reconciliation: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const reconciliation = importUnifiedReconciliation(input);
    return toolResult({ reconciliation }, `Imported ${reconciliation.retirementEventsAdded} exact merged-PR asset retirement attestations.`);
  });

  registerAppTool(server, "deep_scan_runtime_lineage", {
    title: "Deep scan runtime asset lineage",
    description: "Read-only analysis of ownership, consumers, retention, expiry, source revision, and recovery evidence for the selected project and environment. It never deletes or relabels assets.",
    inputSchema: {
      source: z.enum(["local", "production", "staging", "github"]).optional(),
      project: z.string().max(128).optional(),
    },
    outputSchema: {
      lineage: z.record(z.string(), z.unknown()),
      dashboard: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const { report, dashboard } = runDeepScan(input);
    return toolResult({ lineage: report, dashboard }, `Read-only lineage scan inspected ${report.scannedCount} assets and found ${report.expiringCount} expiring assets.`);
  });

  registerAppTool(server, "build_unified_asset_table", {
    title: "Build unified runtime asset table",
    description: "Read local, Production, and Staging inventories and correlate them with a GitHub revision/PR authority report. This is read-only and never marks assets disposable by name alone.",
    inputSchema: {
      project: z.string().min(3).max(128),
      sources: z.array(z.enum(["local", "production", "staging"])).min(1).max(3).optional(),
      authorityReportPath: z.string().min(3).max(1024).optional(),
      outputPath: z.string().min(3).max(1024).optional(),
      coolingHours: z.number().int().min(1).max(720).optional(),
    },
    outputSchema: { table: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const table = createUnifiedAssetTable(input);
    return toolResult({ table }, `Unified asset table contains ${table.summary.assetCount} exact assets and ${table.summary.candidateCount} cleanup candidates.`);
  });

  registerAppTool(server, "execute_cleanup", {
    title: "Execute exact runtime asset cleanup",
    description: "Delete only the exact assets from a non-expired preview after the user confirms that allowlist.",
    inputSchema: {
      token: z.string().uuid(),
      confirmed: z.literal(true),
      confirmationDigest: z.string().regex(/^[0-9a-f]{64}$/i),
    },
    outputSchema: { cleanup: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const cleanup = executeCleanup(input, actorContext);
    const counts = Object.fromEntries(["removed", "failed", "skipped", "outcome_unknown"].map((status) => [status, cleanup.results.filter((item) => item.status === status).length]));
    return toolResult({ cleanup }, `Cleanup status ${cleanup.status}: ${counts.removed} removed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.outcome_unknown} outcome unknown.`);
  });

  registerAppTool(server, "resume_cleanup", {
    title: "Resume exact AWS cleanup reconciliation",
    description: "Poll an existing exact SSM cleanup operation by operationId/commandId without ever sending the cleanup command again.",
    inputSchema: {
      source: z.enum(["production", "staging"]),
      project: z.string().min(3).max(128),
      operationId: z.string().uuid(),
      commandId: z.string().uuid().nullable().optional(),
    },
    outputSchema: { cleanup: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const cleanup = resumeCleanup(input);
    return toolResult({ cleanup }, `Recovered cleanup operation ${cleanup.operationId}: ${cleanup.status}; no cleanup command was resent.`);
  });

  registerAppTool(server, "save_cleanup_schedule", {
    title: "Save cleanup preview schedule",
    description: "Persist a local report-only schedule. It never enables unattended deletion.",
    inputSchema: {
      enabled: z.boolean(),
      cadence: z.enum(["daily", "weekly", "monthly"]),
      day: z.string().max(32),
      time: z.string().regex(/^\d{2}:\d{2}$/),
    },
    outputSchema: { schedule: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const schedule = saveSchedule(input);
    return toolResult({ schedule }, `Saved ${schedule.cadence} preview-only schedule.`);
  });

  return server;
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Request body exceeds the 1 MiB limit.");
      error.httpStatus = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

function constantTimeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && timingSafeEqual(first, second);
}

function cookieValue(request, name) {
  return String(request.headers.cookie || "").split(";").map((item) => item.trim()).flatMap((item) => {
    const index = item.indexOf("=");
    return index > 0 && item.slice(0, index) === name ? [decodeURIComponent(item.slice(index + 1))] : [];
  })[0];
}

function authenticatedActor(request, accessToken, expectedOrigin, sessions = new Map()) {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const cookie = cookieValue(request, "rat_session");
  const session = cookie ? sessions.get(cookie) : null;
  const bearerValid = bearer && constantTimeEqual(bearer, accessToken);
  if (!bearerValid && (!session || session.expiresAt <= Date.now())) {
    if (cookie) sessions.delete(cookie);
    const error = new Error("Authenticated Runtime Asset Tracker session required.");
    error.httpStatus = 401;
    throw error;
  }
  const origin = String(request.headers.origin || "");
  if (origin && origin !== expectedOrigin) {
    const error = new Error("Cross-origin Runtime Asset Tracker request rejected.");
    error.httpStatus = 403;
    throw error;
  }
  return bearerValid ? `http-bearer:${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}` : session.actorId;
}

async function startHttp() {
  const host = process.env.RUNTIME_ASSET_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.RUNTIME_ASSET_DASHBOARD_PORT || 47831);
  if (!new Set(["127.0.0.1", "localhost"]).has(host)) throw new Error("Runtime Asset Tracker HTTP mode is loopback-only. Use the authenticated MCP/SSM adapters for remote inventory.");
  const accessToken = process.env.RUNTIME_ASSET_HTTP_TOKEN || randomBytes(32).toString("hex");
  let bootstrapNonce = randomBytes(32).toString("hex");
  const sessions = new Map();
  const expectedOrigin = `http://${host}:${port}`;
  const identity = runtimeIdentity();
  const httpServer = createServer(async (request, response) => {
    try {
      const requestHost = String(request.headers.host || "");
      if (requestHost !== `${host}:${port}` && requestHost !== `localhost:${port}` && requestHost !== `127.0.0.1:${port}`) {
        sendJson(response, 403, { error: "invalid_host" });
        return;
      }
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/api/version") {
        sendJson(response, 200, { identity });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const supplied = url.searchParams.get("access");
        if (supplied && bootstrapNonce && constantTimeEqual(supplied, bootstrapNonce)) {
          bootstrapNonce = "";
          const sessionToken = randomBytes(32).toString("hex");
          sessions.set(sessionToken, { actorId: `http-session:${randomBytes(16).toString("hex")}`, expiresAt: Date.now() + 12 * 60 * 60_000 });
          response.writeHead(303, { Location: "/", "Set-Cookie": `rat_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, "Cache-Control": "no-store" });
          response.end();
          return;
        }
        authenticatedActor(request, accessToken, expectedOrigin, sessions);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(dashboardHtml);
        return;
      }
      const actorId = authenticatedActor(request, accessToken, expectedOrigin, sessions);
      const actorContext = { actorId, serverInstanceId: identity.serverInstanceId };
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        sendJson(response, 200, { dashboard: collectDashboard({
          scope: url.searchParams.get("scope") || "project",
          source: url.searchParams.get("source") || "local",
          project: url.searchParams.get("project") || "all",
        }) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cleanup-preview") {
        sendJson(response, 200, { preview: createCleanupPreview(await readBody(request), actorContext) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/reconciliation-import") {
        sendJson(response, 200, { reconciliation: importReconciliation(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/path-reconciliation-import") {
        sendJson(response, 200, { reconciliation: importPathReconciliation(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/unified-reconciliation-import") {
        sendJson(response, 200, { reconciliation: importUnifiedReconciliation(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/deep-scan") {
        const { report, dashboard } = runDeepScan(await readBody(request));
        sendJson(response, 200, { lineage: report, dashboard });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/unified-asset-table") {
        sendJson(response, 200, { table: createUnifiedAssetTable(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cleanup-execute") {
        sendJson(response, 200, { cleanup: executeCleanup(await readBody(request), actorContext) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/schedule") {
        sendJson(response, 200, { schedule: saveSchedule(await readBody(request)) });
        return;
      }
      if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(request.method || "")) {
        const server = createRuntimeAssetServer(actorContext);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(request, response);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, Number(error.httpStatus || 500), { error: "runtime_asset_dashboard_error", message: error.message });
    }
  });
  httpServer.listen(port, host, () => {
    console.log(`Runtime Asset Tracker dashboard: http://${host}:${port}/?access=${bootstrapNonce}`);
    console.log(`Runtime Asset Tracker identity: ${identity.manifestVersion} ${identity.sourceCommit || "dirty-or-unbuilt-source"} ${identity.sourceDigest || "unknown-source"} ${identity.serverSha256}`);
  });

}

async function startStdio() {
  const server = createRuntimeAssetServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv.includes("--http")) await startHttp();
else await startStdio();
