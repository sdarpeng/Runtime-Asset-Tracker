#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ownDir = dirname(fileURLToPath(import.meta.url));
const ledgerScript = join(ownDir, "runtime-asset-ledger.mjs");
const composeOperations = new Set(["build", "config", "create", "down", "events", "exec", "images", "logs", "ls", "pause", "port", "ps", "pull", "push", "restart", "rm", "run", "start", "stop", "top", "unpause", "up", "version", "wait", "watch"]);

function parse(values) {
  const separator = values.indexOf("--");
  const internal = separator >= 0 ? values.slice(0, separator) : [];
  const compose = separator >= 0 ? values.slice(separator + 1) : values;
  const options = {};
  for (let index = 0; index < internal.length; index += 2) {
    options[internal[index].replace(/^--/, "")] = internal[index + 1];
  }
  return { options, compose };
}

function ledgerArgs(options, compose, event, status) {
  const args = [ledgerScript, "record", "--event", event, "--status", status];
  for (const key of ["ledger", "project", "environment", "release", "owner", "git-sha"]) {
    if (options[key]) args.push(`--${key}`, options[key]);
  }
  const operation = compose.find((value) => composeOperations.has(value)) || "unknown";
  args.push("--detail", `operation=${operation}`);
  return args;
}

function record(options, compose, event, status) {
  const result = spawnSync(process.execPath, ledgerArgs(options, compose, event, status), { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) console.warn(`Runtime asset ledger warning: ${event} was not recorded.`);
}

const { options, compose } = parse(process.argv.slice(2));
if (compose.length === 0) {
  console.error("Usage: run-compose.mjs [tracker options] -- <docker compose arguments>");
  process.exit(2);
}

record(options, compose, "compose.command.started", "started");
const result = spawnSync("docker", ["compose", ...compose], { stdio: "inherit", windowsHide: false });
const status = result.status ?? 1;
record(options, compose, status === 0 ? "compose.command.completed" : "compose.command.failed", status === 0 ? "completed" : "failed");

if (status === 0) {
  const snapshotArgs = [ledgerScript, "snapshot"];
  for (const key of ["ledger", "project", "environment", "release", "owner", "git-sha"]) {
    if (options[key]) snapshotArgs.push(`--${key}`, options[key]);
  }
  const snapshot = spawnSync(process.execPath, snapshotArgs, { stdio: "inherit", windowsHide: true });
  if (snapshot.status !== 0) console.warn("Runtime asset ledger warning: reconciliation snapshot was not recorded.");
}

process.exit(status);
