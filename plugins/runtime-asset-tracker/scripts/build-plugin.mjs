import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitValue(args) {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return null; }
}

function walkFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkFiles(join(path, entry.name)) : [join(path, entry.name)]);
}

const sourceFiles = [
  ...walkFiles(join(root, ".codex-plugin")),
  ...walkFiles(join(root, "mcp")),
  ...walkFiles(join(root, "scripts")),
  ...walkFiles(join(root, "skills")),
  ...walkFiles(join(root, "ui", "src")),
  join(root, "package.json"),
  join(root, "package-lock.json"),
  join(root, "ui", "package.json"),
  join(root, "ui", "package-lock.json"),
].sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
const sourceDigest = sha256(Buffer.concat(sourceFiles.flatMap((path) => [Buffer.from(`${relative(root, path).replaceAll("\\", "/")}\0`), readFileSync(path)])));
const serverSha256 = sha256(readFileSync(join(outputRoot, "server.mjs")));
const dashboardSha256 = sha256(readFileSync(join(outputRoot, "dashboard.html")));
const safeDeletePosixHelperSha256 = sha256(readFileSync(join(root, "scripts", "safe-delete-path.py")));
const safeDeleteWindowsHelperSha256 = sha256(readFileSync(join(root, "scripts", "safe-delete-path-windows.ps1")));
const sourceDirty = gitValue(["status", "--porcelain", "--", ".codex-plugin", "mcp", "scripts", "skills", "ui/src", "package.json", "package-lock.json", "ui/package.json", "ui/package-lock.json"]) !== "";
const provenance = {
  schemaVersion: "sparkling.tool-build-provenance/v1",
  builtAt: new Date().toISOString(),
  sourceCommit: sourceDirty ? null : gitValue(["rev-parse", "HEAD"]),
  sourceTree: sourceDirty ? null : gitValue(["rev-parse", "HEAD^{tree}"]),
  sourceDirty,
  sourceDigest,
  serverSha256,
  dashboardSha256,
  safeDeleteHelperSha256: safeDeletePosixHelperSha256,
  safeDeletePosixHelperSha256,
  safeDeleteWindowsHelperSha256,
};
provenance.buildDigest = sha256(JSON.stringify(provenance));
writeFileSync(join(outputRoot, "build-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

console.log(`Built Runtime Asset Tracker plugin at ${outputRoot}`);
