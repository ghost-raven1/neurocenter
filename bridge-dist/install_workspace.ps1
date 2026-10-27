# Последовательно запускает существующие установщики с одной проверенной площадки.
[CmdletBinding()]
param([switch]$BridgeOnly, [switch]$Help)
$ErrorActionPreference = 'Stop'
if ($Help) { Write-Host 'OpenCode и мост: ./install_workspace.ps1. Продолжить только мост: ./install_workspace.ps1 -BridgeOnly'; return }
$BaseUrl = '__BASE_URL__'
$SiteUrl = '__SITE_URL__'
$Version = '__BRIDGE_VERSION__'
$Reconnect = '__RECONNECT__'
foreach ($Value in @($BaseUrl, $SiteUrl)) {
    $Parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Parsed) -or $Parsed.Scheme -notin @('http','https') -or $Parsed.UserInfo -or $Parsed.Query -or $Parsed.Fragment) { throw 'Нужен адрес установщика с проверенной площадки Нейроцентра.' }
}
if ($BaseUrl -notmatch '^https?://[^/?#@\s]+/api/bridge$' -or $SiteUrl -notmatch '^https?://[^/?#@\s]+$' -or $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Адрес площадки или версия поставки не подтверждены.' }
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('neurocenter-workspace-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
$PreviousBaseUrl = [Environment]::GetEnvironmentVariable('BASE_URL', 'Process')
$PreviousVersion = [Environment]::GetEnvironmentVariable('OPENCODE_VERSION', 'Process')
function Download($Url, $Target) {
    if ($PSVersionTable.PSVersion.Major -ge 7) { Invoke-WebRequest $Url -OutFile $Target -UseBasicParsing -TimeoutSec 600 -SkipCertificateCheck; return }
    if (-not ('NeurocenterBootstrapTls' -as [type])) {
        Add-Type 'public static class NeurocenterBootstrapTls { public static readonly System.Net.Security.RemoteCertificateValidationCallback Accept = delegate { return true; }; }'
    }
    $PreviousCallback = [Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = [NeurocenterBootstrapTls]::Accept
        Invoke-WebRequest $Url -OutFile $Target -UseBasicParsing -TimeoutSec 600
    } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback = $PreviousCallback }
}
function Run-Installer($File) {
    $ShellName = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    & (Join-Path $PSHOME $ShellName) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $File
    $NativeExitCode = $LASTEXITCODE
    if ($NativeExitCode -ne 0) {
        $Failure = [Exception]::new("Установщик завершился с кодом $NativeExitCode.")
        $Failure.Data['NeurocenterChildExitCode'] = $NativeExitCode
        throw $Failure
    }
}
$Phase = 'download'
$InstallerExitCode = 0
try {
    Write-Host "`nНейроцентр · OpenCode и мост"
    $OpenCodeScript = Join-Path $Stage 'opencode.ps1'
    $BridgeScript = Join-Path $Stage 'bridge.ps1'
    # Оба сценария должны быть доступны до первого изменения установки.
    if (-not $BridgeOnly) { Download "$BaseUrl/install_opencode.ps1" $OpenCodeScript }
    Download "$BaseUrl/install.ps1?version=$Version&reconnect=$Reconnect" $BridgeScript
    if ((Get-Item -LiteralPath $BridgeScript).Length -eq 0 -or (-not $BridgeOnly -and (Get-Item -LiteralPath $OpenCodeScript).Length -eq 0)) { throw 'Площадка вернула пустой установщик.' }
    $env:BASE_URL = $BaseUrl
    $env:OPENCODE_VERSION = '1.14.48'
    if (-not $BridgeOnly) {
        $Phase = 'opencode'
        Write-Host "`n[1/2] Устанавливаем OpenCode 1.14.48…"
        Run-Installer $OpenCodeScript
    }
    $Phase = 'bridge'
    Write-Host "`n[2/2] Устанавливаем мост и открываем подключение…"
    Run-Installer $BridgeScript
    Write-Host "`nВыбранные установочные этапы завершены. Вернитесь на $SiteUrl/start : подтвердите подключение и выберите проект и папку."
    Write-Host 'Готовность агентов, инструментов и модели проверяется отдельно на странице настройки.'
} catch {
    if ($Phase -eq 'bridge') {
        if ($BridgeOnly) { Write-Host 'OpenCode в этом запуске не изменялся.' } else { Write-Host 'Успешный этап OpenCode сохранён.' }
        Write-Host 'Для продолжения только моста скачайте существующий установщик и запустите его:'
        Write-Host "  $BaseUrl/install.ps1?version=$Version&reconnect=$Reconnect"
        Write-Host '  ./install.ps1'
    } elseif ($Phase -eq 'opencode') { Write-Host 'Мост ещё не запускался. Устраните причину и повторите команду.' }
    else { Write-Host 'Не удалось получить установщики. Установка ещё не запускалась; повторите команду.' }
    if ($_.Exception.Data.Contains('NeurocenterChildExitCode')) {
        $InstallerExitCode = [int]$_.Exception.Data['NeurocenterChildExitCode']
        Write-Host $_.Exception.Message
    } else { throw }
} finally {
    [Environment]::SetEnvironmentVariable('BASE_URL', $PreviousBaseUrl, 'Process')
    [Environment]::SetEnvironmentVariable('OPENCODE_VERSION', $PreviousVersion, 'Process')
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
if ($InstallerExitCode -ne 0) { exit $InstallerExitCode }
