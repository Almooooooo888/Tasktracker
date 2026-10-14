param([Parameter(Mandatory = $true)][string]$AttemptId)
$ErrorActionPreference = 'Stop'
Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue
$script = Join-Path $PSScriptRoot 'update-git.ps1'
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $script), '-AttemptId', $AttemptId)
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
