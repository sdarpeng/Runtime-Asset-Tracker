# Runtime Asset Tracker UI Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Registered projects are authoritative GitHub repositories. The global project selector is the highest UI context and must always remain visible beneath the product brand. Worktrees and Docker assets belong to those projects but must never create project choices by themselves. Remove environment/project mode tabs and do not add a second repository selector on the GitHub view.

Derive Local, EC2, and GitHub sources from the selected project. Never show, query, preview cleanup for, or mutate an EC2 environment owned by another project. A project without a registered EC2 environment shows only its registered Local and GitHub sources.

The GitHub source is a delivery view, not a Docker host. Its four persistent categories are Pull Requests, Actions Artifacts, Actions Cache, and Workflow Runs. Show PR lifecycle state and never reuse Docker Images or Docker Volumes labels on this source.

Use five visible capacity states: active, protected, retained/review, expiring, and safely reclaimable. Yellow means retained or evidence is incomplete; orange means an explicit or source-native expiry falls inside the configured warning window; cyan alone means the asset is currently eligible for the exact cleanup preview. Expiring assets must never become cleanup candidates before their expiry and all other safety conditions pass.

Keep the bottom actions in this order: Deep Scan, Scheduled Cleanup, Immediate Cleanup. Deep Scan is always scoped to the globally selected project and selected source. It is read-only: it may refresh lineage evidence and classification in the current view, but it must not delete, relabel, stop, restart, or otherwise mutate assets. Show a result report with ownership, consumers, revision/release, retention/expiry, recovery evidence, missing evidence, and any newly established reclaimable capacity.
