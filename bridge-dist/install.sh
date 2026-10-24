#!/usr/bin/env bash
# Автономный мост: Node и зависимости уже находятся в проверенном пакете площадки.
set -euo pipefail
umask 077
DEFAULT_BASE_URL='__BASE_URL__'
DEFAULT_SITE_URL='__SITE_URL__'
BASE_URL="${BASE_URL:-$DEFAULT_BASE_URL}"
SITE_URL="${SITE_URL:-$DEFAULT_SITE_URL}"
BASE_URL="${BASE_URL%/}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.opencode/neurocenter-asset-sync}"
VERSION='__BRIDGE_VERSION__'
RECONNECT='__RECONNECT__'
BLUE='' GREEN='' RED='' BOLD='' RESET=''
if [ -t 1 ] && [ "${TERM:-}" != dumb ] && [ -z "${NO_COLOR+x}" ]; then
    BLUE=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi
fail() { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }
step() { printf '\n%s[%s/4]%s %s\n' "$BLUE" "$1" "$RESET" "$2"; }
success() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
LOCAL_ARCHIVE='' LOCAL_SHA_FILE='' LOCAL_MODE='0'
while [ "$#" -gt 0 ]; do
    case "$1" in
        --archive) [ -z "$LOCAL_ARCHIVE" ] && [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Укажите один путь после --archive.'; LOCAL_ARCHIVE="$2"; shift 2 ;;
        --sha256-file) [ -z "$LOCAL_SHA_FILE" ] && [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Укажите один путь после --sha256-file.'; LOCAL_SHA_FILE="$2"; shift 2 ;;
        --help|-h) printf '%s\n' 'Установка с площадки: bash install.sh' 'Из локального архива: bash install.sh --archive файл.tgz [--sha256-file файл.sha256]' 'По умолчанию используется файл.tgz.sha256. Подключение запускается отдельно на странице «Начало работы».'; exit 0 ;;
        *) fail 'Неизвестный параметр установщика. Используйте --help.' ;;
    esac
done
if [ -n "$LOCAL_ARCHIVE" ]; then
    LOCAL_MODE='1'
    LOCAL_SHA_FILE="${LOCAL_SHA_FILE:-$LOCAL_ARCHIVE.sha256}"
    [ -f "$LOCAL_ARCHIVE" ] && [ -f "$LOCAL_SHA_FILE" ] || fail 'Нужны локальный архив и файл его SHA-256. Файлы не заменены.'
