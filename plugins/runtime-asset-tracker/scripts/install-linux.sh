#!/usr/bin/env bash
set -euo pipefail

PROJECT="unknown"
ENVIRONMENT="unknown"
OWNER="platform-engineering"
LEDGER_FILE="/var/lib/runtime-asset-tracker/events.jsonl"
NODE_BIN="$(command -v node || true)"
PYTHON_BIN="$(command -v python3 || true)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --ledger-file) LEDGER_FILE="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || { echo "Run install-linux.sh as root." >&2; exit 1; }
if [[ -x "$NODE_BIN" ]]; then
  RUNTIME_BIN="$NODE_BIN"
  RUNTIME_SCRIPT="runtime-asset-ledger.mjs"
elif [[ -x "$PYTHON_BIN" ]]; then
  RUNTIME_BIN="$PYTHON_BIN"
  RUNTIME_SCRIPT="runtime-asset-ledger.py"
else
  echo "Neither Node.js nor Python 3 was found. Use --node or --python with an absolute executable path." >&2
  exit 1
fi
[[ "$PROJECT" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid project key." >&2; exit 1; }
[[ "$ENVIRONMENT" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid environment key." >&2; exit 1; }
[[ "$OWNER" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid owner key." >&2; exit 1; }
[[ "$LEDGER_FILE" == /* ]] || { echo "--ledger-file must be absolute." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/usr/local/lib/runtime-asset-tracker"
install -d -m 0755 "$INSTALL_DIR"
[[ ! -f "$SCRIPT_DIR/runtime-asset-ledger.mjs" ]] || install -m 0755 "$SCRIPT_DIR/runtime-asset-ledger.mjs" "$INSTALL_DIR/runtime-asset-ledger.mjs"
[[ ! -f "$SCRIPT_DIR/runtime-asset-ledger.py" ]] || install -m 0755 "$SCRIPT_DIR/runtime-asset-ledger.py" "$INSTALL_DIR/runtime-asset-ledger.py"
[[ -f "$INSTALL_DIR/$RUNTIME_SCRIPT" ]] || { echo "Missing tracker script: $RUNTIME_SCRIPT" >&2; exit 1; }
install -d -m 0750 "$(dirname "$LEDGER_FILE")"

cat >/etc/runtime-asset-tracker.env <<EOF
RUNTIME_ASSET_PROJECT=$PROJECT
RUNTIME_ASSET_ENVIRONMENT=$ENVIRONMENT
RUNTIME_ASSET_OWNER=$OWNER
RUNTIME_ASSET_LEDGER_FILE=$LEDGER_FILE
EOF
chmod 0640 /etc/runtime-asset-tracker.env

cat >/etc/systemd/system/runtime-asset-tracker.service <<EOF
[Unit]
Description=Runtime Asset Tracker Docker event ledger
After=docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/runtime-asset-tracker.env
ExecStart=$RUNTIME_BIN $INSTALL_DIR/$RUNTIME_SCRIPT watch
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/logrotate.d/runtime-asset-tracker <<EOF
$LEDGER_FILE {
  weekly
  rotate 12
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  create 0600 root root
}
EOF

cat >/usr/local/bin/runtime-asset-ledger <<EOF
#!/usr/bin/env bash
exec "$RUNTIME_BIN" "$INSTALL_DIR/$RUNTIME_SCRIPT" "\$@"
EOF
chmod 0755 /usr/local/bin/runtime-asset-ledger

systemctl daemon-reload
systemctl enable --now runtime-asset-tracker.service
systemctl --no-pager --full status runtime-asset-tracker.service
echo "Runtime Asset Tracker installed with $RUNTIME_SCRIPT. Docker and application containers were not restarted."
