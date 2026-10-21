# Автономная установка Windows: Node и зависимости приходят с площадки.
$ErrorActionPreference = 'Stop'
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
    try { Invoke-WebRequest $Url -OutFile $Target -UseBasicParsing -TimeoutSec 600 }
    catch { throw 'Не удалось скачать пакет с площадки. Проверьте сеть и доверенный корпоративный CA в Windows. Проверка TLS остаётся включённой; прежняя версия сохранена.' }
}
$Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -eq 'x64') { $Arch = 'x64' } elseif ($Architecture -eq 'arm64') { $Arch = 'arm64' } else { throw 'Эта архитектура Windows не поддерживается.' }
$InstallDir = Join-Path $env:USERPROFILE '.opencode/neurocenter-asset-sync'
$Parent = Split-Path $InstallDir
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
$InstallLock = $InstallDir + '.install-lock'
try { New-Item -ItemType Directory -Path $InstallLock -ErrorAction Stop | Out-Null }
catch { throw "Другая установка моста уже выполняется. Дождитесь её завершения. Если она была прервана, проверьте PID в $InstallLock/owner.pid и удалите только эту блокировку после завершения процесса." }
$Stage = Join-Path $Parent ('.neurocenter-install-' + [guid]::NewGuid())
$Previous = $InstallDir + '.previous-' + [guid]::NewGuid()
$PreviousCompatible = $false
$UpgradePrepared = $false
$Published = $false
$Registered = $false
$Name = "neurocenter-asset-sync-windows-$Arch-$Version.tgz"
try {
    Set-Content -Path (Join-Path $InstallLock 'owner.pid') -Value $PID
    New-Item -ItemType Directory -Path $Stage | Out-Null
    Write-Host "`nНейроцентр · установка MCP $Version, Windows $Arch"
    Step 1 'Скачиваем автономный пакет'
    $Archive = Join-Path $Stage 'bridge.tgz'
    Download "$BridgeBase/runtime/$Name" $Archive
    $HashFile = Join-Path $Stage 'expected.sha256'
    Download "$BridgeBase/runtime/$Name.sha256" $HashFile
    $Expected = ((Get-Content $HashFile -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw 'Контрольная сумма MCP не совпала. Файлы не заменены.' }
    Step 2 'Проверяем и устанавливаем пакет'
    Write-Host '  Контрольная сумма SHA-256 совпала.'
    $Entries = & tar -tzf $Archive
    if ($LASTEXITCODE -ne 0) { throw 'Повреждён архив MCP.' }
    foreach ($Entry in $Entries) { if ($Entry -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|^[a-zA-Z]:)') { throw 'В архиве MCP обнаружен недопустимый путь.' } }
    $Details = & tar -tvzf $Archive
    if ($LASTEXITCODE -ne 0 -or ($Details | Where-Object { $_ -match '^[^d-]' })) { throw 'Архив со ссылками или специальными файлами не поддерживается.' }
    $Package = Join-Path $Stage 'package'
    New-Item -ItemType Directory -Path $Package | Out-Null
    & tar -xzf $Archive -C $Package
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось распаковать MCP.' }
    $Node = Join-Path $Package 'bin/node.exe'
    if (-not (Test-Path (Join-Path $Package 'dist/index.js'))) { throw 'В архиве нет программы MCP.' }
    if (-not (Test-Path (Join-Path $Package 'dist/bridge-cli.js'))) { throw 'Пакет моста устарел: нет команды подключения. Администратору нужно опубликовать новую сборку; прежняя установка сохранена.' }
    $RuntimeVersion = & $Node --version
    if ($LASTEXITCODE -ne 0 -or $RuntimeVersion -notlike 'v24.*') { throw 'Runtime MCP не запускается.' }
    if ((& $Node -p 'process.platform + ":" + process.arch') -ne "win32:$Arch") { throw 'Runtime в архиве не соответствует архитектуре компьютера.' }
    $Incoming = Get-Content (Join-Path $Package 'package.json') -Raw | ConvertFrom-Json
    $Runtime = Get-Content (Join-Path $Package 'runtime.json') -Raw | ConvertFrom-Json
    $Build = Get-Content (Join-Path $Package 'dist/build.json') -Raw | ConvertFrom-Json
    if ($Incoming.name -ne 'neurocenter-asset-sync' -or $Incoming.version -ne $Version -or $Runtime.version -ne $Version -or $Build.version -ne $Version -or $Runtime.target -ne "windows-$Arch" -or $Runtime.buildId -ne $Build.buildId -or $Build.buildId -notmatch '^[a-f0-9]{64}$') { throw 'Версия или отпечаток пакета MCP не совпадает с установщиком. Файлы не заменены.' }
    $env:NEUROCENTER_URL = $HubUrl
    $env:NEUROCENTER_API_URL = $ApiUrl
    if (Test-Path $InstallDir) {
        $Existing = Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
        if ($Existing.name -ne 'neurocenter-asset-sync') { throw 'Папка установки занята посторонними файлами.' }
        if ([version]$Existing.version -gt [version]$Version) { throw 'Автоматическое понижение версии MCP запрещено. Предыдущая установка сохранена.' }
        $PreviousCompatible = [version]$Existing.version -ge [version]'0.9.0'
        $UpgradeNode = $Node
        $UpgradeEntry = Join-Path $Package 'dist/index.js'
        $UpgradeJson = & $Node (Join-Path $Package 'dist/index.js') --prepare-upgrade (Join-Path $InstallDir 'dist/index.js')
        $Upgrade = $UpgradeJson | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $Upgrade.ok -ne $true) { throw "Обновление не выполнено. Файлы предыдущего моста сохранены. $($Upgrade.error)" }
        $UpgradePrepared = $Upgrade.paused -ne $false
        Move-Item $InstallDir $Previous
    }
    try { Move-Item $Package $InstallDir } catch { if (Test-Path $Previous) { Move-Item $Previous $InstallDir }; throw }
    $Published = $true
    $Node = Join-Path $InstallDir 'bin/node.exe'
    $UpgradeNode = $Node
    $UpgradeEntry = Join-Path $InstallDir 'dist/index.js'
    $env:NEUROCENTER_URL = $HubUrl
    Step 3 'Регистрируем MCP в OpenCode'
    $Init = $null
    try {
        $InitJson = & $Node (Join-Path $InstallDir 'dist/index.js') --init
        $InitStatus = $LASTEXITCODE
        $Init = $InitJson | ConvertFrom-Json
    } catch { $InitStatus = 1 }
    if ($InitStatus -ne 0 -or $Init.ok -ne $true) {
        if ($Init.error) { Write-Host (SafeText $Init.error) }
        if ((Test-Path $Previous) -and $PreviousCompatible) {
            Move-Item $InstallDir (Join-Path $Stage 'failed')
            $UpgradeNode = Join-Path $Stage 'failed/bin/node.exe'
            $UpgradeEntry = Join-Path $Stage 'failed/dist/index.js'
            Move-Item $Previous $InstallDir
            $Published = $false
            throw 'Регистрация MCP не удалась. Совместимая предыдущая версия восстановлена. Повторите установку или перезапустите OpenCode для восстановления подключения.'
        }
        throw "Регистрация MCP не удалась. Предыдущая версия сохранена в $Previous; автоматический откат на несовместимую версию запрещён."
    }
    $Registered = $true
    Write-Host $(if ($Init.created) { '  Создана конфигурация OpenCode.' } else { '  Регистрация MCP в OpenCode обновлена.' })
    if ($Init.configPath) { Write-Host ('  Конфигурация: ' + (SafeText $Init.configPath)) }
    if ($UpgradePrepared) {
        $FinishJson = & $UpgradeNode $UpgradeEntry --finish-upgrade
        $FinishStatus = $LASTEXITCODE
        $Finish = $FinishJson | ConvertFrom-Json
        if ($FinishStatus -ne 0 -or $Finish.ok -ne $true) { throw 'Мост установлен, но очередь не подтвердила снятие паузы. Проверьте соединение и повторите установку.' }
        $UpgradePrepared = $false
    }
    & $Node (Join-Path $InstallDir 'dist/bridge-cli.js') --install-command | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Мост установлен, но короткая команда не зарегистрирована. Проверьте права в ~/.local/bin и повторите установку.' }
    Write-Host '  Команда подключения готова: ~/.local/bin/neurocenter-bridge.cmd connect --open'
    Step 4 'Проверяем подключение к Нейроцентру'
    $Arguments = @((Join-Path $InstallDir 'dist/bridge-cli.js'), 'connect', '--open')
    if ($Reconnect) { $Arguments += '--reconnect' }
    & $Node @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Подключение не завершено. Повторите установку после восстановления связи или завершения текущего задания.' }
    Write-Host 'Если открылась страница подключения, подтвердите компьютер. Затем выберите папку на странице «Проекты».'
    Write-Host 'Перезапустите OpenCode для доступа к MCP-инструментам.'
} finally {
    if ($Published -and -not $Registered -and $PreviousCompatible -and (Test-Path $Previous)) {
        $Failed = Join-Path $Stage 'failed-cancelled'
        Move-Item $InstallDir $Failed
        Move-Item $Previous $InstallDir
        $UpgradeNode = Join-Path $Failed 'bin/node.exe'
        $UpgradeEntry = Join-Path $Failed 'dist/index.js'
        Write-Warning 'Прежняя версия восстановлена после прерванной регистрации.'
    }
    if ($UpgradePrepared) {
        try { & $UpgradeNode $UpgradeEntry --finish-upgrade | Out-Null }
        catch { Write-Warning 'Не удалось снять паузу очереди; повторите установку после восстановления связи.' }
    }
    Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $InstallLock -Recurse -Force -ErrorAction SilentlyContinue
}
