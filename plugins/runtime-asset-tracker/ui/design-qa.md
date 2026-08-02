# Runtime Asset Tracker — Design QA

## Source of truth

- Reference: `C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-4cc00cf5-fdef-4e75-b481-0ea7e2526ebf.png`
- Reference size: 1549 × 846 px
- Local implementation: `C:\Users\Administrator\plugins\runtime-asset-tracker\assets\runtime-asset-dashboard.png`
- GitHub implementation: `C:\Users\Administrator\plugins\runtime-asset-tracker\assets\runtime-asset-dashboard-github.png`
- Implementation size: 1521 × 834 px
- Browser viewport override used for visual comparison: 1536 × 842 CSS px
- Target state: desktop dashboard with one selected data source and live snapshot loaded

## Visual comparison

- Full-page comparison: `design-qa-comparison.png`
- Focused high-risk action comparison: `design-qa-action-dock.png`
- The implementation preserves the prototype's scope toggle, source rail, four capacity bands, classification colors, and bottom schedule/clean action area.
- The implementation adds readable classification labels, real totals, an asset table, an event ledger, and persistent safety guidance without changing the reference hierarchy.
- GitHub uses the same visual language and selects Build Cache automatically because that is the relevant asset class.

## Interaction and safety checks

- Browser title is `Runtime Asset Tracker`; the scaffold title `Prototype` is absent.
- Environment/project toggle and project filtering: passed.
- Local inventory, worktree, Docker image, Docker volume, and ledger rendering: passed.
- GitHub live snapshot: passed; 4 Actions caches, 342 MB, and 30 workflow events loaded from the authenticated GitHub API.
- Staging live snapshot: passed through AWS Systems Manager; 149 Docker images, 26 Docker volumes, 7.35 GB of build cache, and 24 recent ledger events were read without changing the host.
- Production unavailable state: passed; the instance is running but is not online in Systems Manager, so the UI clears all remote values, shows a visible error, and never reuses local data.
- Remote action lock: passed; cleanup and schedule buttons are disabled for Production, Staging, and GitHub.
- Local cleanup preview: passed; 0 eligible candidates kept the confirmation button disabled.
- Console warnings/errors: none.
- MCP stdio tool/resource discovery: passed.
- Standalone HTTP dashboard and REST fallback: passed.

## Defect history

1. P1 — Switching to an EC2 source briefly retained local metrics and asset rows. Fixed by clearing client state immediately and returning only source-specific snapshots.
2. P1 — Remote views exposed local cleanup controls. Fixed by disabling both cleanup entrypoints for every non-local source; server-side cleanup remains local-only.
3. P2 — Remote empty-state requests unnecessarily performed a full local inventory scan. Fixed with source-specific collection and per-source caching.
4. P2 — The page retained the scaffold title `Prototype`. Fixed in `ui/index.html` and covered by an automated test.

final result: passed
