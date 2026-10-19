# Автономная установка Windows: Node и зависимости приходят с площадки.
$ErrorActionPreference = 'Stop'
$BridgeBase = '__BASE_URL__'
$HubUrl = $BridgeBase -replace '/api/bridge$', ''
$Version = '0.9.4'
$Reconnect = '__RECONNECT__' -eq '1'
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
$Name = "neurocenter-asset-sync-windows-$Arch-$Version.tgz"
try {
    Set-Content -Path (Join-Path $InstallLock 'owner.pid') -Value $PID
    New-Item -ItemType Directory -Path $Stage | Out-Null
    $Archive = Join-Path $Stage 'bridge.tgz'
    Invoke-WebRequest "$BridgeBase/runtime/$Name" -OutFile $Archive -UseBasicParsing
    $Expected = ((Invoke-WebRequest "$BridgeBase/runtime/$Name.sha256" -UseBasicParsing).Content.Trim() -split '\s+')[0]
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw 'Контрольная сумма MCP не совпала. Файлы не заменены.' }
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
    $RuntimeVersion = & $Node --version
    if ($LASTEXITCODE -ne 0 -or $RuntimeVersion -notlike 'v24.*') { throw 'Runtime MCP не запускается.' }
    if ((& $Node -p 'process.platform + ":" + process.arch') -ne "win32:$Arch") { throw 'Runtime в архиве не соответствует архитектуре компьютера.' }
    $Incoming = Get-Content (Join-Path $Package 'package.json') -Raw | ConvertFrom-Json
    $Runtime = Get-Content (Join-Path $Package 'runtime.json') -Raw | ConvertFrom-Json
    $Build = Get-Content (Join-Path $Package 'dist/build.json') -Raw | ConvertFrom-Json
    if ($Incoming.name -ne 'neurocenter-asset-sync' -or $Incoming.version -ne $Version -or $Runtime.version -ne $Version -or $Build.version -ne $Version -or $Runtime.target -ne "windows-$Arch" -or $Runtime.buildId -ne $Build.buildId -or $Build.buildId -notmatch '^[a-f0-9]{64}$') { throw 'Версия или отпечаток пакета MCP не совпадает с установщиком. Файлы не заменены.' }
    $env:NEUROCENTER_URL = $HubUrl
    if (Test-Path $InstallDir) {
        $Existing = Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
        if ($Existing.name -ne 'neurocenter-asset-sync') { throw 'Папка установки занята посторонними файлами.' }
        if ([version]$Existing.version -gt [version]$Version) { throw 'Автоматическое понижение версии MCP запрещено. Предыдущая установка сохранена.' }
        $PreviousCompatible = [version]$Existing.version -ge [version]'0.9.0'
        $UpgradeNode = $Node
        $UpgradeEntry = Join-Path $Package 'dist/index.js'
        & $Node (Join-Path $Package 'dist/index.js') --prepare-upgrade (Join-Path $InstallDir 'dist/index.js')
        if ($LASTEXITCODE -ne 0) { throw 'Обновление отложено. Файлы предыдущего моста сохранены; завершите задания или восстановите связь и повторите установку.' }
        $UpgradePrepared = $true
        Move-Item $InstallDir $Previous
    }
    try { Move-Item $Package $InstallDir } catch { if (Test-Path $Previous) { Move-Item $Previous $InstallDir }; throw }
    $Node = Join-Path $InstallDir 'bin/node.exe'
    $UpgradeNode = $Node
    $UpgradeEntry = Join-Path $InstallDir 'dist/index.js'
    $env:NEUROCENTER_URL = $HubUrl
    & $Node (Join-Path $InstallDir 'dist/index.js') --init
    if ($LASTEXITCODE -ne 0) {
        if ((Test-Path $Previous) -and $PreviousCompatible) {
            Move-Item $InstallDir (Join-Path $Stage 'failed')
            $UpgradeNode = Join-Path $Stage 'failed/bin/node.exe'
            $UpgradeEntry = Join-Path $Stage 'failed/dist/index.js'
            Move-Item $Previous $InstallDir
            throw 'Регистрация MCP не удалась. Совместимая предыдущая версия восстановлена. Повторите установку или перезапустите OpenCode для восстановления подключения.'
        }
        throw "Регистрация MCP не удалась. Предыдущая версия сохранена в $Previous; автоматический откат на несовместимую версию запрещён."
    }
    if ($UpgradePrepared) {
        & $UpgradeNode $UpgradeEntry --finish-upgrade | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Мост установлен, но очередь не подтвердила снятие паузы. Проверьте соединение и повторите установку.' }
        $UpgradePrepared = $false
    }
    Write-Host 'Мост установлен без npm. Проверяем сохранённое подключение…'
    $Connect = if ($Reconnect) { '--reconnect-open' } else { '--connect-open' }
    & $Node (Join-Path $InstallDir 'dist/index.js') $Connect
    if ($LASTEXITCODE -ne 0) { throw 'Подключение не завершено. Повторите установку после восстановления связи или завершения текущего задания.' }
    Write-Host 'Если открылась страница подключения, подтвердите компьютер. Затем выберите папку на странице «Проекты».'
    Write-Host 'Перезапустите OpenCode для доступа к MCP-инструментам.'
} finally {
    if ($UpgradePrepared) {
        try { & $UpgradeNode $UpgradeEntry --finish-upgrade | Out-Null }
        catch { Write-Warning 'Не удалось снять паузу очереди; повторите установку после восстановления связи.' }
    }
    Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $InstallLock -Recurse -Force -ErrorAction SilentlyContinue
}
