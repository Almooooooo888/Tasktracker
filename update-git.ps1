param()
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$safeRepo = $repo.Replace('\', '/')
$stateDir = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board'
$stateFile = Join-Path $stateDir 'update-status.json'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
function Set-UpdateState([string]$stage, [string]$message) {
    $json = @{ stage = $stage; message = $message; checkedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($stateFile, $json, [Text.UTF8Encoding]::new($false))
}
function Invoke-Git([string[]]$arguments) {
    $result = & git -c "safe.directory=$safeRepo" @arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Git не смог выполнить обновление.' }
    return ($result | Out-String).Trim()
}
$oldCommit = $null
$merged = $false
try {
    Set-UpdateState 'running' 'Проверяю локальную папку.'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git не установлен.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm не установлен.' }
    if ((Invoke-Git -arguments @('branch', '--show-current')) -ne 'main') { throw 'Автообновление поддерживает только ветку main.' }
    if (Invoke-Git -arguments @('status', '--porcelain')) { throw 'В папке есть локальные изменения. Сохрани их перед обновлением.' }
    $oldCommit = Invoke-Git -arguments @('rev-parse', 'HEAD')
    $env:GIT_TERMINAL_PROMPT = '0'
    Set-UpdateState 'running' 'Загружаю обновление из GitHub.'
    Invoke-Git -arguments @('fetch', '--no-tags', 'origin', 'main') | Out-Null
    $target = Invoke-Git -arguments @('rev-parse', 'FETCH_HEAD')
    if ($target -eq $oldCommit) { Set-UpdateState 'done' 'Уже установлена последняя версия.'; exit 0 }
    & git -c "safe.directory=$safeRepo" merge-base --is-ancestor $oldCommit $target 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Ветка разошлась с GitHub. Автоматическое обновление остановлено.' }
    Set-UpdateState 'running' 'Устанавливаю новую версию.'
    Invoke-Git -arguments @('merge', '--ff-only', $target) | Out-Null
    $merged = $true
    & npm.cmd ci --omit=dev --ignore-scripts *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости новой версии.' }
    & (Join-Path $repo 'start.ps1') -Restart -Background
    if (-not $?) { throw 'Новая версия не запустилась.' }
    Set-UpdateState 'done' 'Обновление установлено. Перезагрузи страницу.'
} catch {
    $message = $_.Exception.Message
    if ($merged -and $oldCommit -and -not (Invoke-Git -arguments @('status', '--porcelain'))) {
        try {
            Invoke-Git -arguments @('reset', '--hard', $oldCommit) | Out-Null
            & npm.cmd ci --omit=dev --ignore-scripts *> $null
            & (Join-Path $repo 'start.ps1') -Restart -Background
            $message += ' Предыдущая версия восстановлена.'
        } catch { $message += ' Автоматический откат не удался — запусти Start.cmd вручную.' }
    }
    Set-UpdateState 'error' $message
    exit 1
}
