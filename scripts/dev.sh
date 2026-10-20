#!/usr/bin/env bash
# Единая точка входа dev-стека для macOS и Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUNTIME="${NODE_BIN:-node}"
if ! NODE_RUNTIME="$(command -v "$NODE_RUNTIME")"; then
    printf '\nОшибка: не найден Node.js. Установите Node.js 24+ или задайте NODE_BIN.\n' >&2
    exit 127
fi
# Разрешаем относительный Node до смены каталога, затем запускаем из живого корня проекта.
if [[ "$NODE_RUNTIME" != /* ]]; then
    NODE_RUNTIME="$(cd "$(dirname "$NODE_RUNTIME")" && pwd)/$(basename "$NODE_RUNTIME")"
fi
if [[ -n "${NODE_BIN:-}" ]]; then export NODE_BIN="$NODE_RUNTIME"; fi
cd "$ROOT"
exec "$NODE_RUNTIME" "$ROOT/scripts/dev.mjs" "$@"
