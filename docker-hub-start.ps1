$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ErrorActionPreference = 'Continue'
& docker compose -f (Join-Path $PSScriptRoot 'compose.hub.yaml') up -d
$composeCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($composeCode -ne 0) { throw 'Не удалось запустить Docker-версию Taskboard.' }
& (Join-Path $PSScriptRoot 'install-docker-updater.ps1')
for ($attempt=0; $attempt -lt 20; $attempt++) {
    try { if ((Invoke-RestMethod 'http://127.0.0.1:18764/health' -TimeoutSec 1).app -eq 'jira-board') { break } } catch {}
    Start-Sleep -Milliseconds 500
}
Start-Process 'http://127.0.0.1:18764/'
