import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PATH_RECONCILIATION_SCHEMA = "sparkling.runtime-path-retirement-reconciliation/v1";
const PATH_TYPES = new Set(["worktree", "worktree_residual", "host_artifact"]);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;
const ARCHIVE = /(?:\.tar\.gz|\.tar|\.tgz|\.zip|\.gz|\.7z|\.bundle)$/i;
const ARTIFACT_DIR = /^(?:node_modules|dist|build|coverage|smoke-artifacts|test-results|playwright-report|\.next|\.nuxt|\.turbo|\.cache|\.pytest_cache|__pycache__|\.prod-artifacts|\.codex-(?:execution|artifacts?|deploy|release).*)$/i;
const scanCache = new Map();

function defaultStateRoot() {
  if (process.env.RUNTIME_ASSET_STATE_DIR) return resolve(process.env.RUNTIME_ASSET_STATE_DIR);
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RuntimeAssetTracker");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "runtime-asset-tracker");
}

function runGit(args, cwd, timeout = 20_000) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function keyPath(value) {
  const path = resolve(value);
  return platform() === "win32" ? path.toLowerCase() : path;
}

export function pathAssetId(type, path) {
  const digest = createHash("sha256").update(`${type}\0${keyPath(path)}`).digest("hex");
  return `path-sha256:${digest}`;
}

