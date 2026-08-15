# Runtime asset label schema

Use string values for every label.

| Label | Meaning | Example |
| --- | --- | --- |
| `com.codex.runtime.project` | Stable cross-environment project key | `sparklingplaycms` |
| `com.codex.runtime.environment` | Runtime environment | `local`, `staging`, `production`, `ci` |
| `com.codex.runtime.release` | Release identifier or `development` | `release-f85160b1-20260802` |
| `com.codex.runtime.git-sha` | Full Git commit, when known | `f85160b1...` |
| `com.codex.runtime.pull-request` | Authoritative pull-request number when the build entrypoint knows it | `28` |
| `com.codex.runtime.task-id` | Stable Codex task/outcome binding, not a display name | `019fa236-...` |
| `com.codex.runtime.owner` | Accountable owner | `platform-engineering` |
| `com.codex.runtime.asset-kind` | `image`, `container`, `volume`, or `network` | `volume` |
| `com.codex.runtime.service` | Logical service | `api`, `web`, `postgres` |
| `com.codex.runtime.retention` | Retention intent | `development`, `release`, `rollback`, `cache`, `protected` |
| `com.codex.runtime.disposable` | Whether policy may ever treat it as disposable | `true` or `false` |
| `com.codex.runtime.created-by` | Creating entrypoint | `docker-compose`, `deploy-prod.sh`, `ci` |
| `com.codex.runtime.expires-at` | Explicit ISO-8601 expiry instant | `2026-08-10T03:00:00Z` |
| `com.codex.runtime.retention-until` | Alias for a retention deadline when policy terminology is preferred | `2026-08-10T03:00:00Z` |
| `com.codex.runtime.ttl-days` | Lifetime in days, calculated from the asset creation time | `14` |
| `com.codex.runtime.recovery-source` | How the asset can be recreated or restored | `github-actions`, `release-f85160b1`, `database-backup` |

Keep `org.opencontainers.image.revision` for image-to-Git mapping. Add `org.opencontainers.image.source` when a stable repository URL is known.

`disposable=true` is only eligibility metadata. It is never deletion authorization. Active references, retention, age, ownership, and project cleanup policy still apply.

Use `pull-request` only when CI, GitHub, or another authoritative build entrypoint supplies the number. Never derive this label from a directory name after the fact. A merged PR remains retained until the configured cooling period completes and current, rollback, recovery, container-reference, volume-mount, and path-fingerprint checks all pass.

An asset with a future expiry is retained until that instant. During the final seven days it is shown as `expiring` (orange), not `reclaimable`. Prefer `expires-at` when an exact deadline is known; use `ttl-days` only when Docker exposes a trustworthy creation time. Unknown or malformed expiry values fail closed into the retained/review class.
