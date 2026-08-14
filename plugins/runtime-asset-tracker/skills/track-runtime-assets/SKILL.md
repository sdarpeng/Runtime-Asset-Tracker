---
name: track-runtime-assets
description: Add, inspect, or repair cross-project Docker runtime-asset tracking using portable labels and an append-only JSONL event ledger. Use when a user asks to track builds, Compose operations, images, containers, volumes, networks, deployments, releases, retention metadata, Docker cleanup evidence, or install the Runtime Asset Tracker on local, staging, production, EC2, VM, or CI hosts.
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

## Dashboard

Use the bundled `open_runtime_dashboard` MCP tool when the user wants a graphical inventory, project-scoped environment comparison, capacity map, asset drill-down, or event timeline. The selected registered project is always the top-level context; only that project's Local, EC2, and GitHub sources may be shown or queried. The dashboard uses live local Docker, Git worktree, and ledger data. GitHub snapshots use the authenticated `gh` CLI; EC2 snapshots use authenticated AWS Systems Manager Run Command and execute read-only inventory commands. Configured remote sources must show an explicit unavailable or authentication-error state until their adapter returns real data; never substitute local values or another project's environments.

Remote cleanup is deliberately narrow and always starts with an exact preview. For EC2, safely reclaimable images are limited to images that are not referenced by any running or stopped container and are either dangling or explicitly labeled `disposable=true`; protected retention always wins. Safely reclaimable volumes must be unreferenced by every container, explicitly labeled `disposable=true`, and free of database, upload, media, backup, or other protected-state signals. Unused Docker BuildKit cache is also eligible. Containers, networks, release directories, rollback state, and unknown volumes are excluded. For GitHub, cleanup is limited to exact cache or artifact IDs that are independently reclassified as safe immediately before deletion: expired artifacts, caches belonging to closed pull requests, or caches not accessed for more than 30 days. A disconnected source remains unavailable instead of falling back to local data.

For local standalone preview, run `node dist/server.mjs --http` from the plugin root and open `http://127.0.0.1:47831`.

Before cleanup:

1. When historical remote images cannot carry new OCI labels, call `import_retirement_reconciliation` with an absolute machine-readable report path and exact high-confidence groups. The import appends retirement and protection attestations; it never deletes images.
2. Call `preview_cleanup` to create the exact expiring allowlist. Use `assetIds` when the authorized scope is an exact subset.
3. Show protected and excluded assets, exact image IDs, every tag, Git revision, recovery evidence, release/runtime drift status, and Docker unique bytes alongside the candidate total.
4. Call `execute_cleanup` only after the user confirms that exact preview. The server must re-read and revalidate remote candidates before mutation.
5. Multi-tag images are one atomic unit: revalidate that every approved tag still resolves to the approved image ID, remove every exact tag without `--force`, and fail if the image remains.
6. Re-scan after cleanup and report missing active containers, images that survived deletion, and the actual free-space delta.

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
- Never broaden EC2 cleanup into `docker system prune`, bulk image/volume prune, forced image deletion, container deletion, or release-directory removal. Delete only exact image or volume IDs that pass the same live safety checks immediately before removal.
- Never delete a GitHub cache or artifact solely because it is large; it must satisfy the explicit safe classification and exact-ID revalidation rules.

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