function within(path, root) {
  const child = resolve(path);
  const parent = resolve(root);
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function canonicalPathContainment(pathValue, rootValue) {
  const path = resolve(pathValue);
  const root = resolve(rootValue);
  if (!existsSync(path) || !existsSync(root) || !within(path, root)) return false;
  try {
    if (lstatSync(root).isSymbolicLink()) return false;
    const rel = relative(root, path);
    let cursor = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    const realRoot = realpathSync.native(root);
    const realPath = realpathSync.native(path);
    return within(realPath, realRoot);
  } catch {
    return false;
  }
}

function safeEntries(path) {
  try { return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

function metadataToken(path, stats, kind) {
  return `${keyPath(path).replaceAll("\\", "/")}\0${kind}\0${Number(stats.size || 0)}\0${Math.trunc(Number(stats.mtimeMs || 0))}\n`;
}

export function scanPathUsage(rootPath, { maxEntries = 400_000, largeFileBytes = 100 * 1024 * 1024 } = {}) {
  const root = resolve(rootPath);
  const artifacts = [];
  const reparsePoints = [];
  let entryCount = 0;
  let totalBytes = 0;
  let truncated = false;

  function scan(path, rel, captureArtifact = true) {
    if (entryCount >= maxEntries) { truncated = true; return { bytes: 0, count: 0, fingerprint: undefined }; }
    let stats;
    try { stats = lstatSync(path); } catch { return { bytes: 0, count: 0, fingerprint: undefined }; }
    entryCount += 1;
    const isReparse = stats.isSymbolicLink();
    const kind = isReparse ? "reparse" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
    const hash = createHash("sha256").update(metadataToken(path, stats, kind));
    if (isReparse) {
      reparsePoints.push(path);
      return { bytes: Number(stats.size || 0), count: 1, fingerprint: `sha256:${hash.digest("hex")}` };
    }
    if (!stats.isDirectory()) {
      const bytes = Number(stats.size || 0);
      totalBytes += bytes;
      if (captureArtifact && stats.isFile() && (bytes >= largeFileBytes || ARCHIVE.test(path))) {
        const artifactHash = hash.copy().digest("hex");
        artifacts.push({ path, category: ARCHIVE.test(path) ? "archive" : "large-file", sizeBytes: bytes, entryCount: 1, fingerprint: `sha256:${artifactHash}`, truncated: false });
      }
      return { bytes, count: 1, fingerprint: `sha256:${hash.digest("hex")}` };
    }

    const entries = safeEntries(path);
    const artifactDiscoveryAllowed = captureArtifact && basename(path).toLowerCase() !== ".git";
    const isArtifactRoot = artifactDiscoveryAllowed && (ARTIFACT_DIR.test(basename(path)) || entries.some((entry) => /^part-\d+(?:\.|$)/i.test(entry.name)));
    let bytes = 0;
    let count = 1;
    for (const entry of entries) {
      if (entryCount >= maxEntries) { truncated = true; break; }
      const child = join(path, entry.name);
      const result = scan(child, rel ? join(rel, entry.name) : entry.name, artifactDiscoveryAllowed && !isArtifactRoot);
      bytes += result.bytes;
      count += result.count;
      hash.update(`${entry.name}\0${result.bytes}\0${result.count}\0${result.fingerprint || "truncated"}\n`);
    }
    const fingerprint = `sha256:${hash.digest("hex")}`;
    if (isArtifactRoot) {
      artifacts.push({
        path,
        category: ARTIFACT_DIR.test(basename(path)) ? "generated-directory" : "archive-parts",
        sizeBytes: bytes,
        entryCount: count,
        fingerprint,
        truncated,
      });
    }
    return { bytes, count, fingerprint };
  }

  if (!existsSync(root)) return { path: root, exists: false, sizeBytes: 0, entryCount: 0, fingerprint: undefined, artifacts: [], reparsePoints: [], truncated: false };
  const result = scan(root, "", true);
  return {
    path: root,
    exists: true,
    sizeBytes: result.bytes,
    entryCount,
    fingerprint: result.fingerprint,
    artifacts: artifacts.sort((a, b) => b.sizeBytes - a.sizeBytes),
    reparsePoints,
    truncated,
  };
}

function cachedPathUsage(path, options = {}) {
  const ttl = Math.max(0, Number(options.cacheTtlMs ?? 5 * 60_000));
  const key = `${keyPath(path)}\0${Number(options.maxEntries || 400_000)}\0${Number(options.largeFileBytes || 100 * 1024 * 1024)}`;
  const cached = scanCache.get(key);
  if (cached && Date.now() - cached.createdAt < ttl) return cached.value;
  const value = scanPathUsage(path, options);
  scanCache.set(key, { createdAt: Date.now(), value });
  return value;
}

function parseWorktreeBlocks(output) {
  return String(output || "").split(/\r?\n\r?\n/).filter(Boolean).flatMap((block) => {
    const fields = Object.fromEntries(block.split(/\r?\n/).map((line) => {
      const space = line.indexOf(" ");
      return space > 0 ? [line.slice(0, space), line.slice(space + 1)] : [line, true];
    }));
    return fields.worktree ? [{ ...fields, worktree: resolve(fields.worktree) }] : [];
  });
}

function readPathAttestations(events) {
  const attestations = new Map();
  for (const event of events || []) {
    const type = String(event?.asset?.type || "");
    const id = String(event?.asset?.id || "");
    if (!PATH_TYPES.has(type) || !id.startsWith("path-sha256:")) continue;
    const key = `${type}:${id}`;
    if (event.event === "asset.retirement.revoked") { attestations.delete(key); continue; }
    const details = event.details || {};
    if (event.event !== "asset.retired" || event.status !== "retired" || String(details.disposable) !== "true" || String(details.retention) !== "retired") continue;
    if (!FINGERPRINT.test(String(details.contentFingerprint || "")) || !isAbsolute(String(details.path || "")) || !String(details.recoverySource || "").trim()) continue;
    attestations.set(key, {
      path: resolve(details.path),
      expectedBytes: Number(details.expectedBytes),
      fingerprint: String(details.contentFingerprint).toLowerCase(),
      recoverySource: String(details.recoverySource),
      reportSha256: String(details.reportSha256 || ""),
      owner: String(event.owner || ""),
    });
  }
  return attestations;
}

function applyAttestation(asset, attestations) {
  const attestation = attestations.get(`${asset.type}:${asset.id}`);
  if (!attestation) return asset;
  const exact = keyPath(attestation.path) === keyPath(asset.path)
    && attestation.expectedBytes === Number(asset.sizeBytes)
    && attestation.fingerprint === String(asset.lineage?.contentFingerprint || "").toLowerCase()
    && !asset.lineage?.scanTruncated
    && !asset.lineage?.primary
    && !asset.lineage?.dirty
    && !asset.lineage?.lifecycleProtected;
  if (!exact) return { ...asset, retirementBlocked: true, reason: "Retirement evidence no longer matches the live path, byte count, fingerprint, or Git state." };
  return {
    ...asset,
    classification: "reclaimable",
    labels: {
      ...(asset.labels || {}),
      "com.codex.runtime.disposable": "true",
      "com.codex.runtime.retention": "retired",
      "com.codex.runtime.recovery-source": attestation.recoverySource,
    },
    lineage: { ...asset.lineage, retirement: attestation, recoverySource: attestation.recoverySource },
    reason: "Exact path retirement attestation matches the live byte count and content fingerprint.",
  };
}

function candidateRoots(config, projects) {
  const configured = [...(config.worktreeRoots || []), ...(config.residualRoots || [])].filter(Boolean).map((item) => resolve(item));
  const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "worktrees");
  const siblingRoots = projects.flatMap((project) => (project.gitRoots || []).map((root) => dirname(resolve(root))));
  return [...new Set([...configured, codexRoot, ...siblingRoots].filter(existsSync).map(keyPath))];
}

function probableSibling(path, projects, configuredRoots) {
  if (configuredRoots.some((root) => keyPath(dirname(path)) === keyPath(root))) return true;
  if (keyPath(dirname(path)) === keyPath(resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "worktrees"))) return true;
  const name = basename(path).toLowerCase();
  return projects.some((project) => (project.gitRoots || []).some((root) => {
    const base = basename(resolve(root)).toLowerCase();
    return name === base || name.startsWith(`${base}-`);
  }));
}

export function discoverWorktreeAssets(config = {}, projects = [], events = []) {
  const gitRoots = [...new Set([process.env.RUNTIME_ASSET_GIT_ROOT, ...(config.gitRoots || []), ...projects.flatMap((item) => item.gitRoots || [])].filter(Boolean).map((item) => resolve(item)))];
  const registered = new Map();
  for (const gitRoot of gitRoots) {
    if (!existsSync(gitRoot)) continue;
    const blocks = parseWorktreeBlocks(runGit(["worktree", "list", "--porcelain"], gitRoot));
    const primaryGitRoot = blocks[0]?.worktree || gitRoot;
    for (const fields of blocks) {
      const key = keyPath(fields.worktree);
      if (!registered.has(key)) registered.set(key, { fields, gitRoot: primaryGitRoot });
    }
  }
  const roots = candidateRoots(config, projects);
  const candidates = new Map([...registered.keys()].map((key) => [key, registered.get(key).fields.worktree]));
  const codexWorktreeRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "worktrees");
  for (const root of roots) {
    for (const entry of safeEntries(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = resolve(root, entry.name);
      if (keyPath(root) === keyPath(codexWorktreeRoot)) {
        const bucketProjects = safeEntries(path).filter((child) => child.isDirectory() && !child.isSymbolicLink());
        if (bucketProjects.length) {
          for (const child of bucketProjects) {
            const projectPath = resolve(path, child.name);
            candidates.set(keyPath(projectPath), projectPath);
          }
          continue;
        }
      }
      if (probableSibling(path, projects, [...(config.worktreeRoots || []), ...(config.residualRoots || [])].map((item) => resolve(item)))) candidates.set(keyPath(path), path);
    }
  }
  const attestations = readPathAttestations(events);
  const bindings = config.threadBindings || {};
  const assets = [];
  for (const [key, path] of candidates) {
    const registration = registered.get(key);
    const scan = cachedPathUsage(path, config.pathScan || {});
    if (!scan.exists) continue;
    const status = registration ? runGit(["status", "--short"], path, 10_000) : "";
    const remote = registration ? runGit(["remote", "get-url", "origin"], path, 10_000) : "";
    const binding = bindings[path] || bindings[key] || {};
    const completedBinding = ["complete", "completed", "closed", "merged", "retired"].includes(String(binding.status || "").toLowerCase());
    const lifecycleProtected = Boolean(binding.permanent || binding.pinned || (binding.threadId && !completedBinding));
    const primary = registration ? keyPath(registration.gitRoot) === key : false;
    const dirty = Boolean(status);
    const type = registration ? "worktree" : "worktree_residual";
    const artifactBytes = scan.artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
    const rootProject = projects.flatMap((project) => (project.gitRoots || []).map((root) => ({
      project,
      root: resolve(root),
      prefix: basename(resolve(root)).toLowerCase(),
    }))).filter((candidate) => {
      const name = basename(path).toLowerCase();
      return keyPath(path) === keyPath(candidate.root) || name === candidate.prefix || name.startsWith(`${candidate.prefix}-`);
    }).sort((left, right) => right.prefix.length - left.prefix.length)[0]?.project;
    const project = remote || rootProject?.id || "unknown";
    let asset = {
      id: pathAssetId(type, path),
      name: basename(path),
      path,
      type,
      project,
      environment: "local",
      status: registration ? (dirty ? "dirty" : registration.fields.detached ? "detached" : "clean") : "unregistered-residual",
      classification: primary || dirty || lifecycleProtected ? "protected" : "review",
      sizeBytes: scan.sizeBytes,
      accountedBytes: Math.max(0, scan.sizeBytes - artifactBytes),
      unit: "bytes",
      gitSha: registration?.fields.HEAD,
      branch: typeof registration?.fields.branch === "string" ? registration.fields.branch.replace("refs/heads/", "") : "detached-or-unknown",
      labels: {},
      lineage: {
        path,
        allowedRoot: roots.find((root) => within(path, root)) || dirname(path),
        registered: Boolean(registration),
        gitRoot: registration?.gitRoot,
        primary,
        dirty,
        lifecycleProtected,
        remote,
        contentFingerprint: scan.fingerprint,
        entryCount: scan.entryCount,
        scanTruncated: scan.truncated,
        reparsePoints: scan.reparsePoints,
        threadBinding: binding.threadId ? binding : undefined,
      },
      reason: primary ? "Primary checkout is protected." : dirty ? "Contains uncommitted changes." : lifecycleProtected ? "Task binding is active, pinned, permanent, or lacks a completed outcome." : registration ? "Clean registered worktree requires an exact retirement attestation." : "Physical directory is not registered by Git and requires exact retirement evidence.",
    };
    asset = applyAttestation(asset, attestations);
    assets.push(asset);
    for (const artifact of scan.artifacts) {
      let artifactAsset = {
        id: pathAssetId("host_artifact", artifact.path),
        name: basename(artifact.path),
        path: artifact.path,
        type: "host_artifact",
        project,
        environment: "local",
        status: artifact.category,
        classification: "review",
        sizeBytes: artifact.sizeBytes,
        accountedBytes: artifact.sizeBytes,
        unit: "bytes",
        labels: {},
        lineage: {
          path: artifact.path,
          parentAssetId: asset.id,
          parentPath: path,
          allowedRoot: path,
          category: artifact.category,
          contentFingerprint: artifact.fingerprint,
          entryCount: artifact.entryCount,
          scanTruncated: artifact.truncated || scan.truncated,
          reparsePoints: scan.reparsePoints.filter((item) => within(item, artifact.path)),
        },
        reason: "Generated dependency, build, archive, or execution artifact requires exact retirement evidence.",
      };
      artifactAsset = applyAttestation(artifactAsset, attestations);
      assets.push(artifactAsset);
    }
  }
  return assets;
}

export function validatePathRetirementReconciliation(report) {
  const errors = [];
  if (!report || report.schemaVersion !== PATH_RECONCILIATION_SCHEMA) return { ok: false, errors: ["Unsupported path reconciliation schema."] };
  if (report.readOnly !== true || report.actionTaken !== "none") errors.push("Only a read-only, non-executed report can be imported.");
  if (!Array.isArray(report.assets) || report.assets.length === 0) errors.push("At least one exact path asset is required.");
  const seen = new Set();
  for (const asset of report.assets || []) {
    if (!PATH_TYPES.has(asset.type)) errors.push(`Unsupported path asset type: ${asset.type}.`);
    if (!String(asset.id || "").startsWith("path-sha256:")) errors.push("Path asset ID is invalid.");
    if (seen.has(asset.id)) errors.push(`Duplicate path asset ID: ${asset.id}.`);
    seen.add(asset.id);
    if (!isAbsolute(String(asset.path || "")) || pathAssetId(asset.type, asset.path) !== asset.id) errors.push(`Path identity mismatch for ${asset.id}.`);
    if (!FINGERPRINT.test(String(asset.contentFingerprint || ""))) errors.push(`Missing content fingerprint for ${asset.id}.`);
    if (!Number.isFinite(Number(asset.expectedBytes)) || Number(asset.expectedBytes) < 0) errors.push(`Invalid expected bytes for ${asset.id}.`);
    if (asset.disposable !== true || asset.retention !== "retired" || !String(asset.recoverySource || "").trim()) errors.push(`Missing retirement or recovery evidence for ${asset.id}.`);
    if (!String(asset.confidence || "").startsWith("high")) errors.push(`Asset ${asset.id} is not high confidence.`);
  }
  return { ok: errors.length === 0, errors };
}

export function importPathRetirementReconciliation({ reportPath, owner = "platform-engineering" } = {}) {
  if (!isAbsolute(String(reportPath || ""))) throw new Error("Path reconciliation report path must be absolute.");
  const raw = readFileSync(reportPath);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error("Reconciliation JSON must not contain a UTF-8 BOM.");
  const report = JSON.parse(raw.toString("utf8"));
  const validation = validatePathRetirementReconciliation(report);
  if (!validation.ok) throw new Error(`Path reconciliation report is invalid: ${validation.errors.join("; ")}`);
  const reportSha256 = createHash("sha256").update(raw).digest("hex");
  const ledgerPath = process.env.RUNTIME_ASSET_LEDGER_FILE || join(defaultStateRoot(), "events.jsonl");
  const existing = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const existingKeys = new Set(existing.filter((event) => event.event === "asset.retired").map((event) => `${event.asset?.type}\0${event.asset?.id}\0${event.details?.reportSha256}`));
  const events = [];
  for (const asset of report.assets) {
    const key = `${asset.type}\0${asset.id}\0${reportSha256}`;
    if (existingKeys.has(key)) continue;
    events.push({
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      event: "asset.retired",
      host: hostname(),
      project: String(asset.project || report.target?.project || "host"),
      environment: "local",
      release: String(asset.outcomeId || report.outcomeId || "path-reconciliation"),
      gitSha: String(asset.gitSha || "unknown"),
      owner: String(asset.owner || owner),
      asset: { type: asset.type, id: asset.id },
      status: "retired",
      details: {
        disposable: "true",
        retention: "retired",
        path: resolve(asset.path),
        expectedBytes: Number(asset.expectedBytes),
        contentFingerprint: String(asset.contentFingerprint).toLowerCase(),
        recoverySource: String(asset.recoverySource),
        threadId: asset.threadId,
        outcomeId: asset.outcomeId,
        reportPath,
        reportSha256,
        confidence: asset.confidence,
      },
    });
  }
  if (events.length) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return { importedAt: new Date().toISOString(), reportPath, reportSha256, candidatePathCount: report.assets.length, retirementEventsAdded: events.length, idempotentSkipCount: report.assets.length - events.length };
}

function fileIdentity(path) {
  const stats = lstatSync(path);
  return { dev: String(stats.dev), ino: String(stats.ino), mode: Number(stats.mode), birthtimeMs: Math.trunc(Number(stats.birthtimeMs || 0)), reparse: stats.isSymbolicLink() };
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeMs === right.birthtimeMs && left.reparse === right.reparse;
}

function removeTreeNoFollow(path, guard = () => true) {
  if (!guard()) throw new Error("Managed root or parent identity changed during cleanup.");
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    if (!guard()) throw new Error("Managed root or parent identity changed during cleanup.");
    try { unlinkSync(path); } catch (error) { chmodSync(path, 0o600); unlinkSync(path); }
    return;
  }
  for (const entry of safeEntries(path)) removeTreeNoFollow(join(path, entry.name), guard);
  if (!guard()) throw new Error("Managed root or parent identity changed during cleanup.");
  try { rmdirSync(path); } catch (error) { chmodSync(path, 0o700); rmdirSync(path); }
}

