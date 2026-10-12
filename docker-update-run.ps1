param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference = 'Stop'
$composePath = Join-Path $PSScriptRoot 'compose.hub.yaml'
$envPath = Join-Path $PSScriptRoot '.env'
$stateDir = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board'
$stateFile = Join-Path $stateDir 'docker-update-status.json'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
function Set-UpdateState([string]$stage, [string]$message) {
    $json = @{ stage=$stage; message=$message; checkedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($stateFile, $json, [Text.UTF8Encoding]::new($false))
}
function Invoke-DockerCompose([string[]]$arguments) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & docker compose -f $composePath @arguments *> $null; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { throw 'Docker Compose не смог выполнить обновление.' }
}
$previousEnv = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { $null }
$previousImage = $env:TASKBOARD_IMAGE
$changed = $false
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI не найден.' }
    if ($previousImage) { throw 'TASKBOARD_IMAGE задан в окружении Windows. Убери переменную, чтобы версия сохранялась в .env.' }
    $current = Invoke-RestMethod 'http://127.0.0.1:18764/api/config' -TimeoutSec 3
    if ([version]$Version -le [version]$current.version) { throw 'Эта версия уже установлена или старше текущей.' }
    Set-UpdateState 'running' 'Проверяю образ в Docker Hub.'
    $tag = Invoke-RestMethod -Uri "https://hub.docker.com/v2/repositories/almooooooo/taskboard/tags/$Version" -TimeoutSec 15
    if ($tag.name -ne $Version) { throw 'Версия не найдена в Docker Hub.' }
    $image = "almooooooo/taskboard:$Version"
    $newEnv = if ($null -eq $previousEnv) { '' } else { $previousEnv }
    if ($newEnv -match '(?m)^TASKBOARD_IMAGE=') {
        $newEnv = [regex]::Replace($newEnv, '(?m)^TASKBOARD_IMAGE=.*$', "TASKBOARD_IMAGE=$image")
    } else {
        if ($newEnv.Length -gt 0 -and -not $newEnv.EndsWith("`n")) { $newEnv += "`r`n" }
        $newEnv += "TASKBOARD_IMAGE=$image`r`n"
    }
    $env:TASKBOARD_IMAGE = $image
    Set-UpdateState 'running' 'Загружаю Docker-образ.'
    Invoke-DockerCompose -arguments @('pull', 'jira-board')
    [IO.File]::WriteAllText($envPath, $newEnv, [Text.UTF8Encoding]::new($false))
    $changed = $true
    Set-UpdateState 'running' 'Перезапускаю Taskboard.'
    Invoke-DockerCompose -arguments @('up', '-d', '--no-deps', 'jira-board')
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $config = Invoke-RestMethod 'http://127.0.0.1:18764/api/config' -TimeoutSec 2
            if ($config.version -eq $Version) { $ready = $true; break }
        } catch {}
    }
    if (-not $ready) { throw 'Новая версия не ответила после запуска.' }
    Set-UpdateState 'done' "Установлена версия $Version. Перезагрузи страницу."
} catch {
    $message = $_.Exception.Message
    if ($changed) {
        try {
            if ($null -eq $previousEnv) { Remove-Item -LiteralPath $envPath -ErrorAction Stop }
            else { [IO.File]::WriteAllText($envPath, $previousEnv, [Text.UTF8Encoding]::new($false)) }
            if ($null -eq $previousImage) { Remove-Item Env:\TASKBOARD_IMAGE -ErrorAction SilentlyContinue }
            else { $env:TASKBOARD_IMAGE = $previousImage }
            Invoke-DockerCompose -arguments @('up', '-d', '--no-deps', 'jira-board')
            $message += ' Предыдущий контейнер восстановлен.'
        } catch { $message += ' Откат контейнера не удался.' }
    }
    Set-UpdateState 'error' $message
    exit 1
}
