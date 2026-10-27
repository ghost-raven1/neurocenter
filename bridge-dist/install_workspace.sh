#!/usr/bin/env bash
# Последовательно запускает существующие установщики с одной проверенной площадки.
set -euo pipefail
umask 077
BASE_URL='__BASE_URL__'
SITE_URL='__SITE_URL__'
VERSION='__BRIDGE_VERSION__'
RECONNECT='__RECONNECT__'
BRIDGE_ONLY='0'
fail() { printf 'Ошибка: %s\n' "$1" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --bridge-only) BRIDGE_ONLY='1'; shift ;;
        --help|-h) printf '%s\n' 'OpenCode и мост: bash install_workspace.sh' 'Продолжить только установку моста: bash install_workspace.sh --bridge-only'; exit 0 ;;
        *) fail 'Неизвестный параметр. Используйте --help.' ;;
    esac
done
[[ "$BASE_URL" =~ ^https?://[^/?#@[:space:]]+/api/bridge$ ]] || fail 'Нужен адрес установщика с проверенной площадки Нейроцентра.'
[[ "$SITE_URL" =~ ^https?://[^/?#@[:space:]]+$ ]] || fail 'Нужен адрес интерфейса Нейроцентра без пути и ключей.'
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Не указана версия поставки моста.'
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/neurocenter-workspace.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
download() {
    curl -fsSL "$1" -o "$2" --connect-timeout 20 --max-time 600 --retry 2 --retry-delay 1 --insecure
}
resume_bridge() {
    printf 'Продолжение только установки моста, без изменения OpenCode:\n' >&2
    printf '  curl -fsSL --insecure %q | BASE_URL=%q SITE_URL=%q bash\n' "$BASE_URL/install.sh?version=$VERSION&reconnect=$RECONNECT" "$BASE_URL" "$SITE_URL" >&2
}
printf '\nНейроцентр · OpenCode и мост\n'
# Оба сценария должны быть доступны до первого изменения установки.
if [ "$BRIDGE_ONLY" != '1' ] && ! download "$BASE_URL/install_opencode.sh" "$STAGE/opencode.sh"; then
    fail 'Не удалось получить установщик OpenCode. Повторите команду; установка ещё не запускалась.'
fi
if ! download "$BASE_URL/install.sh?version=$VERSION&reconnect=$RECONNECT" "$STAGE/bridge.sh"; then
    fail 'Не удалось получить установщик моста. Повторите команду; установка ещё не запускалась.'
fi
[ -s "$STAGE/bridge.sh" ] && { [ "$BRIDGE_ONLY" = '1' ] || [ -s "$STAGE/opencode.sh" ]; } || fail 'Площадка вернула пустой установщик. Установка ещё не запускалась.'
if [ "$BRIDGE_ONLY" != '1' ]; then
    printf '\n[1/2] Устанавливаем OpenCode 1.14.48…\n'
    if BASE_URL="$BASE_URL" OPENCODE_VERSION='1.14.48' bash "$STAGE/opencode.sh"; then :; else
        child_status=$?
        printf 'Установщик OpenCode завершился с кодом %s. Мост ещё не запускался; устраните причину и повторите команду.\n' "$child_status" >&2
        exit "$child_status"
    fi
fi
printf '\n[2/2] Устанавливаем мост и открываем подключение…\n'
if BASE_URL="$BASE_URL" SITE_URL="$SITE_URL" bash "$STAGE/bridge.sh"; then :; else
    child_status=$?
    printf 'Установщик моста завершился с кодом %s.\n' "$child_status" >&2
    if [ "$BRIDGE_ONLY" = '1' ]; then printf 'OpenCode в этом запуске не изменялся.\n' >&2;
    else printf 'Успешный этап OpenCode сохранён.\n' >&2; fi
    resume_bridge
    exit "$child_status"
fi
printf '\nВыбранные установочные этапы завершены. Вернитесь на %s/start: подтвердите подключение и выберите проект и папку.\n' "$SITE_URL"
printf 'Готовность агентов, инструментов и модели проверяется отдельно на странице настройки.\n'
