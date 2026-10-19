#!/usr/bin/env bash
# Единая точка входа dev-стека для macOS и Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "${NODE_BIN:-node}" "$ROOT/scripts/dev.mjs" "$@"
