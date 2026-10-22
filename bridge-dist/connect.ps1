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
function Install-Bridge {
    Write-Host 'Нужно восстановить или обновить регистрацию моста. Запускаем установщик этой площадки.'
    $Url = $BaseUrl + '/install.ps1' + $(if ($Reconnect) { '?reconnect=1' } else { '' })
    $Script = Join-Path $Stage 'install.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Script
    $env:INSTALL_DIR = $InstallDir
    & ([ScriptBlock]::Create([IO.File]::ReadAllText($Script)))
    if ($LASTEXITCODE -ne 0) { throw 'Установка моста не завершена.' }
}
try {
    $Node = Join-Path $InstallDir 'bin/node.exe'
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'dist/index.js') -PathType Leaf)) {
        $Launcher = Join-Path $env:USERPROFILE '.local/bin/neurocenter-bridge.cmd'
        if (-not $ExplicitInstall -and (Test-Path -LiteralPath $Launcher -PathType Leaf) -and ([IO.File]::ReadAllText($Launcher).Contains('Neurocenter bridge command v1'))) {
            $env:NEUROCENTER_URL = $SiteUrl; $env:NEUROCENTER_API_URL = $ApiUrl
            $Arguments = @('connect','--open'); if ($Reconnect) { $Arguments += '--reconnect' }
            & $Launcher @Arguments
            if ($LASTEXITCODE -ne 0) { throw 'Подключение установленного моста не завершено.' }
        } else { Install-Bridge }
    } else {
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
