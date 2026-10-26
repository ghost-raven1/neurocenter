# Автономная установка Windows: Node и зависимости приходят с площадки.
[CmdletBinding()]
param([string]$Archive, [string]$Sha256File, [switch]$Help)
$ErrorActionPreference = 'Stop'
if ($Help) { Write-Host 'Установка: ./install.ps1 [-Archive файл.tgz [-Sha256File файл.sha256]]. По умолчанию используется файл.tgz.sha256; подключение запускается отдельно.'; return }
$LocalMode = $PSBoundParameters.ContainsKey('Archive')
if ($LocalMode) {
    if ([string]::IsNullOrWhiteSpace($Archive)) { throw 'Укажите путь после -Archive.' }
    if (-not $PSBoundParameters.ContainsKey('Sha256File')) { $Sha256File = $Archive + '.sha256' }
    if ([string]::IsNullOrWhiteSpace($Sha256File) -or -not (Test-Path -LiteralPath $Archive -PathType Leaf) -or -not (Test-Path -LiteralPath $Sha256File -PathType Leaf)) { throw 'Нужны локальный архив и файл его SHA-256. Файлы не заменены.' }
} elseif ($PSBoundParameters.ContainsKey('Sha256File')) { throw '-Sha256File применяется только вместе с -Archive.' }
$BridgeBase = '__BASE_URL__'
$HubUrl = '__SITE_URL__'
$Version = '__BRIDGE_VERSION__'
$Reconnect = '__RECONNECT__' -eq '1'
$ApiUrl = $BridgeBase -replace '/api/bridge/?$', ''
foreach ($Url in @($HubUrl, $ApiUrl)) {
    $Parsed = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$Parsed) -or $Parsed.Scheme -notin @('http','https') -or $Parsed.UserInfo -or $Url -ne $Parsed.GetLeftPart([UriPartial]::Authority)) { throw 'Нужен HTTP(S)-адрес сервера без ключей, пути и параметров.' }
}
if ($BridgeBase -notmatch '/api/bridge/?$') { throw 'Нужен адрес API Gateway с путём /api/bridge.' }
function Step($Number, $Text) { Write-Host "`n[$Number/4] $Text" }
function SafeText($Text) { return ([string]$Text -replace '[\x00-\x1f\x7f-\x9f]', ' ') }
function Download($Url, $Target) {
    try {
        if ($PSVersionTable.PSVersion.Major -ge 7) { Invoke-WebRequest $Url -OutFile $Target -UseBasicParsing -TimeoutSec 600 -SkipCertificateCheck; return }
        # A native delegate works on TLS threads without a PowerShell runspace.
        if (-not ('NeurocenterBootstrapTls' -as [type])) {
            Add-Type 'public static class NeurocenterBootstrapTls { public static readonly System.Net.Security.RemoteCertificateValidationCallback Accept = delegate { return true; }; }'
        }
        $PreviousCallback = [Net.ServicePointManager]::ServerCertificateValidationCallback
        try {
            [Net.ServicePointManager]::ServerCertificateValidationCallback = [NeurocenterBootstrapTls]::Accept
            Invoke-WebRequest $Url -OutFile $Target -UseBasicParsing -TimeoutSec 600
        } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback = $PreviousCallback }
    } catch { throw 'Не удалось скачать пакет с площадки. Проверьте адрес, прокси и сеть. Проверка сертификатов загрузки отключена; прежняя версия сохранена.' }
}
$Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -eq 'x64') { $Arch = 'x64' } elseif ($Architecture -eq 'arm64') { $Arch = 'arm64' } else { throw 'Эта архитектура Windows не поддерживается.' }
$InstallDir = if ($env:INSTALL_DIR) { [IO.Path]::GetFullPath($env:INSTALL_DIR) } else { Join-Path $env:USERPROFILE '.opencode/neurocenter-asset-sync' }
$Parent = Split-Path -LiteralPath $InstallDir
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
$InstallLock = $InstallDir + '.install-lock'
try { New-Item -ItemType Directory -Path $InstallLock -ErrorAction Stop | Out-Null }
catch { throw "Другая установка моста уже выполняется. Дождитесь её завершения. Если она была прервана, проверьте PID в $InstallLock/owner.pid и удалите только эту блокировку после завершения процесса." }
$Stage = Join-Path $Parent ('.neurocenter-install-' + [guid]::NewGuid())
$Previous = $InstallDir + '.previous-' + [guid]::NewGuid()
$PreviousCompatible = $false
$ContextState = @{ Node = $null; Prepared = $false }
$UpgradeAttempted = $false
$Published = $false
$Registered = $false
$Recovery = $false
$PreviousSite = $env:NEUROCENTER_URL
$PreviousApi = $env:NEUROCENTER_API_URL
$ContextHelper = Join-Path $Stage 'context.cjs'
$ContextFile = Join-Path $Stage 'context.json'
function Invoke-BridgeContext {
    & ($ContextState.Node) -e 'require(process.argv[1]).main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1})' $ContextHelper $ContextFile @args
}
function Finish-Upgrade([string]$UpgradeNode, [string]$UpgradeEntry) {
    if ($ContextState.Prepared) {
        $Result = Invoke-BridgeContext run $UpgradeNode $UpgradeEntry --finish-upgrade
        $Status = $LASTEXITCODE
        $Value = $Result | ConvertFrom-Json
        if ($Status -ne 0 -or $Value.ok -ne $true) { throw 'Очередь прежнего подключения не подтвердила снятие паузы.' }
        $ContextState.Prepared = $false
    }
}
$Name = "neurocenter-asset-sync-windows-$Arch-$Version.tgz"
try {
    Set-Content -LiteralPath (Join-Path $InstallLock 'owner.pid') -Value $PID
    New-Item -ItemType Directory -Path $Stage | Out-Null
    $Acl = New-Object System.Security.AccessControl.DirectorySecurity
    $Acl.SetAccessRuleProtection($true, $false)
    $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $Acl.AddAccessRule($Rule)
    Set-Acl -LiteralPath $Stage -AclObject $Acl
    Write-Host "`nНейроцентр · установка MCP $Version, Windows $Arch"
    $StagedArchive = Join-Path $Stage 'bridge.tgz'
    $HashFile = Join-Path $Stage 'expected.sha256'
    if ($LocalMode) {
        Step 1 'Готовим локальный архив'
        Copy-Item -LiteralPath $Archive -Destination $StagedArchive
        Copy-Item -LiteralPath $Sha256File -Destination $HashFile
    } else {
        Step 1 'Скачиваем автономный пакет'
        Download "$BridgeBase/runtime/$Name" $StagedArchive
        Download "$BridgeBase/runtime/$Name.sha256" $HashFile
    }
    $Expected = ((Get-Content -LiteralPath $HashFile -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $StagedArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw 'Контрольная сумма MCP не совпала. Файлы не заменены.' }
    Step 2 'Проверяем и устанавливаем пакет'
    Write-Host '  Контрольная сумма SHA-256 совпала.'
    $Entries = & tar -tzf $StagedArchive
    if ($LASTEXITCODE -ne 0) { throw 'Повреждён архив MCP.' }
    foreach ($Entry in $Entries) { if ($Entry -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|^[a-zA-Z]:)') { throw 'В архиве MCP обнаружен недопустимый путь.' } }
    $Details = & tar -tvzf $StagedArchive
    if ($LASTEXITCODE -ne 0 -or ($Details | Where-Object { $_ -match '^[^d-]' })) { throw 'Архив со ссылками или специальными файлами не поддерживается.' }
    $Package = Join-Path $Stage 'package'
    New-Item -ItemType Directory -Path $Package | Out-Null
    & tar -xzf $StagedArchive -C $Package
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось распаковать MCP.' }
    $Node = Join-Path $Package 'bin/node.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $Package 'dist/index.js'))) { throw 'В архиве нет программы MCP.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Package 'dist/bridge-cli.js'))) { throw 'Пакет моста устарел: нет команды подключения. Администратору нужно опубликовать новую сборку; прежняя установка сохранена.' }
    $RuntimeVersion = & $Node --version
    if ($LASTEXITCODE -ne 0 -or $RuntimeVersion -notlike 'v24.*') { throw 'Runtime MCP не запускается.' }
    if ((& $Node -p 'process.platform + ":" + process.arch') -ne "win32:$Arch") { throw 'Runtime в архиве не соответствует архитектуре компьютера.' }
    $Incoming = Get-Content -LiteralPath (Join-Path $Package 'package.json') -Raw | ConvertFrom-Json
    $Runtime = Get-Content -LiteralPath (Join-Path $Package 'runtime.json') -Raw | ConvertFrom-Json
    $Build = Get-Content -LiteralPath (Join-Path $Package 'dist/build.json') -Raw | ConvertFrom-Json
    if ($Incoming.name -ne 'neurocenter-asset-sync' -or $Incoming.version -ne $Version -or $Runtime.version -ne $Version -or $Build.version -ne $Version -or $Runtime.target -ne "windows-$Arch" -or $Runtime.buildId -ne $Build.buildId -or $Build.buildId -notmatch '^[a-f0-9]{64}$') { throw 'Версия или отпечаток пакета MCP не совпадает с установщиком. Файлы не заменены.' }
    $env:NEUROCENTER_URL = $HubUrl
    $env:NEUROCENTER_API_URL = $ApiUrl
    $ContextState.Node = $Node
    $ContextPackage = $Package
    $ContextSource = @'
