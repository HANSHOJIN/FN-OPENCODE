param([string]$Version='1.19.0',[string]$Architecture='x86_64',[int]$Revision=10,[string]$Python='python')
$ErrorActionPreference='Stop'
& $Python (Join-Path $PSScriptRoot 'build.py') $Version $Architecture --revision $Revision
if ($LASTEXITCODE -ne 0) { throw 'FPK build failed' }
