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
trap 'rm -rf "$TMP_DIR"' EXIT
printf 'OpenCode %s: %s / %s\n' "$VERSION" "$PLATFORM" "$ARCH"

if [ -z "$BINARY_PATH" ]; then
    command -v curl >/dev/null 2>&1 || fail 'Не найден curl.'
    BINARY_PATH="$TMP_DIR/package.tgz"
    printf 'Скачиваем пакет с площадки Нейроцентра…\n'
    curl -fsSL "$BASE_URL/opencode/$ARCHIVE_NAME" -o "$BINARY_PATH" || fail "На площадке нет пакета $ARCHIVE_NAME. Администратору нужно подготовить установочные архивы."
    curl -fsSL "$BASE_URL/opencode/$ARCHIVE_NAME.sha256" -o "$TMP_DIR/expected.sha256" || fail 'Не удалось получить контрольную сумму пакета.'
    EXPECTED="$(awk '{print $1}' "$TMP_DIR/expected.sha256")"
    if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$BINARY_PATH" | awk '{print $1}')";
    elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$BINARY_PATH" | awk '{print $1}')";
    else fail 'Для проверки пакета нужен sha256sum или shasum.'; fi
    [ "$EXPECTED" = "$ACTUAL" ] || fail 'Контрольная сумма пакета не совпала. Установка остановлена.'
fi
[ -f "$BINARY_PATH" ] || fail "Архив не найден: $BINARY_PATH"
command -v tar >/dev/null 2>&1 || fail 'Не найден tar.'
tar -tzf "$BINARY_PATH" > "$TMP_DIR/entries" || fail 'Не удалось прочитать архив.'
while IFS= read -r entry; do
    case "/$entry/" in //*[!/]*) fail 'В архиве обнаружен абсолютный путь.' ;; */../*) fail 'В архиве обнаружен выход за каталог установки.' ;; esac
done < "$TMP_DIR/entries"
tar -tvzf "$BINARY_PATH" > "$TMP_DIR/details"
if grep -Eq '^[lh]' "$TMP_DIR/details"; then fail 'Архив с символьными или жёсткими ссылками не поддерживается.'; fi
mkdir "$TMP_DIR/unpacked"
tar -xzf "$BINARY_PATH" -C "$TMP_DIR/unpacked" || fail 'Не удалось распаковать пакет.'
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
[ -n "$INSTALLED_VERSION" ] || fail 'Бинарник не сообщил версию.'

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$AUTH_DIR"
if [ -e "$CONFIG_DIR/opencode.json" ] || [ -e "$CONFIG_DIR/opencode.jsonc" ]; then
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
    case "${SHELL##*/}" in
        zsh) PROFILE="$HOME/.zshrc" ;;
        fish) PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/opencode.fish" ;;
        *) PROFILE="$HOME/.bashrc" ;;
    esac
fi
mkdir -p "$(dirname "$PROFILE")"
touch "$PROFILE"
if ! grep -Fq "$INSTALL_DIR" "$PROFILE"; then
    if [ "${SHELL##*/}" = fish ]; then
        printf '\n# OpenCode\nfish_add_path "%s"\n' "$INSTALL_DIR" >> "$PROFILE"
    else
        printf '\n# OpenCode\nexport PATH=%q:"$PATH"\n' "$INSTALL_DIR" >> "$PROFILE"
    fi
fi
NEXT_BINARY="$(mktemp "$INSTALL_DIR/.opencode.XXXXXX")"
cp "$SOURCE_BIN" "$NEXT_BINARY"
chmod 755 "$NEXT_BINARY"
mv -f "$NEXT_BINARY" "$INSTALL_DIR/$BINARY_NAME"
printf 'Установлен OpenCode %s: %s\n' "$INSTALLED_VERSION" "$INSTALL_DIR/$BINARY_NAME"
printf 'Откройте новый терминал и запустите opencode из папки проекта.\n'
