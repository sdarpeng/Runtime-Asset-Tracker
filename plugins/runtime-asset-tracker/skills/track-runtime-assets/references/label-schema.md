# Runtime asset label schema

Use string values for every label.

| Label | Meaning | Example |
| --- | --- | --- |
| `com.codex.runtime.project` | Stable cross-environment project key | `sparklingplaycms` |
| `com.codex.runtime.environment` | Runtime environment | `local`, `staging`, `production`, `ci` |
| `com.codex.runtime.release` | Release identifier or `development` | `release-f85160b1-20260802` |
| `com.codex.runtime.git-sha` | Full Git commit, when known | `f85160b1...` |
| `com.codex.runtime.owner` | Accountable owner | `platform-engineering` |
| `com.codex.runtime.asset-kind` | `image`, `container`, `volume`, or `network` | `volume` |
| `com.codex.runtime.service` | Logical service | `api`, `web`, `postgres` |
| `com.codex.runtime.retention` | Retention intent | `development`, `release`, `rollback`, `cache`, `protected` |
| `com.codex.runtime.disposable` | Whether policy may ever treat it as disposable | `true` or `false` |
| `com.codex.runtime.created-by` | Creating entrypoint | `docker-compose`, `deploy-prod.sh`, `ci` |

Keep `org.opencontainers.image.revision` for image-to-Git mapping. Add `org.opencontainers.image.source` when a stable repository URL is known.

`disposable=true` is only eligibility metadata. It is never deletion authorization. Active references, retention, age, ownership, and project cleanup policy still apply.
