param(
    [Parameter(Mandatory=$true)][string]$InputFile,
    [Parameter(Mandatory=$true)][string]$ResultFile
)
$ErrorActionPreference = 'Stop'
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$utf8 = [Text.UTF8Encoding]::new($false)
$backup = $null
try {
    $request = [IO.File]::ReadAllText($InputFile, $utf8) | ConvertFrom-Json
    if ($request.content.Length -gt 65536 -or $request.expectedHash -notmatch '^[0-9a-f]{64}$') { throw 'Некорректный запрос на изменение hosts.' }
    $current = [IO.File]::ReadAllText($hostsFile, $utf8)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = -join ($sha.ComputeHash($utf8.GetBytes($current)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
    if ($actualHash -ne $request.expectedHash) { throw 'Файл hosts уже изменился. Обнови вкладку и повтори сохранение.' }
    $backup = Join-Path (Split-Path -Parent $ResultFile) ('hosts-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt')
    [IO.File]::Copy($hostsFile, $backup, $false)
    try { [IO.File]::WriteAllText($hostsFile, [string]$request.content, $utf8) }
    catch {
        [IO.File]::Copy($backup, $hostsFile, $true)
        throw
    }
    & ipconfig.exe /flushdns *> $null
    $result = @{ok=$true}
} catch {
    $result = @{ok=$false;error=$_.Exception.Message}
}
[IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress), $utf8)
