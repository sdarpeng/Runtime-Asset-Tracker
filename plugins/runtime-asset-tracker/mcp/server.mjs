import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { collectDashboard, createCleanupPreview, executeCleanup, saveSchedule } from "./inventory.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_URI = "ui://runtime-asset-tracker/dashboard-v1.html";
const dashboardHtml = readFileSync(join(moduleDirectory, "dashboard.html"), "utf8");

function toolResult(structuredContent, text) {
  return {
    structuredContent,
    content: [{ type: "text", text }],
  };
}

export function createRuntimeAssetServer() {
  const server = new McpServer(
    { name: "runtime-asset-tracker", version: "0.2.0" },
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
      types: z.array(z.enum(["container", "image", "volume", "cache", "pull_request", "artifact", "actions_cache", "workflow_run"])).optional(),
    },
    outputSchema: { preview: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const preview = createCleanupPreview(input);
    return toolResult({ preview }, `Cleanup preview contains ${preview.allowlist.length} explicitly disposable assets.`);
  });

  registerAppTool(server, "execute_cleanup", {
    title: "Execute exact runtime asset cleanup",
    description: "Delete only the exact assets from a non-expired preview after the user confirms that allowlist.",
    inputSchema: {
      token: z.string().uuid(),
      confirmed: z.literal(true),
    },
    outputSchema: { cleanup: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app", "model"] } },
  }, async (input) => {
    const cleanup = executeCleanup(input);
    return toolResult({ cleanup }, `Cleanup completed with ${cleanup.results.filter((item) => item.status === "removed").length} removed assets.`);
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function startHttp() {
  const host = process.env.RUNTIME_ASSET_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.RUNTIME_ASSET_DASHBOARD_PORT || 47831);
  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(dashboardHtml);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        sendJson(response, 200, { dashboard: collectDashboard({
          scope: url.searchParams.get("scope") || "environment",
          source: url.searchParams.get("source") || "local",
          project: url.searchParams.get("project") || "all",
        }) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cleanup-preview") {
        sendJson(response, 200, { preview: createCleanupPreview(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cleanup-execute") {
        sendJson(response, 200, { cleanup: executeCleanup(await readBody(request)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/schedule") {
        sendJson(response, 200, { schedule: saveSchedule(await readBody(request)) });
        return;
      }
      if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(request.method || "")) {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        const server = createRuntimeAssetServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(request, response);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "runtime_asset_dashboard_error", message: error.message });
    }
  });
  httpServer.listen(port, host, () => {
    console.log(`Runtime Asset Tracker dashboard: http://${host}:${port}`);
    console.log(`MCP endpoint: http://${host}:${port}/mcp`);
  });
}

async function startStdio() {
  const server = createRuntimeAssetServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv.includes("--http")) await startHttp();
else await startStdio();
