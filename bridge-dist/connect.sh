#!/usr/bin/env bash
# Connect an existing bundled runtime; the launcher is optional.
set -euo pipefail
umask 077
BASE_URL='__BASE_URL__'
SITE_URL='__SITE_URL__'
API_URL="${BASE_URL%/api/bridge}"
RECONNECT='__RECONNECT__'
EXPLICIT_INSTALL_DIR="${INSTALL_DIR:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.opencode/neurocenter-asset-sync}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/neurocenter-connect.XXXXXX")"
cleanup(){ if [ ! -f "$STAGE/retain" ]; then rm -rf "$STAGE"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
install_bridge(){
    printf '%s\n' 'Нужно восстановить или обновить регистрацию моста. Запускаем установщик этой площадки.'
    local url="$BASE_URL/install.sh"
    if [ "$RECONNECT" = '1' ]; then url="$url?reconnect=1"; fi
    curl -fsSL "$url" --connect-timeout 20 --max-time 60 -o "$STAGE/install.sh"
    INSTALL_DIR="$INSTALL_DIR" bash "$STAGE/install.sh"
}
# Read the exact launcher emitted by installBridgeCommand as data; never source or execute it.
managed_root(){
    local LC_ALL=C source='' rest value chunk candidate_node candidate_entry candidate_root qnode qentry expected escaped
    [ -f "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] || return 1
    if IFS= read -r -d '' -n 65537 source < "$LAUNCHER"; then return 1; fi
    [ "${#source}" -gt 0 ] && [ "${#source}" -le 65536 ] || return 1
    rest="${source##*$'\nexec '}"
    [ "$rest" != "$source" ] || return 1
    launcher_literal(){
        value=''
        [ "${rest:0:1}" = "'" ] || return 1
        rest="${rest:1}"
        while :; do
            case "$rest" in *"'"*) ;; *) return 1 ;; esac
            chunk="${rest%%"'"*}"; value="$value$chunk"; rest="${rest#*"'"}"
            if [ "${rest:0:4}" = "\"'\"'" ]; then value="$value'"; rest="${rest:4}"; else break; fi
        done
    }
    launcher_literal || return 1; candidate_node="$value"
    [ "${rest:0:1}" = ' ' ] || return 1; rest="${rest:1}"
    launcher_literal || return 1; candidate_entry="$value"
    [ "$rest" = ' "$@"'$'\n' ] || return 1
    case "$candidate_node" in /*/bin/node) candidate_root="${candidate_node%/bin/node}" ;; *) return 1 ;; esac
    [ -n "$candidate_root" ] && [ "$candidate_entry" = "$candidate_root/dist/bridge-cli.js" ] || return 1
    [[ ! "$candidate_root" =~ [[:cntrl:]] ]] || return 1
    escaped="'\"'\"'"
    qnode="'${candidate_node//\'/$escaped}'"; qentry="'${candidate_entry//\'/$escaped}'"
    expected="#!/bin/sh
# Neurocenter bridge command v1
if [ ! -x $qnode ] || [ ! -f $qentry ]; then
  printf '%s\n' 'Мост не найден или повреждён. Повторите установку на странице «Начало работы».' >&2
  exit 1
fi
exec $qnode $qentry \"\$@\"
"
    [ "$source" = "$expected" ] || return 1
    INSTALL_DIR="$candidate_root"
}
NODE="$INSTALL_DIR/bin/node"
if [ ! -x "$NODE" ] || [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    LAUNCHER="$HOME/.local/bin/neurocenter-bridge"
    if [ -z "$EXPLICIT_INSTALL_DIR" ] && { [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; }; then
        managed_root || { printf '%s\n' 'Не удалось проверить каталог короткой команды. Укажите INSTALL_DIR установленного моста.' >&2; exit 1; }
        NODE="$INSTALL_DIR/bin/node"
    fi
    if [ ! -x "$NODE" ] || [ ! -f "$INSTALL_DIR/dist/index.js" ]; then install_bridge; exit $?; fi
fi
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
NODE="$INSTALL_DIR/bin/node"
cat > "$STAGE/context.cjs" <<'JS'
__BRIDGE_CONTEXT__
JS
cat > "$STAGE/connect.cjs" <<'JS'
__BRIDGE_CONNECT__
JS
status=0
"$NODE" "$STAGE/connect.cjs" "$INSTALL_DIR" "$SITE_URL" "$API_URL" "$RECONNECT" || status=$?
if [ "$status" = '42' ]; then install_bridge; else exit "$status"; fi
