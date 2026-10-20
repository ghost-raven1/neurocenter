#!/usr/bin/env bash
# Переносимый архив содержит код и lock-файл, а зависимости ставятся на целевой машине.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DIR="$PROJECT_DIR/mcp/neurocenter-asset-sync"
test -f "$BRIDGE_DIR/dist/index.js"
mkdir -p "$PROJECT_DIR/bridge-dist"
COPYFILE_DISABLE=1 tar -czf "$PROJECT_DIR/bridge-dist/neurocenter-asset-sync.tgz" -C "$BRIDGE_DIR" dist package.json package-lock.json