function quarantineAndRemove(path, allowedRoot) {
  if (!canonicalPathContainment(path, allowedRoot)) throw new Error("Path ancestry changed before isolation.");
  const parent = dirname(path);
  const rootIdentity = fileIdentity(allowedRoot);
  const parentIdentity = fileIdentity(parent);
  const targetIdentity = fileIdentity(path);
  const quarantine = join(parent, `.runtime-asset-trash-${randomUUID()}`);
  const guard = () => {
    try {
      return sameFileIdentity(rootIdentity, fileIdentity(allowedRoot))
        && sameFileIdentity(parentIdentity, fileIdentity(parent))
        && canonicalPathContainment(quarantine, allowedRoot);
    } catch {
      return false;
    }
  };
  renameSync(path, quarantine);
  try {
    if (existsSync(path) || !sameFileIdentity(targetIdentity, fileIdentity(quarantine)) || !guard()) throw new Error("Path identity changed while isolating the cleanup target.");
    removeTreeNoFollow(quarantine, guard);
    if (existsSync(quarantine)) throw new Error("Isolated path still exists after cleanup.");
  } catch (error) {
    try {
      if (!existsSync(path) && existsSync(quarantine) && guard()) renameSync(quarantine, path);
    } catch {}
    throw error;
  }
}

