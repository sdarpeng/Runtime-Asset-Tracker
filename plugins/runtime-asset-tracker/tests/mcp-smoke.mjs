import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.mjs"],
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
});

const client = new Client({ name: "runtime-asset-tracker-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "build_unified_asset_table",
    "deep_scan_runtime_lineage",
    "execute_cleanup",
    "import_path_retirement_reconciliation",
    "import_retirement_reconciliation",
    "import_unified_retirement_reconciliation",
    "open_runtime_dashboard",
    "preview_cleanup",
    "resume_cleanup",
    "save_cleanup_schedule",
  ]);

  const resources = await client.listResources();
  assert.equal(resources.resources[0]?.uri, "ui://runtime-asset-tracker/dashboard-v1.html");

  process.stdout.write(`MCP smoke passed: ${names.join(", ")}\n`);
} finally {
  await client.close();
}
