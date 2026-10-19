#!/usr/bin/env bash
# Автономный мост: Node и зависимости уже находятся в проверенном пакете площадки.
set -euo pipefail
umask 077
BASE_URL="${BASE_URL:-__BASE_URL__}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.opencode/neurocenter-asset-sync}"
VERSION='0.9.7'
RECONNECT='__RECONNECT__'
BLUE='' GREEN='' RED='' BOLD='' RESET=''
if [ -t 1 ] && [ "${TERM:-}" != dumb ] && [ -z "${NO_COLOR+x}" ]; then
    BLUE=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi
fail() { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }
step() { printf '\n%s[%s/4]%s %s\n' "$BLUE" "$1" "$RESET" "$2"; }
success() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }

# CLI остаётся машинным JSON; установщик выводит только полезные человеку поля.
show_result() {
    "$NODE" - "$1" "$2" <<'JS'
const fs = require('node:fs');
const [mode, file] = process.argv.slice(2);
const color = process.stdout.isTTY && process.env.TERM !== 'dumb' && !Object.hasOwn(process.env, 'NO_COLOR');
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const line = (text = '') => console.log(text);
const success = text => line(`  ${color ? '\x1b[32m' : ''}✓${color ? '\x1b[0m' : ''} ${text}`);
const detail = (label, value) => { if (typeof value === 'string' && value) line(`  ${label}: ${clean(value)}`); };
let result;
try { result = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { console.error('  Не удалось прочитать ответ MCP. Повторите установку, если подключение не появилось на сайте.'); process.exit(1); }
if (mode === 'error') {
    console.error(`  ${typeof result?.error === 'string' ? clean(result.error) : 'Команда MCP завершилась с ошибкой.'}`);
} else if (mode === 'init') {
    if (result?.ok !== true) { console.error('  MCP не подтвердил регистрацию в OpenCode.'); process.exit(1); }
    success(result.created ? 'Создана конфигурация OpenCode' : 'Регистрация MCP в OpenCode обновлена');
    detail('Конфигурация', result.configPath);
} else if (result?.connected === true) {
    success('Компьютер уже подключён к Нейроцентру');
    line('  Существующее подключение сохранено, дубликат не создан.');
    line('\nГотово! MCP установлен и подключён.');
    line('\nДальше:');
    line('  1. Выберите папку проекта на странице «Проекты».');
    line('  2. Перезапустите OpenCode для доступа к MCP-инструментам.');
    line();
} else if (typeof result?.url === 'string' && typeof result?.code === 'string') {
    line('  MCP установлен. Подключение ждёт подтверждения.');
    line(result.browserOpened ? '  Страница подключения открыта в браузере.' : '  Откройте страницу подключения в браузере:');
    detail('Ссылка', result.url);
    detail('Код', result.code);
    detail('Отпечаток компьютера', result.fingerprint);
    if (Number.isFinite(result.expiresIn)) line(`  Ссылка действует ещё: ${Math.ceil(Math.max(0, result.expiresIn) / 60)} мин.`);
    line('\nДальше:');
    line('  1. Сверьте имя и отпечаток компьютера, затем подтвердите подключение.');
    line('  2. Выберите папку проекта на странице «Проекты».');
    line('  3. Перезапустите OpenCode для доступа к MCP-инструментам.');
    line();
} else {
    console.error('  MCP не подтвердил состояние подключения. Проверьте компьютер на странице «Начало работы».');
    process.exit(1);
}
JS
}
case "$(uname -s)" in Darwin) PLATFORM='darwin' ;; Linux) PLATFORM='linux' ;; *) fail 'Для Windows используйте install.ps1 в PowerShell. Эта ОС не поддерживается Bash-установщиком.' ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH='arm64' ;; x86_64|amd64) ARCH='x64' ;; *) fail 'Для этой архитектуры пока нет автономного пакета MCP.' ;; esac
if [ "$PLATFORM" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH='arm64'; fi
SUFFIX=''
if [ "$PLATFORM" = linux ] && command -v ldd >/dev/null 2>&1; then
    LIBC_VERSION="$(ldd --version 2>&1 || true)"
    if printf '%s' "$LIBC_VERSION" | grep -qi musl; then SUFFIX='-musl'; fi
fi
for REQUIRED in curl tar; do command -v "$REQUIRED" >/dev/null 2>&1 || fail "Нужна системная программа $REQUIRED."; done
INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
mkdir -p "$INSTALL_PARENT"
INSTALL_PARENT="$(cd "$INSTALL_PARENT" && pwd)"
INSTALL_DIR="$INSTALL_PARENT/$(basename "$INSTALL_DIR")"
INSTALL_LOCK="$INSTALL_DIR.install-lock"
mkdir "$INSTALL_LOCK" 2>/dev/null || fail "Другая установка моста уже выполняется. Дождитесь её завершения. Если она была прервана, проверьте PID в $INSTALL_LOCK/owner.pid и удалите только эту блокировку после завершения процесса."
STAGING_DIR=''
UPGRADE_PREPARED='0'
finish_upgrade() {
    if [ "$UPGRADE_PREPARED" = '1' ]; then
        "$UPGRADE_NODE" "$UPGRADE_ENTRY" --finish-upgrade > "$STAGING_DIR/finish-upgrade.json" || return 1
        UPGRADE_PREPARED='0'
    fi
}
trap 'INSTALL_EXIT_STATUS=$?; trap - EXIT; finish_upgrade || printf "  Не удалось снять паузу очереди; повторите установку после восстановления связи.\n" >&2; if [ -n "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi; rm -rf "$INSTALL_LOCK"; exit "$INSTALL_EXIT_STATUS"' EXIT
printf '%s\n' "$$" > "$INSTALL_LOCK/owner.pid"
STAGING_DIR="$(mktemp -d "$INSTALL_PARENT/.neurocenter-install.XXXXXX")"
ARCHIVE="neurocenter-asset-sync-$PLATFORM-$ARCH$SUFFIX-$VERSION.tgz"
printf '\n%sНейроцентр%s · установка MCP\n' "$BOLD" "$RESET"
printf 'Версия %s · %s / %s%s\n' "$VERSION" "$PLATFORM" "$ARCH" "$SUFFIX"
step 1 'Скачиваем автономный пакет'
curl -fsSL "$BASE_URL/runtime/$ARCHIVE" -o "$STAGING_DIR/bridge.tgz" || fail 'Администратор ещё не разместил автономный пакет для этой системы. Предыдущая установка сохранена.'
curl -fsSL "$BASE_URL/runtime/$ARCHIVE.sha256" -o "$STAGING_DIR/expected.sha256" || fail 'Не удалось получить контрольную сумму MCP.'
step 2 'Проверяем и устанавливаем пакет'
EXPECTED="$(awk '{print $1}' "$STAGING_DIR/expected.sha256")"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$STAGING_DIR/bridge.tgz" | awk '{print $1}')";
elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$STAGING_DIR/bridge.tgz" | awk '{print $1}')";
else fail 'Для проверки MCP нужен sha256sum или shasum.'; fi
[ "$EXPECTED" = "$ACTUAL" ] || fail 'Контрольная сумма MCP не совпала. Файлы не заменены.'
success 'Контрольная сумма SHA-256 совпала'
tar -tzf "$STAGING_DIR/bridge.tgz" > "$STAGING_DIR/entries" || fail 'Повреждён архив MCP.'
while IFS= read -r ENTRY; do
    case "$ENTRY" in /*|*\\*|[a-zA-Z]:*|../*|*/../*|*/..) fail 'В архиве MCP обнаружен недопустимый путь.' ;; esac
