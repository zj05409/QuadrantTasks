#!/usr/bin/env bash
# Idempotent remote install onto tencent-superhealth (run from laptop after package.sh).
# Usage: HOST=tencent-superhealth [TOKEN=xxx] [CORS_ORIGINS=https://you.github.io] \
#          [INVITE_CODE=xxx] bash scripts/remote-install.sh [/tmp/quadrant-tasks-web.tgz]
# Existing /etc/quadrant-tasks.env is kept; only the variables you pass are updated.
set -euo pipefail
HOST="${HOST:-tencent-superhealth}"
TGZ="${1:-/tmp/quadrant-tasks-web.tgz}"
TOKEN="${TOKEN:-}"
CORS_ORIGINS="${CORS_ORIGINS:-}"
INVITE_CODE="${INVITE_CODE:-}"

[[ -f "$TGZ" ]] || { echo "missing $TGZ — run make package first"; exit 1; }

scp "$TGZ" "$HOST:/tmp/quadrant-tasks-web.tgz"
ssh "$HOST" "TOKEN='${TOKEN}' CORS_ORIGINS='${CORS_ORIGINS}' INVITE_CODE='${INVITE_CODE}' bash -s" <<'EOF'
set -euo pipefail
ENV_FILE=/etc/quadrant-tasks.env
sudo mkdir -p /opt/quadrant-tasks /var/lib/quadrant-tasks
sudo tar xzf /tmp/quadrant-tasks-web.tgz -C /opt/quadrant-tasks
sudo chown -R ubuntu:ubuntu /opt/quadrant-tasks /var/lib/quadrant-tasks
cd /opt/quadrant-tasks
python3 -m venv .venv
.venv/bin/pip install -q -U pip
.venv/bin/pip install -q -r requirements.txt

# set_env KEY VALUE: add or replace one line, leave the rest of the file alone.
set_env() {
  sudo touch "$ENV_FILE"
  sudo sed -i "/^$1=/d" "$ENV_FILE"
  echo "$1=$2" | sudo tee -a "$ENV_FILE" >/dev/null
}
sudo grep -q '^QUADRANT_DATA_DIR=' "$ENV_FILE" 2>/dev/null || set_env QUADRANT_DATA_DIR /var/lib/quadrant-tasks
[[ -n "$TOKEN" ]] && set_env QUADRANT_TOKEN "$TOKEN"
[[ -n "$CORS_ORIGINS" ]] && set_env QUADRANT_CORS_ORIGINS "$CORS_ORIGINS"
[[ -n "$INVITE_CODE" ]] && set_env QUADRANT_INVITE_CODE "$INVITE_CODE"
sudo chmod 600 "$ENV_FILE"
sudo chown root:root "$ENV_FILE"

sudo cp deploy/quadrant-tasks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable quadrant-tasks
sudo systemctl restart quadrant-tasks
sleep 1
curl -sS http://127.0.0.1:18765/api/health
echo
EOF
