$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $envText = [IO.File]::ReadAllText($envPath)
    if ($envText -match '(?m)^TASKBOARD_IMAGE=almooooooo/taskboard:(\d+\.\d+\.\d+)[ \t]*$' -and [version]$Matches[1] -lt [version]'1.27.7') {
        $envText = [regex]::Replace($envText, '(?m)^TASKBOARD_IMAGE=almooooooo/taskboard:\d+\.\d+\.\d+[ \t]*$', 'TASKBOARD_IMAGE=almooooooo/taskboard:1.27.7')
        [IO.File]::WriteAllText($envPath, $envText, [Text.UTF8Encoding]::new($false))
    }
}
$ErrorActionPreference = 'Continue'
& docker compose -f (Join-Path $PSScriptRoot 'compose.hub.yaml') up -d
$composeCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($composeCode -ne 0) { throw 'Не удалось запустить Docker-версию Taskboard.' }
$startupDirectory = [Environment]::GetFolderPath('Startup')
if ($startupDirectory) {
    $legacyShortcut = Join-Path $startupDirectory 'Taskboard Docker Updater.lnk'
    if (Test-Path -LiteralPath $legacyShortcut -PathType Leaf) { Remove-Item -LiteralPath $legacyShortcut -Force }
}
for ($attempt=0; $attempt -lt 20; $attempt++) {
    try { if ((Invoke-RestMethod 'http://127.0.0.1:18764/health' -TimeoutSec 1).app -eq 'jira-board') { break } } catch {}
    Start-Sleep -Milliseconds 500
}
Start-Process 'http://127.0.0.1:18764/'
