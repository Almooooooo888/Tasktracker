param([switch]$Background,[switch]$Restart)
$ErrorActionPreference = 'Stop'
$boardUrl = 'http://127.0.0.1:18764/'
function Get-BoardListenerProcessIds {
    $owners = @(Get-NetTCPConnection -LocalPort 18764 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -eq 0) {
        $owners = @(netstat.exe -ano -p tcp | ForEach-Object {
            $parts = $_.ToString().Trim() -split '\s+'
            if ($parts.Count -ge 5 -and $parts[1] -match ':18764$' -and $parts[3] -eq 'LISTENING') {
                [int]$parts[4]
            }
        } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    }
    return $owners
}
if ($Restart) {
    $isTaskboard = $false
    try { $isTaskboard = (Invoke-RestMethod ($boardUrl + 'health') -TimeoutSec 2).app -eq 'jira-board' } catch {}
    if ($isTaskboard) {
        $profilePath = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board\profile.dpapi'
        if (Test-Path -LiteralPath $profilePath) {
            try {
                $encryptedProfile = [System.IO.File]::ReadAllText($profilePath)
                $null = $encryptedProfile | ConvertTo-SecureString -ErrorAction Stop
            } catch {
                throw 'Не могу открыть сохранённый профиль Windows из этой учётной записи. Старая версия оставлена без изменений.'
            }
        }
        $owners = Get-BoardListenerProcessIds
        if ($owners.Count -eq 0) { throw 'Не удалось определить процесс старой версии на порту 18764.' }
        foreach ($owner in $owners) {
            Stop-Process -Id $owner -Force -ErrorAction Stop
        }
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 250
            if ((Get-BoardListenerProcessIds).Count -eq 0) { break }
        }
        if ((Get-BoardListenerProcessIds).Count -gt 0) { throw 'Не удалось освободить порт 18764 после остановки старой версии.' }
    }
}
try { $boardRunning = (Invoke-RestMethod ($boardUrl + 'health') -TimeoutSec 2).app -eq 'jira-board' } catch { $boardRunning = $false }
if (-not $boardRunning) {
    $previousTlsSkipVerify = $env:LK_JIRA_TLS_SKIP_VERIFY
    if (-not $previousTlsSkipVerify) { $env:LK_JIRA_TLS_SKIP_VERIFY = 'true' }
    $secretPath = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board\token.dpapi'
    if (-not $env:LK_JIRA_TOKEN -and (Test-Path -LiteralPath $secretPath)) {
        $secure = (Get-Content -LiteralPath $secretPath -Raw).Trim() | ConvertTo-SecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $env:LK_JIRA_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    $caPath = Join-Path $PSScriptRoot 'certs\jira-ca.pem'
    if (Test-Path -LiteralPath $caPath -PathType Leaf) { $env:NODE_EXTRA_CA_CERTS = $caPath }
    else { Remove-Item Env:\NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue }
    Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    Remove-Item Env:\LK_JIRA_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue
    if ($null -eq $previousTlsSkipVerify) { Remove-Item Env:\LK_JIRA_TLS_SKIP_VERIFY -ErrorAction SilentlyContinue }
    else { $env:LK_JIRA_TLS_SKIP_VERIFY = $previousTlsSkipVerify }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $boardRunning = (Invoke-RestMethod ($boardUrl + 'health') -TimeoutSec 1).app -eq 'jira-board' } catch { $boardRunning = $false }
        if ($boardRunning) { break }
    }
}
if (-not $boardRunning) { throw 'Taskboard не запустился. Проверь локальную папку с профилем и права Windows.' }
$config = Invoke-RestMethod ($boardUrl + 'api/config') -TimeoutSec 3
$expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($config.version -ne $expectedVersion) { throw "Запущена версия $($config.version), ожидалась $expectedVersion." }
if (-not $Background) { Start-Process $boardUrl }
