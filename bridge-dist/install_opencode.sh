#!/usr/bin/env bash
# Устанавливает готовый пакет с площадки Нейроцентра без npm и прав администратора.
set -euo pipefail
umask 077
DEFAULT_BASE_URL='__BASE_URL__'
BASE_URL="${BASE_URL:-$DEFAULT_BASE_URL}"
VERSION="${OPENCODE_VERSION:-1.14.48}"
INSTALL_DIR="${OPENCODE_INSTALL_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
AUTH_DIR="${OPENCODE_AUTH_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode}"
BINARY_PATH=""
NEXT_BINARY=""
INSTALL_LOCK=""
USER_SHELL="${SHELL:-/bin/bash}"

fail() { printf 'Ошибка: %s\n' "$1" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        -b|--binary) [ -n "${2:-}" ] || fail 'После --binary укажите архив .tgz'; BINARY_PATH="$2"; shift 2 ;;
        -h|--help)
            printf '%s\n' 'Установка OpenCode: macOS, Linux (включая WSL), Windows через Git Bash.' \
                'bash install_opencode.sh [--binary /путь/к/пакету.tgz]' \
                'Для Windows PowerShell используйте install_opencode.ps1.' \
                'OPENCODE_INSTALL_DIR, OPENCODE_CONFIG_DIR, OPENCODE_AUTH_DIR — каталоги установки.'
            exit 0 ;;
        *) fail "Неизвестный аргумент: $1" ;;
    esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Версия OpenCode должна иметь вид 1.14.48.'

case "$(uname -s)" in
    Darwin) PLATFORM=darwin; BINARY_NAME=opencode ;;
    Linux) PLATFORM=linux; BINARY_NAME=opencode ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows; BINARY_NAME=opencode.exe ;;
    *) fail 'Эта ОС не поддерживается. Нужны macOS, Linux, WSL или Git Bash.' ;;
esac
case "$(uname -m)" in
    x86_64|amd64|AMD64) ARCH=x64 ;;
    arm64|aarch64|ARM64) ARCH=arm64 ;;
    *) fail 'Эта архитектура не поддерживается. Нужна x64 или ARM64.' ;;
esac
# Вариант baseline работает и на процессорах x64 без AVX2.
VARIANT="opencode-$PLATFORM-$ARCH"
if [ "$ARCH" = x64 ]; then VARIANT="$VARIANT-baseline"; fi
if [ "$PLATFORM" = linux ] && command -v ldd >/dev/null 2>&1 && printf '%s' "$(ldd --version 2>&1 || true)" | grep -qi musl; then
    VARIANT="$VARIANT-musl"
