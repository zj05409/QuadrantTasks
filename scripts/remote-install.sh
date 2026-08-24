#!/usr/bin/env bash
# Idempotent remote install onto tencent-superhealth (run from laptop after package.sh).
# Usage: HOST=tencent-superhealth TOKEN=xxx bash scripts/remote-install.sh [/tmp/quadrant-tasks-web.tgz]
set -euo pipefail
HOST="${HOST:-tencent-superhealth}"
TGZ="${1:-/tmp/quadrant-tasks-web.tgz}"
TOKEN="${TOKEN:?Set TOKEN env to the bearer secret}"

[[ -f "$TGZ" ]] || { echo "missing $TGZ — run make package first"; exit 1; }

scp "$TGZ" "$HOST:/tmp/quadrant-tasks-web.tgz"
ssh "$HOST" "bash -s" <<EOF
set -euo pipefail
sudo mkdir -p /opt/quadrant-tasks /var/lib/quadrant-tasks
sudo tar xzf /tmp/quadrant-tasks-web.tgz -C /opt/quadrant-tasks
sudo chown -R ubuntu:ubuntu /opt/quadrant-tasks /var/lib/quadrant-tasks
cd /opt/quadrant-tasks
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
sudo tee /etc/quadrant-tasks.env >/dev/null <<ENV
QUADRANT_TOKEN=${TOKEN}
QUADRANT_DATA_DIR=/var/lib/quadrant-tasks
ENV
sudo chmod 600 /etc/quadrant-tasks.env
sudo cp deploy/quadrant-tasks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quadrant-tasks
sudo systemctl restart quadrant-tasks
sleep 1
curl -sS http://127.0.0.1:18765/api/health
echo
EOF
