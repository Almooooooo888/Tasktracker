$ErrorActionPreference = 'Stop'
if (-not $env:LK_JIRA_TOKEN) { throw 'Jira token is missing' }
$secretDir = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board'
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$env:LK_JIRA_TOKEN | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $secretDir 'token.dpapi')
$shell = New-Object -ComObject WScript.Shell
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$scriptPath = Join-Path $PSScriptRoot 'start.ps1'
foreach ($item in @(@{ Folder = [Environment]::GetFolderPath('Desktop'); Extra = '' }, @{ Folder = [Environment]::GetFolderPath('Startup'); Extra = ' -Background' })) {
    $link = $shell.CreateShortcut((Join-Path $item.Folder 'Мои задачи.lnk'))
    $link.TargetPath = $powershellPath
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"' + $item.Extra
    $link.WorkingDirectory = $PSScriptRoot
    $link.Description = 'Задачи Jira'
    $link.Save()
}
Write-Output 'Installed: encrypted token, desktop shortcut, Windows startup shortcut.'
