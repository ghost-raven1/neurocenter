#!/bin/bash
# Единая точка входа dev-стека для macOS и Linux.
set -euo pipefail
SCRIPT_DIRECTORY="${BASH_SOURCE[0]%/*}"
[[ "$SCRIPT_DIRECTORY" != "${BASH_SOURCE[0]}" ]] || SCRIPT_DIRECTORY=.
ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"

# Проверяем версию до ESM imports: старый Node не должен разбирать dev.mjs.
probe_node() {
    local candidate="$1" resolved directory version
    resolved="$(command -v "$candidate" 2>/dev/null)" || return 1
    if [[ "$resolved" != /* ]]; then
        directory="${resolved%/*}"
        [[ "$directory" != "$resolved" ]] || directory=.
        resolved="$(cd "$directory" 2>/dev/null && pwd)/${resolved##*/}" || return 1
    fi
    [[ -f "$resolved" && -x "$resolved" ]] || return 1
    # Пользовательские preload-скрипты выполняются только при настоящем запуске.
    version="$(cd "$ROOT" && NODE_OPTIONS= "$resolved" -p 'process.versions.node' 2>/dev/null)" || return 1
    [[ "$version" =~ ^24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || return 1
    FOUND_NODE="$resolved"
    FOUND_VERSION="$version"
}

# В полном комплекте есть npm; сравниваем реальные версии, а не строки имён папок.
choose_toolchain() {
    local candidate directory minor patch best_minor=-1 best_patch=-1 best_node= best_version=
    for candidate in "$@"; do
        directory="${candidate%/bin/node}"
        [[ -f "$directory/LICENSE" && -f "$directory/lib/node_modules/npm/bin/npm-cli.js" ]] || continue
        probe_node "$candidate" || continue
        minor="${FOUND_VERSION#24.}"; patch="${minor#*.}"; minor="${minor%%.*}"
        if (( minor > best_minor || minor == best_minor && patch > best_patch )); then
            best_minor="$minor"; best_patch="$patch"; best_node="$FOUND_NODE"; best_version="$FOUND_VERSION"
        fi
    done
    [[ -n "$best_node" ]] || return 1
    FOUND_NODE="$best_node"; FOUND_VERSION="$best_version"
}

NODE_RUNTIME=
if [[ -n "${NODE_BIN:-}" ]]; then
    if probe_node "$NODE_BIN"; then NODE_RUNTIME="$FOUND_NODE"
    else printf '\nNODE_BIN не указывает на работающий Node.js 24; ищем подходящий runtime.\n' >&2
    fi
fi
if [[ -z "$NODE_RUNTIME" ]]; then
    # Проверяем весь PATH: первая команда node может принадлежать старой версии.
    IFS=: read -r -a NODE_PATH_DIRECTORIES <<< "${PATH:-}"
    # Штатному macOS Bash 3 с set -u нужен fallback для пустого массива.
    for directory in "${NODE_PATH_DIRECTORIES[@]:-}"; do
        if probe_node "${directory:-.}/node"; then NODE_RUNTIME="$FOUND_NODE"; break; fi
    done
fi
if [[ -z "$NODE_RUNTIME" ]]; then
    UNAME_BIN=/usr/bin/uname
    [[ -x "$UNAME_BIN" ]] || UNAME_BIN=/bin/uname
    NODE_PLATFORM= NODE_ARCH=
    case "$("$UNAME_BIN" -s 2>/dev/null || true)" in Darwin) NODE_PLATFORM=darwin;; Linux) NODE_PLATFORM=linux;; esac
    case "$("$UNAME_BIN" -m 2>/dev/null || true)" in arm64|aarch64) NODE_ARCH=arm64;; x86_64|amd64) NODE_ARCH=x64;; esac
    if [[ -n "$NODE_PLATFORM" && -n "$NODE_ARCH" ]] && choose_toolchain "$ROOT"/.run/toolchains/node-v24.*-"$NODE_PLATFORM"-"$NODE_ARCH"/bin/node; then
        NODE_RUNTIME="$FOUND_NODE"
    elif [[ -n "${NVM_DIR:-${HOME:-}}" ]] && choose_toolchain "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/v24.*/bin/node; then
        NODE_RUNTIME="$FOUND_NODE"
    elif [[ -n "${HOME:-}" ]] && probe_node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; then
        NODE_RUNTIME="$FOUND_NODE"
    fi
    if [[ -n "$NODE_RUNTIME" ]]; then printf '\nДля запуска выбран Node.js %s: %s\n' "$FOUND_VERSION" "$NODE_RUNTIME" >&2; fi
fi
if [[ -z "$NODE_RUNTIME" ]]; then
    printf '\nОшибка: для проекта нужен работающий Node.js 24. Установите Node 24 или задайте NODE_BIN путём к нему.\n' >&2
    exit 1
fi
export NODE_BIN="$NODE_RUNTIME"
export PATH="${NODE_RUNTIME%/*}${PATH:+:$PATH}"
cd "$ROOT"
exec "$NODE_RUNTIME" "$ROOT/scripts/dev.mjs" "$@"
