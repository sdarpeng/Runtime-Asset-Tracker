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
- Staging live snapshot: passed through AWS Systems Manager; the latest read-only snapshot contains 149 Docker images and 26 Docker volumes. It measures 58.22 GB of image storage and 5.07 GB of volume storage without changing the host.
- Production unavailable state: passed; the instance is running but is not online in Systems Manager, so the UI clears all remote values, shows a visible error, and never reuses local data.
- Remote capacity classification: passed; the latest Staging snapshot currently has no image, volume, or BuildKit cache asset satisfying the safe rules, so its safe segment is correctly 0 B rather than presenting unlabeled legacy assets as safe. A prior snapshot correctly identified 7.35 GB of unused BuildKit cache, and GitHub identified 86.3 MB of closed-PR cache.
- Remote cleanup entrypoints: passed; connected Staging and GitHub sources can open an exact cleanup preview. Production remains disabled only because its Systems Manager connection is offline, and will enable automatically when its live snapshot becomes available.
- Remote image and volume analysis: passed; every running and stopped container reference is mapped, image unique-layer sizes and real volume sizes are read from Docker, and the safe segment contains only exact image/volume IDs that satisfy the declared rules.
- Remote safety boundary: passed; EC2 image deletion is limited to unreferenced dangling or explicitly disposable images, volume deletion to unreferenced explicitly disposable non-business volumes, and cache deletion to unused BuildKit cache. Execution repeats the reference, label, and protected-name checks and never uses forced or broad prune operations. GitHub remains limited to exact revalidated cache/artifact IDs.
- Local cleanup preview: passed; 0 eligible candidates kept the confirmation button disabled.
- Console warnings/errors: none.
- MCP stdio tool/resource discovery: passed.
- Standalone HTTP dashboard and REST fallback: passed.

## Defect history

1. P1 — Switching to an EC2 source briefly retained local metrics and asset rows. Fixed by clearing client state immediately and returning only source-specific snapshots.
2. P1 — Remote views originally exposed local-only cleanup controls. Initially fixed by disabling remote cleanup, then replaced with source-aware exact previews and server-side revalidation for the narrowly defined safe EC2/GitHub cleanup scopes.
3. P2 — Remote empty-state requests unnecessarily performed a full local inventory scan. Fixed with source-specific collection and per-source caching.
4. P2 — The page retained the scaffold title `Prototype`. Fixed in `ui/index.html` and covered by an automated test.
5. P1 — Remote capacity was presented entirely as `待确认`, even when Docker or GitHub reported safely reclaimable cache. Fixed by mapping source-native reclaimable bytes into the safe segment and validating the exact candidates.

final result: passed
