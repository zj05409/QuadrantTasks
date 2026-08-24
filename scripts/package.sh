#!/usr/bin/env bash
# Deployable tarball (repo root, no venv/data/archive/git).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/quadrant-tasks-web.tgz}"
export COPYFILE_DISABLE=1
cd "$ROOT"
tar czf "$OUT" \
  --exclude='.venv' \
  --exclude='data' \
  --exclude='archive' \
  --exclude='.git' \
  --exclude='**/__pycache__' \
  --exclude='.pytest_cache' \
  --exclude='**/.DS_Store' \
  --exclude='**/._*' \
  .
echo "Wrote $OUT ($(du -h "$OUT" | awk '{print $1}'))"
