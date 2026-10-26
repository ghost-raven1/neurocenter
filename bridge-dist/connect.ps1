$ErrorActionPreference = 'Stop'
$BaseUrl = '__BASE_URL__'
$SiteUrl = '__SITE_URL__'
$ApiUrl = $BaseUrl.Substring(0, $BaseUrl.Length - '/api/bridge'.Length)
$Reconnect = '__RECONNECT__' -eq '1'
$ExplicitInstall = $env:INSTALL_DIR
$PreviousSite = $env:NEUROCENTER_URL
$PreviousApi = $env:NEUROCENTER_API_URL
$InstallDir = if ($ExplicitInstall) { $ExplicitInstall } else { Join-Path $env:USERPROFILE '.opencode/neurocenter-asset-sync' }
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('neurocenter-connect-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Stage | Out-Null
$Acl = New-Object System.Security.AccessControl.DirectorySecurity
$Acl.SetAccessRuleProtection($true, $false)
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$Acl.AddAccessRule($Rule)
Set-Acl -LiteralPath $Stage -AclObject $Acl
function Download($Url, $Target) {
    if ($PSVersionTable.PSVersion.Major -ge 7) { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target -SkipCertificateCheck; return }
    # Restore the process callback before running the downloaded installer.
    if (-not ('NeurocenterBootstrapTls' -as [type])) {
        Add-Type 'public static class NeurocenterBootstrapTls { public static readonly System.Net.Security.RemoteCertificateValidationCallback Accept = delegate { return true; }; }'
    }
    $PreviousCallback = [Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = [NeurocenterBootstrapTls]::Accept
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target
    } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback = $PreviousCallback }
}
function Install-Bridge {
    Write-Host 'Нужно восстановить или обновить регистрацию моста. Запускаем установщик этой площадки.'
    $Url = $BaseUrl + '/install.ps1' + $(if ($Reconnect) { '?reconnect=1' } else { '' })
    $Script = Join-Path $Stage 'install.ps1'
    Download $Url $Script
    $env:INSTALL_DIR = $InstallDir
    & ([ScriptBlock]::Create([IO.File]::ReadAllText($Script)))
    if ($LASTEXITCODE -ne 0) { throw 'Установка моста не завершена.' }
}
# Decode only the complete generated .cmd grammar; never execute a candidate launcher.
function Get-ManagedRoot([string]$Launcher) {
    $Item = Get-Item -LiteralPath $Launcher -Force
    if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.Length -le 0 -or $Item.Length -gt 65536) { throw 'Небезопасный файл короткой команды. Укажите INSTALL_DIR.' }
    $Stream = [IO.File]::Open($Launcher,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $Bytes = New-Object byte[] 65537
        $Count = 0
        while ($Count -lt $Bytes.Length) { $Read = $Stream.Read($Bytes,$Count,$Bytes.Length-$Count); if ($Read -eq 0) { break }; $Count += $Read }
        if ($Count -ne $Item.Length) { throw 'Короткая команда изменилась. Укажите INSTALL_DIR.' }
        $Text = (New-Object System.Text.UTF8Encoding($false,$true)).GetString($Bytes,0,$Count)
    } finally { $Stream.Dispose() }
    $Matches = [regex]::Matches($Text,'(?m)^"([^"\r\n]+)" "([^"\r\n]+)" %\*\r?$')
    if ($Matches.Count -ne 1) { throw 'Неизвестный формат короткой команды. Укажите INSTALL_DIR.' }
    $Program = $Matches[0].Groups[1].Value.Replace('%%','%')
    $Entry = $Matches[0].Groups[2].Value.Replace('%%','%')
    if (-not $Program.EndsWith('\bin\node.exe',[StringComparison]::Ordinal)) { throw 'Неизвестный путь runtime. Укажите INSTALL_DIR.' }
    $Root = $Program.Substring(0,$Program.Length-'\bin\node.exe'.Length)
    if ($Root -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or $Root -match '[\x00-\x1f\x7f]' -or $Entry -cne ($Root+'\dist\bridge-cli.js')) { throw 'Несогласованные пути короткой команды. Укажите INSTALL_DIR.' }
    $NodeLiteral = $Program.Replace('%','%%'); $EntryLiteral = $Entry.Replace('%','%%')
    $Expected = (@('@echo off','setlocal DisableDelayedExpansion','rem Neurocenter bridge command v1',
        ('if not exist "'+$NodeLiteral+'" goto missing'),('if not exist "'+$EntryLiteral+'" goto missing'),
        ('"'+$NodeLiteral+'" "'+$EntryLiteral+'" %*'),'exit /b %errorlevel%',':missing',
        'echo Bridge missing. Reinstall from Neurocenter Start page. 1>&2','exit /b 1') -join "`r`n")+"`r`n"
    if ($Text -cne $Expected) { throw 'Короткая команда не соответствует установленному формату. Укажите INSTALL_DIR.' }
    return $Root
}
try {
    $Node = Join-Path $InstallDir 'bin/node.exe'
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'dist/index.js') -PathType Leaf)) {
        $Launcher = Join-Path $env:USERPROFILE '.local/bin/neurocenter-bridge.cmd'
        if (-not $ExplicitInstall -and (Test-Path -LiteralPath $Launcher)) { $InstallDir = Get-ManagedRoot $Launcher; $Node = Join-Path $InstallDir 'bin/node.exe' }
    }
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'dist/index.js') -PathType Leaf)) { Install-Bridge }
    else {
        $InstallDir = (Get-Item -LiteralPath $InstallDir).FullName
        $Context = @'
__BRIDGE_CONTEXT__
'@
        $Connect = @'
__BRIDGE_CONNECT__
'@
        $Encoding = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText((Join-Path $Stage 'context.cjs'), $Context, $Encoding)
        [IO.File]::WriteAllText((Join-Path $Stage 'connect.cjs'), $Connect, $Encoding)
        & $Node (Join-Path $Stage 'connect.cjs') $InstallDir $SiteUrl $ApiUrl $(if ($Reconnect) { '1' } else { '0' })
        $Status = $LASTEXITCODE
        if ($Status -eq 42) { Install-Bridge }
        elseif ($Status -ne 0) { throw 'Подключение установленного моста не завершено.' }
    }
} finally {
    $env:INSTALL_DIR = $ExplicitInstall
    $env:NEUROCENTER_URL = $PreviousSite
    $env:NEUROCENTER_API_URL = $PreviousApi
    if (-not (Test-Path -LiteralPath (Join-Path $Stage 'retain'))) { Remove-Item -LiteralPath $Stage -Recurse -Force }
}
