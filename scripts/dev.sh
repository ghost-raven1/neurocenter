#!/usr/bin/env bash
# Единая точка входа dev-стека для macOS и Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUNTIME="${NODE_BIN:-node}"
if ! command -v "$NODE_RUNTIME" >/dev/null 2>&1; then
    printf '\nОшибка: не найден Node.js. Установите Node.js 24+ или задайте NODE_BIN.\n' >&2
    exit 127
fi
exec "$NODE_RUNTIME" "$ROOT/scripts/dev.mjs" "$@"
