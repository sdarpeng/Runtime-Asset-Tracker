import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = join(root, "ui", "dist", "client");
const outputRoot = join(root, "dist");
mkdirSync(outputRoot, { recursive: true });

let html = readFileSync(join(clientRoot, "index.html"), "utf8");
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_match, href) => {
  const css = readFileSync(join(clientRoot, href.replace(/^\//, "")), "utf8");
  return `<style>${css}</style>`;
});
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, (_match, src) => {
  const javascript = readFileSync(join(clientRoot, src.replace(/^\//, "")), "utf8");
  return `<script type="module">${javascript}</script>`;
});
writeFileSync(join(outputRoot, "dashboard.html"), html, "utf8");

await build({
  entryPoints: [join(root, "mcp", "server.mjs")],
  outfile: join(outputRoot, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

console.log(`Built Runtime Asset Tracker plugin at ${outputRoot}`);
