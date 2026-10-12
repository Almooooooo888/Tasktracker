param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Taskboard')
)

$ErrorActionPreference = 'Stop'
$image = 'almooooooo/taskboard:1.27.6'
$composeUrl = 'https://raw.githubusercontent.com/Almooooooo888/Tasktracker/main/compose.hub.yaml'
$project = 'taskboard'
$appUrl = 'http://127.0.0.1:18764/'

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker завершился с кодом ${LASTEXITCODE}: docker $($args -join ' ')" }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Установите и запустите Docker Desktop, затем повторите установку.' }
& docker info --format '{{.OSType}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop не запущен или недоступен.' }
$osType = & docker info --format '{{.OSType}}'
if ($osType -ne 'linux') { throw 'Переключите Docker Desktop на Linux containers.' }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Нужен Docker Compose (входит в Docker Desktop). Обновите Docker Desktop.' }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$composePath = Join-Path $InstallDirectory 'compose.hub.yaml'
$downloadPath = Join-Path $InstallDirectory 'compose.hub.yaml.download'
try {
    Invoke-WebRequest -Uri $composeUrl -OutFile $downloadPath -UseBasicParsing
    $composeText = [IO.File]::ReadAllText($downloadPath)
    if ($composeText -notmatch '(?m)^  jira-board:' -or $composeText -notmatch '(?m)^  docker-updater:') {
        throw 'Загруженный Compose-файл не содержит оба компонента Taskboard.'
    }
    Move-Item -LiteralPath $downloadPath -Destination $composePath -Force
} finally {
    if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath -Force }
}

$envPath = Join-Path $InstallDirectory '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    $initialEnv = @(
        "TASKBOARD_IMAGE=$image"
        'TASKBOARD_PROJECT=taskboard'
        'LK_JIRA_BASE_URL=https://dp-dev-develop-01.dev.lan'
        'LK_JIRA_TLS_SKIP_VERIFY=true'
        'LK_GITLAB_BASE_URL=https://ahcode-01.digital.achrf.ru'
    ) -join "`n"
    [IO.File]::WriteAllText($envPath, "$initialEnv`n", [Text.UTF8Encoding]::new($false))
} else {
    $envText = [IO.File]::ReadAllText($envPath)
    if ($envText -match '(?m)^TASKBOARD_IMAGE=almooooooo/taskboard:(\d+\.\d+\.\d+)[ \t]*$') {
        if ([version]$Matches[1] -lt [version]'1.27.6') {
            $envText = [regex]::Replace($envText, '(?m)^TASKBOARD_IMAGE=almooooooo/taskboard:\d+\.\d+\.\d+[ \t]*$', "TASKBOARD_IMAGE=$image")
            [IO.File]::WriteAllText($envPath, $envText, [Text.UTF8Encoding]::new($false))
        }
    } else {
        Add-Content -LiteralPath $envPath -Value "TASKBOARD_IMAGE=$image" -Encoding UTF8
    }
    if ($envText -notmatch '(?m)^TASKBOARD_PROJECT=') {
        Add-Content -LiteralPath $envPath -Value 'TASKBOARD_PROJECT=taskboard' -Encoding UTF8
    }
}

Push-Location $InstallDirectory
try {
    & docker compose -p $project -f $composePath config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить конфигурацию Compose.' }
    Invoke-Docker pull $image

    $oldIds = @(& docker ps -a --format '{{.ID}}|{{.Image}}' |
        Where-Object { $_ -match '^[a-f0-9]+\|almooooooo/taskboard(?::|@|$)' } |
        ForEach-Object { ($_ -split '\|', 2)[0] } |
        Where-Object {
            $id = $_
            $composeLabel = & docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $id 2>$null
            $bindings = & docker inspect --format '{{json .HostConfig.PortBindings}}' $id | ConvertFrom-Json
            -not $composeLabel -and $bindings.'18764/tcp' -and @($bindings.'18764/tcp' | Where-Object { $_.HostPort -eq '18764' }).Count -gt 0
        })
    if ($oldIds.Count -gt 1) { throw 'Найдено несколько прежних контейнеров Taskboard. Для безопасного переноса нужен один; остановите лишние вручную.' }
    $oldId = if ($oldIds.Count -eq 1) { $oldIds[0] } else { $null }
    $oldWasRunning = $false
    $newAppId = & docker compose -p $project -f $composePath ps -q jira-board
    if ($oldId -and -not $newAppId) {
        $oldWasRunning = (& docker inspect --format '{{.State.Running}}' $oldId) -eq 'true'
        if ($oldWasRunning) { Invoke-Docker stop $oldId | Out-Null }
        $profileVolume = 'taskboard_profile'
        Invoke-Docker volume create $profileVolume | Out-Null
        $helperName = "taskboard-profile-migrate-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
        try {
            Invoke-Docker run -d --rm --name $helperName --user 0:0 -v "${profileVolume}:/data" --entrypoint sh $image -c 'sleep 300' | Out-Null
            & docker exec $helperName test -f /data/profile.json *> $null
            $profileExists = $LASTEXITCODE -eq 0
            if (-not $profileExists) {
                & docker cp "${oldId}:/data/profile.json" - *> $null
                if ($LASTEXITCODE -eq 0) {
                    # cmd preserves the binary tar stream; Windows PowerShell 5.1 does not.
                    & cmd.exe /d /s /c "docker cp ${oldId}:/data/. - | docker cp - ${helperName}:/data"
                    if ($LASTEXITCODE -ne 0) { throw 'Не удалось перенести профиль из прежнего контейнера.' }
                    Invoke-Docker exec $helperName test -f /data/profile.json
                    Invoke-Docker exec $helperName chown -R node:node /data
                    Write-Host 'Сохранённый профиль перенесён в новую установку.'
                } else {
                    Write-Host 'В прежнем контейнере нет сохранённого профиля; вход потребуется настроить заново.'
                }
            }
        } finally {
            & docker stop $helperName *> $null
        }
    }

    try {
        Invoke-Docker compose -p $project -f $composePath up -d
        $healthy = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            try {
                $response = Invoke-RestMethod -Uri "${appUrl}health" -TimeoutSec 2
                if ($response.app -eq 'jira-board') { $healthy = $true; break }
            } catch {}
            Start-Sleep -Seconds 1
        }
        if (-not $healthy) { throw 'Taskboard не ответил на проверку здоровья.' }
        $updaterReady = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            try {
                $updateStatus = Invoke-RestMethod -Uri "${appUrl}api/update/status" -TimeoutSec 2
                if ($updateStatus.stage) { $updaterReady = $true; break }
            } catch {}
            Start-Sleep -Seconds 1
        }
        if (-not $updaterReady) { throw 'Компонент обновления не отвечает.' }
    } catch {
        if ($oldWasRunning) {
            & docker compose -p $project -f $composePath down *> $null
            & docker start $oldId *> $null
        }
        throw
    }
    Write-Host "Taskboard установлен: $appUrl"
    Write-Host 'Следующие версии устанавливаются кнопкой «Обновление» в приложении.'
    if ($oldId) { Write-Host "Прежний контейнер сохранён для отката: $oldId" }
} finally {
    Pop-Location
}
