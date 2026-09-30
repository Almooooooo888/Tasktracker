$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
    if (Test-Path -LiteralPath './jira-board-1.18.0.tar') {
        docker load -i ./jira-board-1.18.0.tar
        if ($LASTEXITCODE -ne 0) { throw 'Docker image import failed' }
        docker compose up -d --no-build
    } else { docker compose up -d --build }
    if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed' }
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        try { if ((Invoke-RestMethod 'http://127.0.0.1:18764/health' -TimeoutSec 1).app -eq 'jira-board') { break } } catch {}
        Start-Sleep -Milliseconds 500
    }
    Start-Process 'http://127.0.0.1:18764/'