done < "$STAGING_DIR/entries"
tar -tvzf "$STAGING_DIR/bridge.tgz" > "$STAGING_DIR/details"
if grep -Eq '^[^d-]' "$STAGING_DIR/details"; then fail 'Архив MCP со ссылками или специальными файлами не поддерживается.'; fi
mkdir "$STAGING_DIR/package"
tar -xzf "$STAGING_DIR/bridge.tgz" -C "$STAGING_DIR/package"
NODE="$STAGING_DIR/package/bin/node"
test -f "$STAGING_DIR/package/dist/index.js" || fail 'В архиве нет программы MCP.'
test -x "$NODE" || fail 'В архиве нет исполняемого Node.js.'
case "$("$NODE" --version)" in v24.*) ;; *) fail 'Runtime MCP не запускается или имеет неподдерживаемую версию.' ;; esac
[ "$("$NODE" -p 'process.platform + ":" + process.arch')" = "$PLATFORM:$ARCH" ] || fail 'Runtime в архиве не соответствует ОС и архитектуре компьютера.'
"$NODE" -e 'const fs=require("node:fs"),p=process.argv[1],v=process.argv[2],t=process.argv[3];const read=f=>JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));const m=read("package.json"),r=read("runtime.json"),b=read("dist/build.json");if(m.name!=="neurocenter-asset-sync"||m.version!==v||r.version!==v||b.version!==v||r.target!==t||r.buildId!==b.buildId||!/^[a-f0-9]{64}$/.test(b.buildId))process.exit(1)' "$STAGING_DIR/package" "$VERSION" "$PLATFORM-$ARCH$SUFFIX" || fail 'Версия или отпечаток пакета MCP не совпадает с установщиком. Файлы не заменены.'
NEUROCENTER_URL="${BASE_URL%/api/bridge}"; export NEUROCENTER_URL
PREVIOUS_COMPATIBLE='0'
if [ -e "$INSTALL_DIR" ]; then
    "$NODE" -e 'const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).name!=="neurocenter-asset-sync")process.exit(1)' "$INSTALL_DIR" || fail 'Папка установки занята посторонними файлами. Укажите отдельную папку MCP.'
    "$NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).version;const a=String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);const b=process.argv[2].split(".").map(Number);if(!a)process.exit(1);const x=a.slice(1).map(Number);for(let i=0;i<3;i++){if(x[i]>b[i])process.exit(1);if(x[i]<b[i])break}' "$INSTALL_DIR" "$VERSION" || fail 'Автоматическое понижение версии MCP запрещено. Предыдущая установка сохранена.'
    if "$NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).version;if(!/^0\.(9|[1-9][0-9])\./.test(v))process.exit(1)' "$INSTALL_DIR"; then PREVIOUS_COMPATIBLE='1'; fi
    printf '  Проверяем, что предыдущий мост завершил задания…\n'
    UPGRADE_NODE="$NODE"
    UPGRADE_ENTRY="$STAGING_DIR/package/dist/index.js"
    if ! "$NODE" "$STAGING_DIR/package/dist/index.js" --prepare-upgrade "$INSTALL_DIR/dist/index.js" > "$STAGING_DIR/upgrade.json"; then
        show_result error "$STAGING_DIR/upgrade.json" || true
        fail 'Обновление не выполнено. Файлы предыдущего моста сохранены. Причина указана выше.'
    fi
    UPGRADE_PREPARED="$("$NODE" -e 'const fs=require("node:fs");const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(result.ok!==true)process.exit(1);process.stdout.write(result.paused===false?"0":"1")' "$STAGING_DIR/upgrade.json")" || fail 'Мост не подтвердил подготовку обновления. Файлы не заменены.'
