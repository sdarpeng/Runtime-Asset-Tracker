# Runtime Asset Tracker

Runtime Asset Tracker is a Codex plugin for inspecting and tracing runtime assets across local projects, Docker hosts, AWS EC2 instances, and GitHub Actions.

It provides:

- A graphical dashboard for worktrees, Docker images, volumes, build cache, and lifecycle events.
- Portable Docker and Compose labels.
- An append-only JSONL event ledger.
- Exact local cleanup previews that only include explicitly disposable assets.
- Read-only AWS Systems Manager snapshots for EC2 Production and Staging.
- Read-only GitHub Actions cache, artifact, and workflow snapshots.

Remote cleanup is intentionally disabled. Unknown volumes and assets without an explicit disposable classification are protected.

![Runtime Asset Tracker dashboard](plugins/runtime-asset-tracker/assets/runtime-asset-dashboard.png)

## Install in Codex

Add this private GitHub repository as a marketplace:

```text
codex plugin marketplace add sdarpeng/Runtime-Asset-Tracker
```

Install the plugin:

```text
codex plugin add runtime-asset-tracker@sparklingplay-runtime-assets
```

Start a new Codex task after installation so the skill and MCP server are loaded.

## Local development

```text
cd plugins/runtime-asset-tracker
npm install
npm run build
npm test
node tests/mcp-smoke.mjs
```

The built MCP server and dashboard are committed under `dist/`, so an installed marketplace copy can start without rebuilding the UI.

## Configuration

Copy `plugins/runtime-asset-tracker/assets/dashboard-config.example.json` to the platform-specific Runtime Asset Tracker state directory and replace the example Git roots, EC2 instance IDs, regions, and GitHub repository.

- Windows: `%LOCALAPPDATA%\RuntimeAssetTracker\dashboard-config.json`
- Linux: `~/.local/state/runtime-asset-tracker/dashboard-config.json`

AWS inventory requires authenticated AWS CLI access and online Systems Manager managed instances. GitHub inventory requires an authenticated GitHub CLI session.

## Repository layout

- `.agents/plugins/marketplace.json` — Codex team marketplace catalog.
- `plugins/runtime-asset-tracker/.codex-plugin/plugin.json` — plugin manifest.
- `plugins/runtime-asset-tracker/dist/` — ready-to-run MCP server and dashboard.
- `plugins/runtime-asset-tracker/skills/` — Codex skill instructions.
- `plugins/runtime-asset-tracker/scripts/` — labeling, Compose, observer, and installer utilities.