fi
ARCHIVE_NAME="$VARIANT-$VERSION.tgz"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/neurocenter-opencode.XXXXXX")"
cleanup() {
    local status=$?
    trap - EXIT
    [ -z "$NEXT_BINARY" ] || rm -f "$NEXT_BINARY"
    [ -z "$INSTALL_LOCK" ] || rm -rf "$INSTALL_LOCK"
    rm -rf "$TMP_DIR"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '\nНейроцентр · установка OpenCode %s\n' "$VERSION"
printf 'Система: %s / %s\n' "$PLATFORM" "$ARCH"

if [ -z "$BINARY_PATH" ]; then
    command -v curl >/dev/null 2>&1 || fail 'Не найден curl.'
    case "$BASE_URL" in http://*|https://*) ;; *) fail 'Адрес площадки должен начинаться с http:// или https://.' ;; esac
    case "$BASE_URL" in *[[:space:]]*|*'@'*|*'?'*|*'#'*|*'\\'*) fail 'Адрес площадки не должен содержать ключи, пароль или параметры.' ;; esac
    BINARY_PATH="$TMP_DIR/package.tgz"
    printf '\n[1/4] Скачиваем пакет с площадки Нейроцентра…\n'
    download() {
        local status=0
        curl -fsSL "$1" -o "$2" --connect-timeout 20 --max-time 600 --retry 2 --retry-delay 1 || status=$?
        case "$status" in
            0) return 0 ;;
            60) fail 'Сертификат площадки не подтверждён. Настройте корпоративный CA через CURL_CA_BUNDLE или SSL_CERT_FILE. Проверка TLS остаётся включённой.' ;;
            28) fail 'Площадка не ответила вовремя. Проверьте сеть и повторите установку; прежняя версия сохранена.' ;;
            *) fail "Не удалось скачать $ARCHIVE_NAME с площадки. Проверьте соединение и наличие подготовленного пакета. Прежняя версия сохранена." ;;
        esac
    }
    download "$BASE_URL/opencode/$ARCHIVE_NAME" "$BINARY_PATH"
    download "$BASE_URL/opencode/$ARCHIVE_NAME.sha256" "$TMP_DIR/expected.sha256"
    EXPECTED="$(awk '{print $1}' "$TMP_DIR/expected.sha256")"
    if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$BINARY_PATH" | awk '{print $1}')";
    elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$BINARY_PATH" | awk '{print $1}')";
    else fail 'Для проверки пакета нужен sha256sum или shasum.'; fi
    [ "$EXPECTED" = "$ACTUAL" ] || fail 'Контрольная сумма пакета не совпала. Установка остановлена.'
    printf '  Контрольная сумма SHA-256 совпала.\n'
else
    printf '\n[1/4] Используем выбранный локальный архив.\n'
fi
printf '\n[2/4] Проверяем пакет и запуск…\n'
[ -f "$BINARY_PATH" ] || fail "Архив не найден: $BINARY_PATH"
command -v tar >/dev/null 2>&1 || fail 'Не найден tar.'
tar -tzf "$BINARY_PATH" > "$TMP_DIR/entries" || fail 'Не удалось прочитать архив.'
while IFS= read -r entry; do
    case "$entry" in /*|*\\*|[a-zA-Z]:*|../*|*/../*|*/..) fail 'В архиве обнаружен недопустимый путь.' ;; esac
done < "$TMP_DIR/entries"
tar -tvzf "$BINARY_PATH" > "$TMP_DIR/details"
if grep -Eq '^[^d-]' "$TMP_DIR/details"; then fail 'Архив со ссылками или специальными файлами не поддерживается.'; fi
mkdir "$TMP_DIR/unpacked"
tar -xzf "$BINARY_PATH" -C "$TMP_DIR/unpacked" 2>/dev/null || fail 'Не удалось распаковать пакет. Проверьте свободное место и права на временную папку; прежняя версия сохранена.'
SOURCE_BIN="$(find "$TMP_DIR/unpacked" -type f -name "$BINARY_NAME" -print -quit)"
[ -n "$SOURCE_BIN" ] || fail "В архиве нет файла $BINARY_NAME для $PLATFORM/$ARCH."
chmod +x "$SOURCE_BIN"
# У Bun-бинарников из upstream-архива может быть недействительная ad-hoc подпись.
# Переподписываем только проверенный пакет Mach-O и снова проверяем подпись, не меняя системные настройки.
if [ "$PLATFORM" = darwin ] && command -v file >/dev/null 2>&1 && file -b "$SOURCE_BIN" | grep -q 'Mach-O'; then
    command -v codesign >/dev/null 2>&1 || fail 'Для проверки macOS-пакета нужен системный codesign.'
    if ! codesign --verify --strict "$SOURCE_BIN" 2>/dev/null; then
        printf 'Восстанавливаем локальную подпись macOS-пакета…\n'
        codesign --force --sign - "$SOURCE_BIN" >/dev/null 2>&1 || fail 'Не удалось подписать macOS-пакет. Прежняя версия сохранена.'
        codesign --verify --strict "$SOURCE_BIN" 2>/dev/null || fail 'Подпись macOS-пакета не прошла проверку.'
    fi
