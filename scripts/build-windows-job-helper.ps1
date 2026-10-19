param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
# Запускать в Native Tools for Visual Studio для нужной архитектуры Windows.
$source = Join-Path $PSScriptRoot '../mcp/neurocenter-asset-sync/native/windows-job.cpp'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$target = Join-Path $OutputDirectory 'neurocenter-job.exe'
$object = Join-Path $OutputDirectory 'neurocenter-job.obj'
& cl.exe /nologo /O2 /W4 /WX /EHsc /DUNICODE /D_UNICODE $source "/Fo$object" "/Fe$target" /link /DYNAMICBASE /NXCOMPAT
if ($LASTEXITCODE -ne 0) { throw 'Сборка Windows Job Objects helper завершилась ошибкой.' }
Remove-Item -Force $object
@{ file = 'bin/neurocenter-job.exe'; sha256 = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