__BRIDGE_CONTEXT__
'@
    [IO.File]::WriteAllText($ContextHelper, $ContextSource, (New-Object System.Text.UTF8Encoding($false)))
    $KeepRegistration = Invoke-BridgeContext capture $Package $InstallDir $HubUrl $ApiUrl
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить существующую регистрацию MCP. Файлы не заменены.' }
    if (Test-Path -LiteralPath $InstallDir) {
        $Existing = Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
        if ($Existing.name -ne 'neurocenter-asset-sync') { throw 'Папка установки занята посторонними файлами.' }
        if ([version]$Existing.version -gt [version]$Version) { throw 'Автоматическое понижение версии MCP запрещено. Предыдущая установка сохранена.' }
        $PreviousCompatible = [version]$Existing.version -ge [version]'0.9.0'
        $NeedsPreparation = Invoke-BridgeContext needs-prepare
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить состояние прежнего worker.' }
        if ($NeedsPreparation -eq '1') {
            Invoke-BridgeContext assert | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Конфигурация OpenCode изменилась до подготовки обновления.' }
            $UpgradeNode = $Node
            $UpgradeEntry = Join-Path $Package 'dist/index.js'
            $ContextState.Prepared = $true
            $UpgradeAttempted = $true
            $UpgradeJson = Invoke-BridgeContext run $UpgradeNode $UpgradeEntry --prepare-upgrade (Join-Path $InstallDir 'dist/index.js')
            $UpgradeStatus = $LASTEXITCODE
            $Upgrade = $UpgradeJson | ConvertFrom-Json
            if ($UpgradeStatus -ne 0 -or $Upgrade.ok -ne $true -or $Upgrade.paused -isnot [bool]) { throw 'Обновление не выполнено. Файлы предыдущего моста сохранены.' }
            $ContextState.Prepared = $Upgrade.paused
            if (-not $Upgrade.paused) { $UpgradeAttempted = $false }
        }
    }
    Invoke-BridgeContext assert | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Конфигурация OpenCode изменилась до замены MCP.' }
    if (Test-Path -LiteralPath (Join-Path $Package 'dist/runtime-use.json')) {
        & $Node -e 'const fs=require("node:fs"),path=require("node:path");const install=path.join(fs.realpathSync(path.dirname(process.argv[2])),path.basename(process.argv[2]));const root=process.argv[1];fs.writeFileSync(path.join(root,".neurocenter-update-owner.json"),JSON.stringify({schemaVersion:1,installRoot:install})+"\n",{flag:"wx",mode:0o600,flush:true});fs.writeFileSync(path.join(root,"installation.json"),JSON.stringify({schemaVersion:1,siteUrl:process.argv[3],apiUrl:process.argv[4]})+"\n",{flag:"wx",mode:0o600,flush:true});require(path.join(root,"dist/shared/bridge-update-cleanup.cjs")).writeInstalledRuntimeReceipt({installRoot:install,runtimeRoot:root}).catch(error=>{console.error(error.message);process.exitCode=1;});' $Package $InstallDir $HubUrl $ApiUrl
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось сохранить принадлежность новой установки. Прежняя версия сохранена.' }
    }
    if (Test-Path -LiteralPath $InstallDir) {
        Move-Item -LiteralPath $InstallDir -Destination $Previous
    }
    try { Move-Item -LiteralPath $Package -Destination $InstallDir } catch { if (Test-Path -LiteralPath $Previous) { Move-Item -LiteralPath $Previous -Destination $InstallDir }; throw }
    $Published = $true
    $Node = Join-Path $InstallDir 'bin/node.exe'
    $ContextState.Node = $Node
    $ContextPackage = $InstallDir
    $UpgradeNode = $Node
    $UpgradeEntry = Join-Path $InstallDir 'dist/index.js'
    $env:NEUROCENTER_URL = $HubUrl
    Step 3 'Регистрируем MCP в OpenCode'
    $Init = $null
    $InitStatus = 1
    try {
        if ($KeepRegistration -eq '1') {
            Invoke-BridgeContext assert | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Конфигурация OpenCode изменилась во время обновления.' }
            $InitStatus = 0
        } elseif ($KeepRegistration -eq '2') {
            Finish-Upgrade $UpgradeNode $UpgradeEntry
            Invoke-BridgeContext migrate $InstallDir | Out-Null
            $InitStatus = $LASTEXITCODE
        } else {
            $InitJson = & $Node (Join-Path $InstallDir 'dist/index.js') --init
            $InitStatus = $LASTEXITCODE
            $Init = $InitJson | ConvertFrom-Json
            if ($Init.ok -ne $true) { $InitStatus = 1 }
        }
    } catch { $InitStatus = 1 }
    if ($InitStatus -ne 0) {
        if ($Init.error) { Write-Host (SafeText $Init.error) }
        throw 'Регистрация MCP не удалась. Выполняем безопасное восстановление прежнего состояния.'
    }
    $Registered = $true
    Write-Host $(if ($KeepRegistration -eq '1') { '  Существующая регистрация MCP сохранена.' } elseif ($KeepRegistration -eq '2') { '  Адреса площадки обновлены; настройки OpenCode сохранены.' } else { '  Регистрация MCP в OpenCode обновлена.' })
    if ($Init.configPath) { Write-Host ('  Конфигурация: ' + (SafeText $Init.configPath)) }
    Finish-Upgrade $UpgradeNode $UpgradeEntry
    & $Node (Join-Path $InstallDir 'dist/bridge-cli.js') --install-command | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Мост установлен, но короткая команда не зарегистрирована. Проверьте права в ~/.local/bin и повторите установку.' }
    Write-Host '  Команда подключения готова: ~/.local/bin/neurocenter-bridge.cmd connect --open'
    function Complete-UpdateCleanup {
        if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'dist/shared/bridge-update-cleanup.cjs'))) { return }
        try {
            if (Test-Path -LiteralPath $Previous) {
                & $Node -e 'const path=require("node:path"),root=process.argv[1];require(path.join(root,"dist/shared/bridge-update-cleanup.cjs")).writeSuccessfulBackupReceipt({installRoot:root,backupRoot:process.argv[2]}).catch(()=>{console.error("Очистка обновлений отложена; предыдущая версия сохранена.");});' $InstallDir $Previous
            }
            Invoke-BridgeContext connect $Node (Join-Path $InstallDir 'dist/index.js') --cleanup-updates | Out-Null
        } catch { Write-Warning 'Очистка обновлений отложена; сохранённые копии доступны.' }
    }
    if ($LocalMode) { Complete-UpdateCleanup; Write-Host 'Мост установлен из локального архива. Подключение выполните отдельно на странице «Начало работы».'; return }
    Step 4 'Проверяем подключение к Нейроцентру'
    Invoke-BridgeContext connect $Node (Join-Path $InstallDir 'dist/index.js') $(if ($Reconnect) { '--reconnect-open' } else { '--connect-open' })
    if ($LASTEXITCODE -ne 0) { throw 'Подключение не завершено. Повторите установку после восстановления связи или завершения текущего задания.' }
    Complete-UpdateCleanup
    Write-Host 'Если открылась страница подключения, подтвердите компьютер. Затем выберите папку на странице «Проекты».'
    Write-Host 'Перезапустите OpenCode для доступа к MCP-инструментам.'
} finally {
    if (-not $Registered -and (Test-Path -LiteralPath $ContextFile)) {
        try { Invoke-BridgeContext restore $ContextPackage | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Восстановление регистрации не подтверждено.' } }
        catch { $Recovery = $true; Write-Warning "Приватный снимок и план восстановления сохранены: $Stage" }
    }
    if ($Published -and -not $Registered -and $PreviousCompatible -and (Test-Path -LiteralPath $Previous)) {
        try {
            $Failed = Join-Path $Stage 'failed-cancelled'
            Move-Item -LiteralPath $InstallDir -Destination $Failed
            Move-Item -LiteralPath $Previous -Destination $InstallDir
            $UpgradeNode = Join-Path $Failed 'bin/node.exe'
            $UpgradeEntry = Join-Path $Failed 'dist/index.js'
            $ContextState.Node = $UpgradeNode
            $Published = $false
            Write-Warning 'Прежняя версия восстановлена после прерванной регистрации.'
        } catch { $Recovery = $true; Write-Warning "Автоматический откат не подтверждён. Файлы сохранены: $Stage; $Previous" }
    }
    $Resumed = $false
    try { Finish-Upgrade $UpgradeNode $UpgradeEntry; $Resumed = $true } catch { Write-Warning 'Не удалось снять паузу очереди; повторите установку после восстановления связи.' }
    if ($UpgradeAttempted -and -not $Published -and $Resumed) {
        try { Invoke-BridgeContext restart | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Запуск не подтверждён.' } } catch { Write-Warning 'Запуск прежнего worker не подтверждён. Перезапустите OpenCode.' }
    }
    $env:NEUROCENTER_URL = $PreviousSite
    $env:NEUROCENTER_API_URL = $PreviousApi
    if (-not $Recovery) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $InstallLock -Recurse -Force -ErrorAction SilentlyContinue
}
