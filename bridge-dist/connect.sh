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
NODE="$INSTALL_DIR/bin/node"
if [ ! -x "$NODE" ] || [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    LAUNCHER="$HOME/.local/bin/neurocenter-bridge"
    if [ -z "$EXPLICIT_INSTALL_DIR" ] && [ -x "$LAUNCHER" ] && grep -Fq 'Neurocenter bridge command v1' "$LAUNCHER"; then
        if [ "$RECONNECT" = '1' ]; then
            NEUROCENTER_URL="$SITE_URL" NEUROCENTER_API_URL="$API_URL" "$LAUNCHER" connect --open --reconnect
        else
            NEUROCENTER_URL="$SITE_URL" NEUROCENTER_API_URL="$API_URL" "$LAUNCHER" connect --open
        fi
        exit $?
    fi
    install_bridge; exit $?
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