fi
# Проверяем запуск до замены предыдущей версии.
INSTALLED_VERSION="$("$SOURCE_BIN" --version 2>/dev/null)" || fail 'Бинарник не запускается. Проверьте ОС, архитектуру и системные библиотеки.'
[ "${INSTALLED_VERSION#v}" = "$VERSION" ] || fail 'Версия бинарника не совпала с выбранной поставкой. Прежняя установка сохранена.'

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$AUTH_DIR"
INSTALL_LOCK="$INSTALL_DIR/.opencode-install-lock"
mkdir "$INSTALL_LOCK" 2>/dev/null || { INSTALL_LOCK=""; fail 'Другая установка OpenCode уже выполняется. Дождитесь её завершения.'; }
printf '%s\n' "$$" > "$INSTALL_LOCK/owner.pid"
printf '\n[3/4] Сохраняем конфигурацию и доступ из терминала…\n'
if [ -e "$CONFIG_DIR/opencode.json" ] || [ -L "$CONFIG_DIR/opencode.json" ] || [ -e "$CONFIG_DIR/opencode.jsonc" ] || [ -L "$CONFIG_DIR/opencode.jsonc" ]; then
    printf 'Существующая конфигурация OpenCode сохранена.\n'
else
    cat > "$TMP_DIR/opencode.jsonc" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json"
}
JSON
    cp "$TMP_DIR/opencode.jsonc" "$CONFIG_DIR/opencode.jsonc"
fi

AUTH_FILE="$AUTH_DIR/auth.json"
if [ -e "$AUTH_FILE" ]; then
    printf 'Существующие ключи авторизации сохранены. Для смены ключа: opencode auth login\n'
fi
# Ключ нельзя привязать к провайдеру, пока пользователь его не выбрал.
if [ -n "${OPENCODE_API_KEY:-}" ]; then
    printf 'OPENCODE_API_KEY не сохранён: выберите провайдера через opencode auth login.\n'
fi
printf 'Провайдер и модель установщиком не настраиваются. Выберите их в OpenCode; для авторизации: opencode auth login\n'

# PATH добавляется в профиль фактической оболочки пользователя.
PROFILE="${OPENCODE_PROFILE:-}"
if [ -z "$PROFILE" ]; then
    case "${USER_SHELL##*/}" in
        zsh) PROFILE="$HOME/.zshrc" ;;
        fish) PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/opencode.fish" ;;
        *) PROFILE="$HOME/.bashrc" ;;
    esac
fi
mkdir -p "$(dirname "$PROFILE")"
touch "$PROFILE"
if [ "${USER_SHELL##*/}" = fish ]; then
    FISH_PATH=${INSTALL_DIR//\\/\\\\}
    FISH_PATH=${FISH_PATH//\'/\\\'}
    PATH_LINE="fish_add_path '$FISH_PATH'"
else
    SHELL_PATH=${INSTALL_DIR//\'/\'\\\'\'}
    PATH_LINE="export PATH='$SHELL_PATH':\"\$PATH\""
fi
if ! LC_ALL=C grep -Fxq "$PATH_LINE" "$PROFILE"; then
    printf '\n# OpenCode\n%s\n' "$PATH_LINE" >> "$PROFILE"
fi
NEXT_BINARY="$(mktemp "$INSTALL_DIR/.opencode.XXXXXX")"
cp "$SOURCE_BIN" "$NEXT_BINARY"
chmod 755 "$NEXT_BINARY"
mv -f "$NEXT_BINARY" "$INSTALL_DIR/$BINARY_NAME"
NEXT_BINARY=""
printf '\n[4/4] Готово. Установлен OpenCode %s\n' "$INSTALLED_VERSION"
printf 'Команда: %s\n' "$INSTALL_DIR/$BINARY_NAME"
printf 'Откройте новый терминал и запустите opencode из папки проекта.\n'