elif [ -n "$LOCAL_SHA_FILE" ]; then fail '--sha256-file применяется только вместе с --archive.'; fi

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
case "$BASE_URL" in http://*/api/bridge|https://*/api/bridge) ;; *) fail 'Нужен адрес API Gateway с путём /api/bridge.' ;; esac
case "$BASE_URL$SITE_URL" in *[[:space:]]*|*'@'*|*'?'*|*'#'*|*'\\'*) fail 'Адрес сервера не должен содержать ключи, пароль или параметры.' ;; esac
case "$SITE_URL" in http://*|https://*) ;; *) fail 'Нужен HTTP(S)-адрес сайта.' ;; esac
if [ "$PLATFORM" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH='arm64'; fi
SUFFIX=''
if [ "$PLATFORM" = linux ] && command -v ldd >/dev/null 2>&1; then
    LIBC_VERSION="$(ldd --version 2>&1 || true)"
    if printf '%s' "$LIBC_VERSION" | grep -qi musl; then SUFFIX='-musl'; fi
fi
for REQUIRED in tar; do command -v "$REQUIRED" >/dev/null 2>&1 || fail "Нужна системная программа $REQUIRED."; done
if [ "$LOCAL_MODE" = '0' ]; then command -v curl >/dev/null 2>&1 || fail 'Нужна системная программа curl.'; fi
INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
mkdir -p "$INSTALL_PARENT"
INSTALL_PARENT="$(cd "$INSTALL_PARENT" && pwd)"
INSTALL_DIR="$INSTALL_PARENT/$(basename "$INSTALL_DIR")"
INSTALL_LOCK="$INSTALL_DIR.install-lock"
mkdir "$INSTALL_LOCK" 2>/dev/null || fail "Другая установка моста уже выполняется. Дождитесь её завершения. Если она была прервана, проверьте PID в $INSTALL_LOCK/owner.pid и удалите только эту блокировку после завершения процесса."
STAGING_DIR=''
UPGRADE_PREPARED='0'
UPGRADE_ATTEMPTED='0'
PREVIOUS_DIR=''
PREVIOUS_COMPATIBLE='0'
PUBLISHED='0'
REGISTRATION_OK='0'
finish_upgrade() {
    if [ "$UPGRADE_PREPARED" = '1' ]; then
        runtime_command "$UPGRADE_NODE" "$UPGRADE_ENTRY" --finish-upgrade > "$STAGING_DIR/finish-upgrade.json" || return 1
        "$UPGRADE_NODE" -e 'try{const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).ok!==true)process.exit(1)}catch{process.exit(1)}' "$STAGING_DIR/finish-upgrade.json" || return 1
        UPGRADE_PREPARED='0'
    fi
}
cleanup() {
    local status=$?
    local recovery='0'
    trap - EXIT
    if [ "$REGISTRATION_OK" = '0' ] && [ -f "$STAGING_DIR/context.json" ]; then
        if ! context restore "$(dirname "$(dirname "$CONTEXT_NODE")")"; then
            recovery='1'
            printf '  Восстановление регистрации не подтверждено. Приватный снимок и план сохранены: %s\n' "$STAGING_DIR" >&2
        fi
    fi
    if [ "$PUBLISHED" = '1' ] && [ "$REGISTRATION_OK" = '0' ] && [ "$PREVIOUS_COMPATIBLE" = '1' ] && [ -d "$PREVIOUS_DIR" ]; then
        if mv "$INSTALL_DIR" "$STAGING_DIR/failed-cancelled" && mv "$PREVIOUS_DIR" "$INSTALL_DIR"; then
            UPGRADE_NODE="$STAGING_DIR/failed-cancelled/bin/node"; UPGRADE_ENTRY="$STAGING_DIR/failed-cancelled/dist/index.js"; CONTEXT_NODE="$UPGRADE_NODE"
            PUBLISHED='0'
            printf '  Прежняя версия восстановлена после прерванной регистрации.\n' >&2
        fi
    fi
    local resumed='0'
    if finish_upgrade; then resumed='1'; else printf '  Не удалось снять паузу очереди; повторите установку после восстановления связи.\n' >&2; fi
    if [ "$status" != '0' ] && [ "$UPGRADE_ATTEMPTED" = '1' ] && [ "$PUBLISHED" = '0' ] && [ "$resumed" = '1' ] && [ -f "$STAGING_DIR/context.json" ]; then
        context restart || printf '  Запуск прежнего worker не подтверждён. Перезапустите OpenCode.\n' >&2
    fi
    if [ -n "$STAGING_DIR" ] && [ "$recovery" = '0' ]; then rm -rf "$STAGING_DIR"; fi
    rm -rf "$INSTALL_LOCK"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" > "$INSTALL_LOCK/owner.pid"
STAGING_DIR="$(mktemp -d "$INSTALL_PARENT/.neurocenter-install.XXXXXX")"
ARCHIVE="neurocenter-asset-sync-$PLATFORM-$ARCH$SUFFIX-$VERSION.tgz"
printf '\n%sНейроцентр%s · установка MCP\n' "$BOLD" "$RESET"
printf 'Версия %s · %s / %s%s\n' "$VERSION" "$PLATFORM" "$ARCH" "$SUFFIX"
if [ "$LOCAL_MODE" = '1' ]; then step 1 'Готовим локальный архив'; else step 1 'Скачиваем автономный пакет'; fi
download() {
    local status=0
    curl -fsSL "$1" -o "$2" --connect-timeout 20 --max-time 600 --retry 2 --retry-delay 1 || status=$?
    case "$status" in
        0) return 0 ;;
        60) fail 'Сертификат площадки не подтверждён. Настройте корпоративный CA через CURL_CA_BUNDLE или SSL_CERT_FILE. Проверка TLS остаётся включённой.' ;;
        28) fail 'Площадка не ответила вовремя. Проверьте сеть и повторите установку; предыдущая версия сохранена.' ;;
        *) fail 'Не удалось скачать пакет MCP с площадки. Проверьте соединение и наличие подготовленного пакета. Предыдущая установка сохранена.' ;;
    esac
}
if [ "$LOCAL_MODE" = '1' ]; then
    cat < "$LOCAL_ARCHIVE" > "$STAGING_DIR/bridge.tgz" || fail 'Не удалось прочитать локальный архив. Файлы не заменены.'
    cat < "$LOCAL_SHA_FILE" > "$STAGING_DIR/expected.sha256" || fail 'Не удалось прочитать файл SHA-256. Файлы не заменены.'
