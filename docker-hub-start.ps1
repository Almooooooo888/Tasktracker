$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
try { $updater = Invoke-RestMethod 'http://127.0.0.1:18765/health' -TimeoutSec 2 } catch { $updater = $null }
if ($updater.app -ne 'taskboard-docker-updater') {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PSScriptRoot 'docker-update-host.ps1')+'"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
& docker compose -f (Join-Path $PSScriptRoot 'compose.hub.yaml') up -d
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить Docker-версию Taskboard.' }
for ($attempt=0; $attempt -lt 20; $attempt++) {
    try { if ((Invoke-RestMethod 'http://127.0.0.1:18764/health' -TimeoutSec 1).app -eq 'jira-board') { break } } catch {}
    Start-Sleep -Milliseconds 500
}
Start-Process 'http://127.0.0.1:18764/'
