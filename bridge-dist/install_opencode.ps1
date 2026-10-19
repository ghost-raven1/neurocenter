# Установка OpenCode в Windows из готовых архивов этой площадки.
$ErrorActionPreference = 'Stop'
$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { '__BASE_URL__' }
$Version = if ($env:OPENCODE_VERSION) { $env:OPENCODE_VERSION } else { '1.14.48' }
$InstallDir = if ($env:OPENCODE_INSTALL_DIR) { $env:OPENCODE_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
$ConfigRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' }
$DataRoot = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:USERPROFILE '.local\share' }
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $ConfigRoot 'opencode' }
$AuthDir = if ($env:OPENCODE_AUTH_DIR) { $env:OPENCODE_AUTH_DIR } else { Join-Path $DataRoot 'opencode' }
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Arch -notin @('x64', 'arm64')) { throw "Архитектура $Arch не поддерживается." }
$Variant = "opencode-windows-$Arch"
if ($Arch -eq 'x64') { $Variant += '-baseline' }
$ArchiveName = "$Variant-$Version.tgz"
$Stage = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
    Write-Host "OpenCode $Version, Windows $Arch. Скачиваем с площадки Нейроцентра…"
    $Archive = Join-Path $Stage 'package.tgz'
    Invoke-WebRequest "$BaseUrl/opencode/$ArchiveName" -OutFile $Archive -UseBasicParsing
    $Expected = ((Invoke-WebRequest "$BaseUrl/opencode/$ArchiveName.sha256" -UseBasicParsing).Content.Trim() -split '\s+')[0]
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) {
        throw 'Контрольная сумма пакета не совпала.'
    }
    $Entries = & tar -tzf $Archive
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось прочитать архив.' }
    foreach ($Entry in $Entries) {
        if ($Entry -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|^[a-zA-Z]:)') { throw 'В архиве обнаружен недопустимый путь.' }
    }
    $Details = & tar -tvzf $Archive
    if ($LASTEXITCODE -ne 0 -or ($Details | Where-Object { $_ -match '^[lh]' })) { throw 'Архив со ссылками не поддерживается.' }
    & tar -xzf $Archive -C $Stage
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось распаковать пакет.' }
    $Binary = Get-ChildItem $Stage -Recurse -Filter 'opencode.exe' -File | Select-Object -First 1
    if (-not $Binary) { throw 'В архиве нет opencode.exe.' }
    $InstalledVersion = & $Binary.FullName --version
    if ($LASTEXITCODE -ne 0 -or -not $InstalledVersion) { throw 'OpenCode не запускается на этой системе.' }
    foreach ($Dir in @($InstallDir, $ConfigDir, $AuthDir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
    if (-not (Test-Path (Join-Path $ConfigDir 'opencode.json')) -and -not (Test-Path (Join-Path $ConfigDir 'opencode.jsonc'))) {
        $Config = @'
{
  "$schema": "https://opencode.ai/config.json"
}
'@
        [IO.File]::WriteAllText((Join-Path $ConfigDir 'opencode.jsonc'), $Config, (New-Object Text.UTF8Encoding $false))
    } else { Write-Host 'Существующая конфигурация OpenCode сохранена.' }
    $AuthFile = Join-Path $AuthDir 'auth.json'
    if (Test-Path $AuthFile) { Write-Host 'Существующие ключи авторизации сохранены. Для смены ключа: opencode auth login' }
    # Ключ нельзя привязать к провайдеру, пока пользователь его не выбрал.
    if ($env:OPENCODE_API_KEY) { Write-Host 'OPENCODE_API_KEY не сохранён: выберите провайдера через opencode auth login.' }
    Write-Host 'Провайдер и модель установщиком не настраиваются. Выберите их в OpenCode; для авторизации: opencode auth login'
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($InstallDir -notin ($UserPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$UserPath", 'User')
    }
    $env:Path = "$InstallDir;$env:Path"
    Copy-Item $Binary.FullName (Join-Path $InstallDir '.opencode-next.exe') -Force
    Move-Item (Join-Path $InstallDir '.opencode-next.exe') (Join-Path $InstallDir 'opencode.exe') -Force
    Write-Host "Установлен OpenCode $InstalledVersion. Запустите opencode из папки проекта."
} finally { Remove-Item $Stage -Recurse -Force }
