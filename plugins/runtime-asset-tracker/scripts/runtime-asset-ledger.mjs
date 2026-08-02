#!/usr/bin/env node
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

const TRACKED_ATTRIBUTE_KEYS = new Set([
  "name",
  "image",
  "container",
  "driver",
  "network",
  "scope",
  "type",
  "com.docker.compose.project",
  "com.docker.compose.service",
  "com.docker.compose.volume",
  "com.docker.compose.network",
  "org.opencontainers.image.revision",
]);

function parseArgs(values) {
  const out = { _: [], detail: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      out._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    index += 1;
    if (key === "detail") out.detail.push(next);
    else out[key] = next;
  }
  return out;
}

function clean(value, max = 4096) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).replace(/[\r\n\0]/g, " ").slice(0, max);
}

function defaultLedgerFile() {
  if (process.env.RUNTIME_ASSET_LEDGER_FILE) return resolve(process.env.RUNTIME_ASSET_LEDGER_FILE);
  if (platform() === "win32") {
    const root = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(root, "RuntimeAssetTracker", "events.jsonl");
  }
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(root, "runtime-asset-tracker", "events.jsonl");
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function currentGitSha(cwd = process.cwd()) {
  return clean(process.env.RUNTIME_ASSET_GIT_SHA || process.env.TARGET_COMMIT || commandOutput("git", ["rev-parse", "HEAD"], { cwd }), 64) || "unknown";
}

function detailObject(entries) {
  const out = {};
  for (const entry of entries || []) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = clean(entry.slice(0, separator), 128);
    const value = clean(entry.slice(separator + 1));
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

function context(args = {}) {
  return {
    project: clean(args.project || process.env.RUNTIME_ASSET_PROJECT, 128) || "unknown",
    environment: clean(args.environment || process.env.RUNTIME_ASSET_ENVIRONMENT, 64) || "unknown",
    release: clean(args.release || process.env.RUNTIME_ASSET_RELEASE, 256) || "unknown",
    gitSha: clean(args["git-sha"] || process.env.RUNTIME_ASSET_GIT_SHA, 64) || currentGitSha(),
    owner: clean(args.owner || process.env.RUNTIME_ASSET_OWNER, 128) || "unknown",
  };
}

function appendEvent(args, payload = {}) {
  const ledgerFile = resolve(args.ledger || defaultLedgerFile());
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    event: clean(args.event, 128) || "runtime.unknown",
    host: hostname(),
    ...context(args),
    ...payload,
  };
  const details = detailObject(args.detail);
  if (Object.keys(details).length > 0) event.details = details;
  appendFileSync(ledgerFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ledgerFile, event };
}

function safeLabels(labels) {
  const out = {};
  for (const [key, value] of Object.entries(labels || {})) {
    if (key.startsWith("com.codex.runtime.") || key === "org.opencontainers.image.revision" || key === "org.opencontainers.image.source") {
      out[key] = clean(value, 1024);
    }
  }
  return out;
}

function dockerJson(args) {
  const output = commandOutput("docker", args);
  if (!output) throw new Error(`Docker command failed: docker ${args.join(" ")}`);
  return JSON.parse(output);
}

function recordImage(args) {
  if (!args.image) throw new Error("image command requires --image");
  const inspected = dockerJson(["image", "inspect", args.image]);
  const image = inspected[0];
  return appendEvent(args, {
    asset: {
      type: "image",
      id: clean(image?.Id, 256),
      reference: clean(args.image, 512),
      repoTags: Array.isArray(image?.RepoTags) ? image.RepoTags.map((value) => clean(value, 512)) : [],
      repoDigests: Array.isArray(image?.RepoDigests) ? image.RepoDigests.map((value) => clean(value, 512)) : [],
      createdAt: clean(image?.Created, 128),
      sizeBytes: Number.isFinite(image?.Size) ? image.Size : undefined,
      labels: safeLabels(image?.Config?.Labels),
      service: clean(args.service, 128),
    },
  });
}

function jsonLines(commandArgs) {
  const output = commandOutput("docker", commandArgs);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function snapshot(args) {
  const containers = jsonLines(["ps", "-a", "--format", "{{json .}}"])
    .map((item) => ({ id: item.ID, name: item.Names, image: item.Image, state: item.State, status: item.Status }));
  const images = jsonLines(["image", "ls", "--no-trunc", "--format", "{{json .}}"])
    .map((item) => ({ id: item.ID, repository: item.Repository, tag: item.Tag, createdAt: item.CreatedAt, size: item.Size }));
  const volumes = jsonLines(["volume", "ls", "--format", "{{json .}}"])
    .map((item) => ({ name: item.Name, driver: item.Driver, scope: item.Scope }));
  const networks = jsonLines(["network", "ls", "--no-trunc", "--format", "{{json .}}"])
    .map((item) => ({ id: item.ID, name: item.Name, driver: item.Driver, scope: item.Scope }));
  return appendEvent({ ...args, event: args.event || "inventory.snapshot" }, {
    inventory: { containers, images, volumes, networks },
  });
}

function filteredAttributes(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (TRACKED_ATTRIBUTE_KEYS.has(key) || key.startsWith("com.codex.runtime.")) out[key] = clean(value, 1024);
  }
  return out;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireWatcherLock(ledgerFile) {
  const lockFile = `${ledgerFile}.watch.lock`;
  mkdirSync(dirname(lockFile), { recursive: true });
  if (existsSync(lockFile)) {
    const oldPid = Number(readFileSync(lockFile, "utf8").trim());
    if (Number.isInteger(oldPid) && oldPid > 0 && pidAlive(oldPid)) return null;
    rmSync(lockFile, { force: true });
  }
  const fd = openSync(lockFile, "wx", 0o600);
  writeFileSync(fd, `${process.pid}\n`, "utf8");
  closeSync(fd);
  return lockFile;
}

async function watch(args) {
  const ledgerFile = resolve(args.ledger || defaultLedgerFile());
  const lockFile = acquireWatcherLock(ledgerFile);
  if (!lockFile) return;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  appendEvent({ ...args, ledger: ledgerFile, event: "observer.started" }, { observerPid: process.pid });
  try { snapshot({ ...args, ledger: ledgerFile, event: "inventory.bootstrap" }); } catch (error) {
    appendEvent({ ...args, ledger: ledgerFile, event: "inventory.bootstrap.failed", detail: [`error=${error.message}`] });
  }
  try {
    while (!stopping) {
      const child = spawn("docker", ["events", "--format", "{{json .}}"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (stopping) break;
        try {
          const raw = JSON.parse(line);
          const type = clean(raw.Type || raw.type, 64) || "unknown";
          const rawAction = String(raw.Action || raw.action || raw.status || "unknown");
          const action = clean(rawAction.split(":", 1)[0].trim(), 64) || "unknown";
          const attributes = filteredAttributes(raw.Actor?.Attributes);
          appendEvent({ ...args, ledger: ledgerFile, event: `docker.${type}.${action}` }, {
            project: clean(attributes["com.codex.runtime.project"] || attributes["com.docker.compose.project"], 128) || context(args).project,
            environment: clean(attributes["com.codex.runtime.environment"], 64) || context(args).environment,
            release: clean(attributes["com.codex.runtime.release"], 256) || context(args).release,
            gitSha: clean(attributes["com.codex.runtime.git-sha"] || attributes["org.opencontainers.image.revision"], 64) || context(args).gitSha,
            owner: clean(attributes["com.codex.runtime.owner"], 128) || context(args).owner,
            asset: {
              type,
              id: clean(raw.Actor?.ID || raw.id, 256),
              attributes,
            },
            dockerTimeNano: clean(raw.timeNano, 64),
          });
        } catch {
          // Ignore malformed daemon lines. No raw line is persisted because it may contain unknown attributes.
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    }
  } finally {
    rmSync(lockFile, { force: true });
    appendEvent({ ...args, ledger: ledgerFile, event: "observer.stopped" }, { observerPid: process.pid });
  }
}

function usage() {
  console.error("Usage: runtime-asset-ledger.mjs <record|image|snapshot|watch> [--event name] [--ledger path] [--project key] [--environment name]");
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (command === "record") appendEvent(args, {
    asset: args["asset-type"] || args["asset-id"] ? {
      type: clean(args["asset-type"], 64),
      id: clean(args["asset-id"], 256),
      service: clean(args.service, 128),
    } : undefined,
    status: clean(args.status, 64),
  });
  else if (command === "image") recordImage(args);
  else if (command === "snapshot") snapshot(args);
  else if (command === "watch") await watch(args);
  else { usage(); process.exitCode = 2; }
} catch (error) {
  console.error(`runtime-asset-ledger: ${error.message}`);
  process.exitCode = 1;
}