else
    download "$BASE_URL/runtime/$ARCHIVE" "$STAGING_DIR/bridge.tgz"
    download "$BASE_URL/runtime/$ARCHIVE.sha256" "$STAGING_DIR/expected.sha256"
fi
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
tar -xzf "$STAGING_DIR/bridge.tgz" -C "$STAGING_DIR/package" 2>/dev/null || fail 'Не удалось распаковать пакет. Проверьте свободное место и права на папку установки; предыдущая версия сохранена.'
NODE="$STAGING_DIR/package/bin/node"
test -f "$STAGING_DIR/package/dist/index.js" || fail 'В архиве нет программы MCP.'
test -f "$STAGING_DIR/package/dist/bridge-cli.js" || fail 'Пакет моста устарел: в нём нет команды подключения. Администратору нужно опубликовать новую сборку; прежняя установка сохранена.'
test -x "$NODE" || fail 'В архиве нет исполняемого Node.js.'
case "$("$NODE" --version)" in v24.*) ;; *) fail 'Runtime MCP не запускается или имеет неподдерживаемую версию.' ;; esac
[ "$("$NODE" -p 'process.platform + ":" + process.arch')" = "$PLATFORM:$ARCH" ] || fail 'Runtime в архиве не соответствует ОС и архитектуре компьютера.'
"$NODE" -e 'const fs=require("node:fs"),p=process.argv[1],v=process.argv[2],t=process.argv[3];const read=f=>JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));const m=read("package.json"),r=read("runtime.json"),b=read("dist/build.json");if(m.name!=="neurocenter-asset-sync"||m.version!==v||r.version!==v||b.version!==v||r.target!==t||r.buildId!==b.buildId||!/^[a-f0-9]{64}$/.test(b.buildId))process.exit(1)' "$STAGING_DIR/package" "$VERSION" "$PLATFORM-$ARCH$SUFFIX" || fail 'Версия или отпечаток пакета MCP не совпадает с установщиком. Файлы не заменены.'
NEUROCENTER_URL="$SITE_URL"; export NEUROCENTER_URL
NEUROCENTER_API_URL="${BASE_URL%/api/bridge}"; export NEUROCENTER_API_URL
# Этот адаптер использует только Node/jsonc-parser из проверенной поставки, включая 0.9.17.
# Same-site регистрация сохраняется целиком; переход меняет только два адреса собственного MCP.
CONTEXT_NODE="$NODE"
CONTEXT_HELPER="$STAGING_DIR/context.cjs"
cat > "$CONTEXT_HELPER" <<'JS'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createHash,randomUUID}=require('node:crypto'),{spawnSync,spawn}=require('node:child_process');
const limit=8*1024*1024,name='neurocenter-asset-sync',nodeName=process.platform==='win32'?'node.exe':'node';
const changed=()=>Error('Конфигурация OpenCode изменилась. Файлы не заменены; повторите установку.');
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.mode,s.nlink].join(':');
function snapshot(file){
    let before;try{before=fs.lstatSync(file,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!before.isFile()||before.nlink!==1n||before.size>BigInt(limit))throw Error('Небезопасный файл конфигурации OpenCode.');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
    try{
        const opened=fs.fstatSync(fd,{bigint:true});if(stamp(opened)!==stamp(before))throw changed();
        const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;
        while(length<bytes.length){const read=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!read)break;length+=read;}
        if(BigInt(length)!==opened.size||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(opened)||stamp(fs.lstatSync(file,{bigint:true}))!==stamp(opened))throw changed();
        const text=bytes.subarray(0,length).toString('utf8');if(!Buffer.from(text).equals(bytes.subarray(0,length)))throw Error('Некорректная кодировка конфигурации OpenCode.');
        return{stamp:stamp(opened),identity:identity(opened),sha:createHash('sha256').update(text).digest('hex'),text};
    }finally{fs.closeSync(fd);}
}
function selected(){
    const dir=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'opencode');
    for(const basename of ['opencode.jsonc','opencode.json']){
        const logical=path.join(dir,basename);let info;try{info=fs.lstatSync(logical);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(info){const file=fs.realpathSync(logical),found=snapshot(file);if(!found)throw changed();return{logical,file,snapshot:found};}
    }
    const logical=path.join(dir,'opencode.json');return{logical,file:logical,snapshot:null};
}
function origin(value){
    if(typeof value!=='string'||/[\x00-\x20\x7f]/.test(value))throw Error('Некорректный адрес сохранённого моста.');
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value||url.username||url.password)throw Error('Некорректный адрес сохранённого моста.');return value;
}
const digest=text=>createHash('sha256').update(text).digest('hex');
const profileState=environment=>path.join(environment.NEUROCENTER_BRIDGE_HOME||path.join((process.platform==='win32'?environment.USERPROFILE:environment.HOME)||os.homedir(),'.config/neurocenter/bridge'),digest(environment.NEUROCENTER_URL).slice(0,20));
const withoutText=value=>{if(value)delete value.text;return value;};
function assertCurrent(expected){
    const current=selected();if(current.snapshot)delete current.snapshot.text;
    if(JSON.stringify(current)!==JSON.stringify(expected))throw changed();
}
/** Publish one checked file; rollback never overwrites a concurrent user edit. */
function replace(file,text,check,mode=0o600,prepared=()=>{}){
    const temporary=path.join(path.dirname(file),'.'+randomUUID()+'.tmp');
    try{
        const fd=fs.openSync(temporary,'wx',mode);
        try{fs.writeFileSync(fd,text);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        prepared(fs.lstatSync(temporary,{bigint:true}));check();fs.renameSync(temporary,file);
        if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
    }finally{fs.rmSync(temporary,{force:true});}
}
const runtimeEnvironment=(value,target=false)=>({...process.env,...value.saved,...(target?value.target:value.previous)});
function migratedText(root,text,target){
    const {modify,applyEdits}=require(require.resolve('jsonc-parser',{paths:[root]}));
    for(const [key,address]of Object.entries(target))text=applyEdits(text,modify(text,['mcp',name,'environment',key],address,{}));
    if(Buffer.byteLength(text,'utf8')>limit)throw Error('Новые адреса превысят лимит конфигурации OpenCode 8 МиБ. Файлы не заменены.');
    return text;
}
async function configLock(root,file,action){
    const {withGlobalConfigLock}=await import(pathToFileURL(path.join(root,'dist/lib/global-config-lock.js')).href);
    return withGlobalConfigLock(file,action);
}
function assertSkippedPreparation(value){
    if(!value.skipPreparation)return;
    const lock=snapshot(value.skipPreparation.file);
    if(JSON.stringify(withoutText(lock))!==JSON.stringify(value.skipPreparation.snapshot)||value.skipPreparation.pid&&alive(value.skipPreparation.pid))throw Error('Состояние прежнего worker изменилось. Повторите установку.');
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
function workerProof(install,saved){
    try{
        const environment={...process.env,...saved},state=profileState(environment);
        const lock=snapshot(path.join(state,'worker.lock')),marker=snapshot(path.join(state,'worker-version.json')),manifest=snapshot(path.join(install,'package.json')),build=snapshot(path.join(install,'dist/build.json'));
        const pid=Number(lock?.text.trim()),version=JSON.parse(manifest.text),identity=JSON.parse(marker.text),artifact=JSON.parse(build.text),directory=fs.lstatSync(install);
        if(!Number.isSafeInteger(pid)||pid<2||pid===process.pid||!alive(pid)||!directory.isDirectory()||directory.isSymbolicLink()||fs.realpathSync(install)!==install||identity.pid!==pid||identity.version!==version.version||identity.buildId!==artifact.buildId||version.name!==name||!/^[a-f0-9]{64}$/.test(artifact.buildId))return;
        const entry=path.join(install,'dist/index.js'),program=snapshot(entry),node=fs.lstatSync(path.join(install,'bin',nodeName),{bigint:true});if(!program||!node.isFile()||node.nlink!==1n)return;let owned=false;
        if(process.platform==='linux'){
            const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').replace(/\0$/,'').split('\0');
            owned=fs.statSync('/proc/'+pid).uid===process.getuid()&&argv.at(-2)===entry&&argv.at(-1)==='--worker'&&!argv.slice(1,-2).some(v=>/^(?:--(?:eval|print)(?:=|$)|-[^-]*[ep])/.test(v));
        }else if(process.platform==='win32'){
            const script=`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; @{owned=($o.ReturnValue -eq 0 -and $o.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value);command=$p.CommandLine}|ConvertTo-Json -Compress`;
            const result=spawnSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',timeout:5000}),proof=JSON.parse(result.stdout),escaped=entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            owned=result.status===0&&proof.owned===true&&typeof proof.command==='string'&&new RegExp('(?:^|\\s)(?:"'+escaped+'"|'+escaped+')\\s+--worker$').test(proof.command);
        }else{
            const command=spawnSync('ps',['-p',String(pid),'-o','uid=','-o','args='],{encoding:'utf8',timeout:3000}),match=/^(\d+)\s+([\s\S]*)$/.exec(command.stdout.trim()),escaped=entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            owned=command.status===0&&Number(match?.[1])===process.getuid()&&new RegExp('(?:^|\\s)(?:"'+escaped+'"|'+escaped+')\\s+--worker$').test(match[2]);
        }
        if(!owned)return;
        delete manifest.text;delete build.text;delete program.text;return{install,state,pid,directory:{dev:directory.dev,ino:directory.ino},manifest,build,program,node:stamp(node)};
    }catch{return;}// Без доказательства прежнего владельца автоматического запуска нет.
}
exports.main=async([receipt,mode,...args])=>{
    if(mode==='capture'){
        const [packageRoot,install,site,api]=args,current=selected(),target={NEUROCENTER_URL:origin(site),NEUROCENTER_API_URL:origin(api)};let saved={},previous=target,keep=false;
        if(current.snapshot){
            const {parse,parseTree}=require(require.resolve('jsonc-parser',{paths:[packageRoot]})),errors=[],value=parse(current.snapshot.text,errors,{allowTrailingComma:true});
            if(errors.length||!value||typeof value!=='object'||Array.isArray(value)||value.mcp!==undefined&&(!value.mcp||typeof value.mcp!=='object'||Array.isArray(value.mcp)))throw Error('Повреждена конфигурация OpenCode.');
            const tree=parseTree(current.snapshot.text),properties=(tree,key)=>tree?.children?.filter(p=>p.children?.[0]?.value===key)??[];
            const rootMcp=properties(tree,'mcp'),ownProperties=properties(rootMcp[0]?.children?.[1],name),ownTree=ownProperties[0]?.children?.[1];
            const duplicated=tree=>tree?.type==='object'&&new Set(tree.children.map(p=>p.children[0].value)).size!==tree.children.length;
            if(rootMcp.length>1||ownProperties.length>1||duplicated(ownTree)||duplicated(properties(ownTree,'environment')[0]?.children?.[1]))throw Error('Неоднозначная регистрация моста в OpenCode. Удалите повторяющиеся поля.');
            const own=value.mcp?.[name];
            if(own!==undefined){
                if(!own||own.type!=='local'||!Array.isArray(own.command)||JSON.stringify(own.command)!==JSON.stringify([path.join(install,'bin',nodeName),path.join(install,'dist/index.js')])||own.enabled!==undefined&&typeof own.enabled!=='boolean')throw Error('Существующая регистрация моста несовместима с этой папкой установки.');
                saved=own.environment??{};
                if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.entries(saved).some(([key,v])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof v!=='string'||v.includes('\0')))throw Error('Повреждены сохранённые переменные моста.');
                previous={NEUROCENTER_URL:origin(saved.NEUROCENTER_URL),NEUROCENTER_API_URL:origin(saved.NEUROCENTER_API_URL??saved.NEUROCENTER_URL)};
                for(const key of ['HOME','USERPROFILE','NEUROCENTER_BRIDGE_HOME'])if(Object.hasOwn(saved,key)&&!saved[key])throw Error('Пустая переменная '+key+' в окружении моста.');
                keep=true;
            }
        }
        const migrate=keep&&JSON.stringify(previous)!==JSON.stringify(target),text=migrate?current.snapshot.text:undefined;
        if(migrate)migratedText(packageRoot,text,target);
        if(current.snapshot){delete current.snapshot.text;}
        fs.writeFileSync(receipt,JSON.stringify({current,saved,previous,target,text,keep,migrate,original:workerProof(install,saved)}),{flag:'wx',mode:0o600});process.stdout.write(migrate?'2':keep?'1':'0');return;
    }
    const value=JSON.parse(fs.readFileSync(receipt,'utf8'));
    if(mode==='needs-prepare'){
        const file=path.join(profileState(runtimeEnvironment(value)),'worker.lock'),lock=snapshot(file);let pid;
        if(lock){
            if(!/^[1-9]\d*$/.test(lock.text.trim()))throw Error('Повреждена блокировка прежнего worker.');
            pid=Number(lock.text.trim());if(!Number.isSafeInteger(pid)||pid<2||pid===process.pid)throw Error('Повреждена блокировка прежнего worker.');
            if(alive(pid)){process.stdout.write('1');return;}
        }
        value.skipPreparation={file,snapshot:withoutText(lock),pid};replace(receipt,JSON.stringify(value),()=>{});
        process.stdout.write('0');return;
    }
    if(mode==='assert'){
        assertCurrent(value.current);assertSkippedPreparation(value);return;
    }
    if(mode==='migrate'){
        return configLock(args[0],value.current.file,()=>{
            assertCurrent(value.current);assertSkippedPreparation(value);
            const text=migratedText(args[0],value.text,value.target);
            replace(value.current.file,text,()=>{assertCurrent(value.current);assertSkippedPreparation(value);},Number(value.current.snapshot.stamp.split(':')[5])&0o777,prepared=>{
                value.migration={sha:digest(text),identity:identity(prepared)};
                replace(receipt,JSON.stringify(value),()=>{});
            });
        });
    }
    if(mode==='restore'){
        if(!value.migration)return;
        return configLock(args[0],value.current.file,()=>{
            const current=selected();
            if(current.logical!==value.current.logical||current.file!==value.current.file)throw changed();
            if(current.snapshot?.sha===value.current.snapshot.sha)return;
            if(current.snapshot?.sha!==value.migration.sha||current.snapshot?.identity!==value.migration.identity)throw changed();
            delete current.snapshot.text;
            replace(value.current.file,value.text,()=>assertCurrent(current),Number(value.current.snapshot.stamp.split(':')[5])&0o777);
        });
    }
    if(mode==='restart'){
        const original=value.original;if(!original||alive(original.pid))return;
        const directory=fs.lstatSync(original.install);
        if(directory.dev!==original.directory.dev||directory.ino!==original.directory.ino||!directory.isDirectory()||directory.isSymbolicLink())throw Error('Прежняя папка runtime изменилась; автоматический запуск запрещён.');
        for(const [file,expected] of [[path.join(original.install,'package.json'),original.manifest],[path.join(original.install,'dist/build.json'),original.build],[path.join(original.install,'dist/index.js'),original.program]]){
            const current=snapshot(file);if(current)delete current.text;if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('Прежний runtime изменился; автоматический запуск запрещён.');
        }
        if(stamp(fs.lstatSync(path.join(original.install,'bin',nodeName),{bigint:true}))!==original.node)throw Error('Прежний Node runtime изменился; автоматический запуск запрещён.');
        try{fs.lstatSync(path.join(original.state,'worker.lock'));return;}catch(e){if(e.code!=='ENOENT')throw e;}
        const child=spawn(path.join(original.install,'bin',nodeName),[path.join(original.install,'dist/index.js'),'--worker'],{env:runtimeEnvironment(value),detached:true,stdio:'ignore'});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return;
    }
    if(mode==='run'||mode==='connect'){
        const [node,...cli]=args,result=spawnSync(node,cli,{env:runtimeEnvironment(value,mode==='connect'),stdio:'inherit'});
        if(result.error)throw result.error;if(result.signal)throw Error('Команда моста прервана сигналом '+result.signal);process.exitCode=result.status??1;return;
    }
    throw Error('Неизвестная команда контекста установщика.');
};
JS
context() {
    "$CONTEXT_NODE" - "$CONTEXT_HELPER" "$STAGING_DIR/context.json" "$@" <<'JS'
require(process.argv[2]).main(process.argv.slice(3)).catch(error=>{console.error(error.message);process.exitCode=1;});
JS
}
runtime_command() { context run "$@"; }
KEEP_REGISTRATION="$(context capture "$STAGING_DIR/package" "$INSTALL_DIR" "$SITE_URL" "$NEUROCENTER_API_URL")" || fail 'Не удалось проверить существующую регистрацию MCP. Файлы не заменены.'
if [ -e "$INSTALL_DIR" ]; then
    "$NODE" -e 'const fs=require("node:fs");if(JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).name!=="neurocenter-asset-sync")process.exit(1)' "$INSTALL_DIR" || fail 'Папка установки занята посторонними файлами. Укажите отдельную папку MCP.'
    "$NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).version;const a=String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);const b=process.argv[2].split(".").map(Number);if(!a)process.exit(1);const x=a.slice(1).map(Number);for(let i=0;i<3;i++){if(x[i]>b[i])process.exit(1);if(x[i]<b[i])break}' "$INSTALL_DIR" "$VERSION" || fail 'Автоматическое понижение версии MCP запрещено. Предыдущая установка сохранена.'
    if "$NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).version;if(!/^0\.(9|[1-9][0-9])\./.test(v))process.exit(1)' "$INSTALL_DIR"; then PREVIOUS_COMPATIBLE='1'; fi
    NEEDS_PREPARATION="$(context needs-prepare)" || fail 'Не удалось проверить состояние прежнего worker. Файлы не заменены.'
    if [ "$NEEDS_PREPARATION" = '1' ]; then
        printf '  Проверяем, что предыдущий мост завершил задания…\n'
        UPGRADE_NODE="$NODE"
        UPGRADE_ENTRY="$STAGING_DIR/package/dist/index.js"
        context assert || fail 'Конфигурация OpenCode изменилась до подготовки обновления.'
        UPGRADE_PREPARED='1'
        UPGRADE_ATTEMPTED='1'
        if ! runtime_command "$NODE" "$STAGING_DIR/package/dist/index.js" --prepare-upgrade "$INSTALL_DIR/dist/index.js" > "$STAGING_DIR/upgrade.json"; then
            show_result error "$STAGING_DIR/upgrade.json" || true
            fail 'Обновление не выполнено. Файлы предыдущего моста сохранены. Причина указана выше.'
        fi
        UPGRADE_RESULT_PAUSED="$("$NODE" -e 'try{const fs=require("node:fs");const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(result.ok!==true||typeof result.paused!=="boolean")process.exit(1);process.stdout.write(result.paused?"1":"0")}catch{process.exit(1)}' "$STAGING_DIR/upgrade.json")" || fail 'Мост не подтвердил подготовку обновления. Файлы не заменены.'
        UPGRADE_PREPARED="$UPGRADE_RESULT_PAUSED"
        if [ "$UPGRADE_RESULT_PAUSED" = '0' ]; then UPGRADE_ATTEMPTED='0'; fi
    else
        success 'Прежний worker не запущен; недоступная площадка не мешает новому подключению'
    fi
fi
context assert || fail 'Конфигурация OpenCode изменилась до замены MCP.'
if [ -f "$STAGING_DIR/package/dist/runtime-use.json" ]; then
    "$NODE" -e 'const fs=require("node:fs"),path=require("node:path");const root=process.argv[1],install=path.join(fs.realpathSync(path.dirname(process.argv[2])),path.basename(process.argv[2]));fs.writeFileSync(path.join(root,".neurocenter-update-owner.json"),JSON.stringify({schemaVersion:1,installRoot:install})+"\n",{flag:"wx",mode:0o600,flush:true});fs.writeFileSync(path.join(root,"installation.json"),JSON.stringify({schemaVersion:1,siteUrl:process.argv[3],apiUrl:process.argv[4]})+"\n",{flag:"wx",mode:0o600,flush:true});require(path.join(root,"dist/shared/bridge-update-cleanup.cjs")).writeInstalledRuntimeReceipt({installRoot:install,runtimeRoot:root}).catch(error=>{console.error(error.message);process.exitCode=1;});' "$STAGING_DIR/package" "$INSTALL_DIR" "$SITE_URL" "$NEUROCENTER_API_URL" || fail 'Не удалось сохранить принадлежность новой установки. Прежняя версия сохранена.'
fi
if [ -e "$INSTALL_DIR" ]; then
    PREVIOUS_DIR="$(mktemp -d "$INSTALL_PARENT/.neurocenter-previous.XXXXXX")"; rmdir "$PREVIOUS_DIR"
    mv "$INSTALL_DIR" "$PREVIOUS_DIR"
fi
if ! mv "$STAGING_DIR/package" "$INSTALL_DIR"; then
    if [ -n "$PREVIOUS_DIR" ]; then mv "$PREVIOUS_DIR" "$INSTALL_DIR"; fi
    fail 'Не удалось заменить MCP. Предыдущая установка восстановлена.'
fi
PUBLISHED='1'
NODE="$INSTALL_DIR/bin/node"
CONTEXT_NODE="$NODE"
UPGRADE_NODE="$NODE"
UPGRADE_ENTRY="$INSTALL_DIR/dist/index.js"
success 'Автономный пакет установлен, системные Node.js и npm не нужны'
printf '  Установлено: %s\n' "$INSTALL_DIR"
step 3 'Регистрируем MCP в OpenCode'
INIT_OK='0'
if [ "$KEEP_REGISTRATION" = '1' ]; then
    context assert || fail 'Конфигурация OpenCode изменилась во время обновления.'
    INIT_OK='1'
    success 'Существующая регистрация и настройки MCP сохранены'
elif [ "$KEEP_REGISTRATION" = '2' ]; then
    finish_upgrade || fail 'Не удалось возобновить очередь прежнего подключения. Настройки площадки сохранены; повторите установку после восстановления связи.'
    if context migrate "$INSTALL_DIR"; then
        INIT_OK='1'
        success 'Адреса площадки обновлены; настройки OpenCode и данные прежнего подключения сохранены'
    fi
elif "$NODE" "$INSTALL_DIR/dist/index.js" --init > "$STAGING_DIR/init.json"; then
    if show_result init "$STAGING_DIR/init.json"; then INIT_OK='1'; fi
else
    show_result error "$STAGING_DIR/init.json" || true
fi
if [ "$INIT_OK" != '1' ]; then
    if [ -n "$PREVIOUS_DIR" ] && [ "$PREVIOUS_COMPATIBLE" = '1' ]; then
        mv "$INSTALL_DIR" "$STAGING_DIR/failed"
        UPGRADE_NODE="$STAGING_DIR/failed/bin/node"
        UPGRADE_ENTRY="$STAGING_DIR/failed/dist/index.js"
        CONTEXT_NODE="$UPGRADE_NODE"
        mv "$PREVIOUS_DIR" "$INSTALL_DIR"
        PUBLISHED='0'
        fail 'Регистрация MCP не удалась. Совместимая предыдущая версия восстановлена. Повторите установку или перезапустите OpenCode для восстановления подключения.'
    fi
    fail "Регистрация MCP не удалась. Предыдущая версия сохранена в $PREVIOUS_DIR; автоматический откат на несовместимую версию запрещён."
fi
REGISTRATION_OK='1'
finish_upgrade || fail 'Мост установлен, но очередь не подтвердила снятие паузы. Проверьте соединение и повторите установку.'
if ! "$NODE" "$INSTALL_DIR/dist/bridge-cli.js" --install-command > "$STAGING_DIR/command.txt"; then
    fail 'Мост установлен, но короткая команда не зарегистрирована. Проверьте права в ~/.local/bin и повторите установку.'
fi
success 'Команда подключения готова: ~/.local/bin/neurocenter-bridge connect --open'
if [ -n "$PREVIOUS_DIR" ]; then printf '  Предыдущая версия: %s\n' "$PREVIOUS_DIR"; fi
finish_update_cleanup() {
    if [ ! -f "$INSTALL_DIR/dist/shared/bridge-update-cleanup.cjs" ]; then return; fi
    if [ -n "$PREVIOUS_DIR" ]; then
        "$NODE" -e 'const path=require("node:path"),root=process.argv[1];require(path.join(root,"dist/shared/bridge-update-cleanup.cjs")).writeSuccessfulBackupReceipt({installRoot:root,backupRoot:process.argv[2]}).catch(()=>{console.error("Очистка обновлений отложена; предыдущая версия сохранена.");});' "$INSTALL_DIR" "$PREVIOUS_DIR" || true
    fi
    context connect "$NODE" "$INSTALL_DIR/dist/index.js" --cleanup-updates >/dev/null || printf '  Очистка обновлений отложена; сохранённые копии доступны.\n'
}
if [ "$LOCAL_MODE" = '1' ]; then
    finish_update_cleanup
    success 'Мост установлен из локального архива. Подключение выполните отдельно на странице «Начало работы».'
    exit 0
fi
step 4 'Проверяем подключение к Нейроцентру'
CONNECT='--connect-open'
if [ "$RECONNECT" = '1' ]; then CONNECT='--reconnect-open'; fi
if ! context connect "$NODE" "$INSTALL_DIR/dist/index.js" "$CONNECT" > "$STAGING_DIR/connect.json"; then
    fail 'MCP установлен, но подключение не завершено. Причина указана выше; после её устранения повторите установку.'
fi
show_result connect "$STAGING_DIR/connect.json"
finish_update_cleanup
