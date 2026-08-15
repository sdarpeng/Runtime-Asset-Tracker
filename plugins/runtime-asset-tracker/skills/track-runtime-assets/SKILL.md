---
name: track-runtime-assets
description: Add, inspect, or repair cross-project Docker and host runtime-asset tracking using portable labels, real-byte worktree scans, and an append-only JSONL event ledger. Use when a user asks to track builds, Compose operations, images, containers, volumes, Git worktrees, residual directories, generated artifacts, deployments, releases, retention metadata, cleanup evidence, or install the Runtime Asset Tracker on local, staging, production, EC2, VM, or CI hosts.
---

# Track Runtime Assets

Track lifecycle facts; do not create a new release-approval system. Ledger writes must be best-effort at build/deploy entrypoints, so an unavailable tracker warns but does not block an otherwise valid build or deployment.

## Workflow

1. Inspect the project's Dockerfiles, Compose files, build commands, deploy scripts, release layout, and existing OCI labels.
2. Read [label-schema.md](references/label-schema.md) and select stable values for project, environment, release, retention, and disposability.
3. Add labels to image builds, Compose services, and named volumes. Treat stateful volumes as protected and non-disposable.
4. Vendor `scripts/runtime-asset-ledger.mjs` and optionally `scripts/run-compose.mjs` into the project, or invoke the plugin copies directly.
5. Record build start/completion/failure, Compose command start/completion/failure, deployment promotion/rollback, and exact image IDs.
6. Install the Docker event watcher with `install-linux.sh` or `Install-Windows.ps1` when the user wants host-wide tracking. The Linux installer uses Node.js when available and otherwise falls back to the bundled standard-library Python 3 implementation; do not install a new runtime merely for the tracker.
7. Run `snapshot` to reconcile assets created before installation.
8. Validate Compose configuration and exercise the ledger with a harmless synthetic event. Do not build, restart, deploy, or delete assets unless the user authorized those operations.

For local worktrees, measure filesystem bytes rather than counting directories. Discover both Git-registered worktrees and physical residuals under configured `worktreeRoots`/`residualRoots`, sibling directories whose names share a registered repository prefix, and the Codex worktree root. Record nested dependency, build, archive, split-part, and execution artifacts separately without double-counting their bytes. Never traverse symbolic links or Windows directory junctions.

## Dashboard

Use the bundled `open_runtime_dashboard` MCP tool when the user wants a graphical inventory, project-scoped environment comparison, capacity map, asset drill-down, or event timeline. The selected registered project is always the top-level context; only that project's Local, EC2, and GitHub sources may be shown or queried. The dashboard uses live local Docker, Git worktree, and ledger data. GitHub snapshots use the authenticated `gh` CLI; EC2 snapshots use authenticated AWS Systems Manager Run Command and execute read-only inventory commands. Configured remote sources must show an explicit unavailable or authentication-error state until their adapter returns real data; never substitute local values or another project's environments.

Remote cleanup is deliberately narrow and always starts with an exact preview. For EC2, safely reclaimable images are limited to images that are not referenced by any running or stopped container and are either dangling or explicitly attested `disposable=true`; protected retention always wins. Safely reclaimable volumes must be unreferenced by every container, explicitly attested `disposable=true`, and free of database, upload, media, backup, or other protected-state signals. Unused Docker BuildKit cache is also eligible. Exact merged-PR containers may be stopped and removed only when their full ID, name, image ID, Compose project, state, mount set, recovery source, completed cooling period, and `preserveVolumes=true` contract are attested. Exact remote paths may be removed only below a registered managed root with matching bytes and metadata fingerprint, zero bind-mount consumers, and no current/rollback/protected-path overlap. Networks, rollback state, unmanaged directories, and unknown volumes remain excluded. For GitHub, cleanup is limited to exact cache or artifact IDs that are independently reclassified as safe immediately before deletion: expired artifacts, caches belonging to closed pull requests, or caches not accessed for more than 30 days. A disconnected source remains unavailable instead of falling back to local data.

For local standalone preview, run `node dist/server.mjs --http` from the plugin root and open `http://127.0.0.1:47831`.

Before cleanup:

1. Call `build_unified_asset_table` for one registered project to correlate full Local, Production, and Staging inventories with an authoritative GitHub revision/PR report. A merged PR is a lifecycle signal, never deletion authorization. Current/rollback assets and unknown or name-only relationships remain protected/review.
2. When historical remote images cannot carry new OCI labels, call `import_retirement_reconciliation` with an absolute machine-readable report path and exact high-confidence groups. The import appends retirement and protection attestations; it never deletes images.
3. For merged-PR containers, volumes, images, or managed remote paths, call `import_unified_retirement_reconciliation` with a `sparkling.runtime-unified-retirement-reconciliation/v1` report. Require authoritative merge time, completed cooling period, exact identity, recovery source, and type-specific reference/mount/fingerprint evidence.
4. For a local Git worktree, unregistered residual, or host artifact, call `import_path_retirement_reconciliation` with a `sparkling.runtime-path-retirement-reconciliation/v1` report. Every candidate must bind its derived path asset ID, absolute path, measured bytes, content fingerprint, high confidence, explicit recovery source, and retired/disposable status. Optional `threadId` and `outcomeId` fields bind the filesystem asset to a completed Codex task outcome; the Tracker does not infer task completion from similar directory names.
5. Call `preview_cleanup` to create the exact expiring allowlist. Use `assetIds` when the authorized scope is an exact subset.
6. Show protected and excluded assets, exact IDs, paths or tags, Git revision, recovery evidence, fingerprints, release/runtime drift status, and measured bytes alongside the candidate total.
7. Call `execute_cleanup` only after the user confirms that exact preview. The server must re-read and revalidate every candidate before mutation.
8. Multi-tag images are one atomic unit: revalidate that every approved tag still resolves to the approved image ID, remove every exact tag without `--force`, and fail if the image remains.
9. Registered worktrees must be clean, non-primary, still registered by the same Git root, and removed with `git worktree remove` without force. Residuals and artifacts must remain under their exact allowed root; unlink reparse points instead of traversing them.
10. Re-scan after cleanup and report missing active containers, paths or images that survived deletion, and the actual free-space delta.

A reconciliation import must fail closed when the project, environment, instance, image ID, tag set, Git revision, group confidence, byte totals, or current/rollback protection set is inconsistent. A release-directory revision that differs from the running production image blocks cleanup unless the same reconciliation report explicitly protects both the running image and the release-revision rollback image.

The schedule editor persists report-only inventory schedules. It must not silently enable unattended deletion.

## Commands

Record an event:

```text
runtime-asset-ledger record --event build.started --project my-project --environment local --detail service=api
```

Record an exact image after a build:

```text
runtime-asset-ledger image --event build.completed --image my-api:latest --project my-project --environment local --service api
```

Capture a reconciliation snapshot:

```text
runtime-asset-ledger snapshot --project my-project --environment staging
```

Wrap a supported Compose entrypoint:

```text
node scripts/run-compose.mjs --project my-project --environment local -- up --build
```

## Safety

- Never include secrets, environment variable values, registry credentials, or arbitrary Docker event attributes in the ledger.
- Never infer that an unlabeled or old volume is disposable.
- Use `disposable=false` and `retention=protected` for databases, uploads, queues, caches with business value, and rollback state.
- Do not make ledger availability a build or deployment gate.
- Do not remove existing OCI revision/source labels; extend them.
- Preserve project-specific release and rollback behavior.
- A tracker installation may start a new observer process, but must not restart Docker or application containers.
- Never broaden EC2 cleanup into `docker system prune`, bulk image/volume prune, forced image deletion, broad container deletion, or broad release-directory removal. Delete only exact IDs/paths covered by a valid retirement attestation that pass the same live safety checks immediately before removal; container removal must never include `-v`.
- Never treat PR merge alone as deletion authority. Require the cooling period plus exact runtime/path lineage, and keep current, rollback, recovery, shared, referenced, or ambiguous assets out of the token.
- Never delete a GitHub cache or artifact solely because it is large; it must satisfy the explicit safe classification and exact-ID revalidation rules.
- Never treat `v1`/`v2` names, age, similar task names, a clean branch, or an unregistered directory as deletion authorization. Missing task outcome, recovery, byte, or fingerprint evidence remains `review`.
- Never remove the primary checkout or a dirty worktree. Never follow reparse points during scanning or deletion.

## Bundled Resources

- `../../scripts/runtime-asset-ledger.mjs`: event writer, image inspector, Docker event watcher, and snapshot tool.
- `../../scripts/runtime-asset-ledger.py`: standard-library Python 3 fallback for Linux hosts without Node.js.
- `../../scripts/run-compose.mjs`: tracked Compose command wrapper.
- `../../scripts/install-linux.sh`: systemd installation for Linux hosts.
- `../../scripts/Install-Windows.ps1`: per-user Windows installation and startup registration.
- `../../dist/server.mjs`: bundled MCP server and local dashboard endpoint.
- `../../dist/dashboard.html`: self-contained MCP Apps dashboard resource.
- `../../assets/dashboard-config.example.json`: cross-project source configuration example.
- `../../assets/compose-labels.example.yml`: Compose label example.
- `../../assets/runtime-asset.env.example`: environment defaults.
