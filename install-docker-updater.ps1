param(
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
    [switch]$SkipLaunch
)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'docker-update-host.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Файл помощника обновления не найден.' }
if (-not $StartupDirectory) { throw 'Не удалось найти папку автозапуска Windows.' }
New-Item -ItemType Directory -Force -Path $StartupDirectory | Out-Null
$shortcutPath = Join-Path $StartupDirectory 'Taskboard Docker Updater.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $helper + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Помощник обновления Docker-версии Taskboard'
$shortcut.Save()
if ($SkipLaunch) { Write-Output $shortcutPath; return }
try { $health = Invoke-RestMethod 'http://127.0.0.1:18765/health' -TimeoutSec 2 } catch { $health = $null }
if ($health.app -ne 'taskboard-docker-updater') {
    Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
for ($attempt=0; $attempt -lt 20; $attempt++) {
    try {
        if ((Invoke-RestMethod 'http://127.0.0.1:18765/health' -TimeoutSec 1).app -eq 'taskboard-docker-updater') {
            Write-Output 'Помощник обновления установлен и запущен.'
            return
        }
    } catch {}
    Start-Sleep -Milliseconds 250
}
throw 'Помощник добавлен в автозапуск, но сейчас не ответил. Проверь порт 18765 и запусти Docker-Hub-Start.cmd повторно.'