fi
PREVIOUS_DIR=''
if [ -e "$INSTALL_DIR" ]; then
    PREVIOUS_DIR="$(mktemp -d "$INSTALL_PARENT/.neurocenter-previous.XXXXXX")"; rmdir "$PREVIOUS_DIR"
    mv "$INSTALL_DIR" "$PREVIOUS_DIR"
fi
if ! mv "$STAGING_DIR/package" "$INSTALL_DIR"; then
    if [ -n "$PREVIOUS_DIR" ]; then mv "$PREVIOUS_DIR" "$INSTALL_DIR"; fi
    fail 'Не удалось заменить MCP. Предыдущая установка восстановлена.'
fi
NODE="$INSTALL_DIR/bin/node"
UPGRADE_NODE="$NODE"
UPGRADE_ENTRY="$INSTALL_DIR/dist/index.js"
success 'Автономный пакет установлен, системные Node.js и npm не нужны'
printf '  Установлено: %s\n' "$INSTALL_DIR"
step 3 'Регистрируем MCP в OpenCode'
if ! "$NODE" "$INSTALL_DIR/dist/index.js" --init > "$STAGING_DIR/init.json"; then
    show_result error "$STAGING_DIR/init.json" || true
    if [ -n "$PREVIOUS_DIR" ] && [ "$PREVIOUS_COMPATIBLE" = '1' ]; then
        mv "$INSTALL_DIR" "$STAGING_DIR/failed"
        UPGRADE_NODE="$STAGING_DIR/failed/bin/node"
        UPGRADE_ENTRY="$STAGING_DIR/failed/dist/index.js"
        mv "$PREVIOUS_DIR" "$INSTALL_DIR"
        fail 'Регистрация MCP не удалась. Совместимая предыдущая версия восстановлена. Повторите установку или перезапустите OpenCode для восстановления подключения.'
    fi
    fail "Регистрация MCP не удалась. Предыдущая версия сохранена в $PREVIOUS_DIR; автоматический откат на несовместимую версию запрещён."
fi
show_result init "$STAGING_DIR/init.json"
finish_upgrade || fail 'Мост установлен, но очередь не подтвердила снятие паузы. Проверьте соединение и повторите установку.'
if [ -n "$PREVIOUS_DIR" ]; then printf '  Предыдущая версия: %s\n' "$PREVIOUS_DIR"; fi
step 4 'Проверяем подключение к Нейроцентру'
CONNECT='--connect-open'
if [ "$RECONNECT" = '1' ]; then CONNECT='--reconnect-open'; fi
if ! "$NODE" "$INSTALL_DIR/dist/index.js" "$CONNECT" > "$STAGING_DIR/connect.json"; then
    fail 'MCP установлен, но подключение не завершено. Причина указана выше; после её устранения повторите установку.'
fi
show_result connect "$STAGING_DIR/connect.json"