export function executePathAssetCleanup(asset, { beforeIsolation } = {}) {
  if (!PATH_TYPES.has(asset?.type) || (asset.classification !== "reclaimable" && asset.retirementState !== "executable-candidate")) throw new Error("Path asset is not reclaimable.");
  const path = resolve(asset.path || asset.lineage?.path || "");
  const allowedRoot = resolve(asset.lineage?.allowedRoot || "");
  if (!path || !allowedRoot || !canonicalPathContainment(path, allowedRoot)) throw new Error("Path cleanup target is outside its canonical allowed root, crosses a reparse point, or no longer exists.");
  const current = scanPathUsage(path);
  if (current.truncated || current.sizeBytes !== Number(asset.sizeBytes) || current.fingerprint !== asset.lineage?.contentFingerprint) throw new Error("Path content changed after preview.");
  if (asset.type === "worktree") {
    if (asset.lineage?.primary || asset.lineage?.dirty || !asset.lineage?.gitRoot) throw new Error("Primary or dirty worktree cleanup is blocked.");
    const registered = parseWorktreeBlocks(runGit(["worktree", "list", "--porcelain"], asset.lineage.gitRoot)).some((item) => keyPath(item.worktree) === keyPath(path));
    if (!registered) throw new Error("Registered worktree identity changed after preview.");
    const output = runGit(["worktree", "remove", "--", path], asset.lineage.gitRoot, 120_000);
    if (existsSync(path)) throw new Error(output || "Git did not remove the exact worktree.");
    return { output, removed: true };
  }
  if (beforeIsolation) beforeIsolation();
  quarantineAndRemove(path, allowedRoot);
  if (existsSync(path)) throw new Error("Exact path still exists after cleanup.");
  return { removed: true };
}
