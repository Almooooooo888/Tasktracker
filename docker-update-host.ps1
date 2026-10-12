param()
$ErrorActionPreference = 'Stop'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 18765)
$listener.Start()
$stateFile = Join-Path $env:LOCALAPPDATA 'LK-Jira-Board\docker-update-status.json'
$updateProcess = $null
function Send-Json($stream, [int]$code, $body, [string]$origin = '', [bool]$preflight = $false) {
    $status = switch ($code) { 200 {'OK'} 202 {'Accepted'} 204 {'No Content'} 400 {'Bad Request'} 403 {'Forbidden'} 404 {'Not Found'} 409 {'Conflict'} default {'Internal Server Error'} }
    $payload = if ($preflight) { '' } else { $body | ConvertTo-Json -Compress -Depth 4 }
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $headers = "HTTP/1.1 $code $status`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n"
    if ($origin -in @('http://127.0.0.1:18764', 'http://localhost:18764')) {
        $headers += "Access-Control-Allow-Origin: $origin`r`nVary: Origin`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`n"
    }
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers + "`r`n")
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($bytes.Length) { $stream.Write($bytes, 0, $bytes.Length) }
    $stream.Flush()
}
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 3000
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 1024, $true)
            $first = $reader.ReadLine()
            if ($first -notmatch '^(GET|POST|OPTIONS) (/health|/status|/install) HTTP/1\.[01]$') { Send-Json $stream 404 @{error='Не найдено.'}; continue }
            $method = $Matches[1]; $route = $Matches[2]
            $headers = @{}
            for ($i=0; $i -lt 40; $i++) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line -eq '') { break }
                $colon = $line.IndexOf(':')
                if ($colon -gt 0) { $headers[$line.Substring(0,$colon).ToLowerInvariant()] = $line.Substring($colon+1).Trim() }
            }
            $origin = [string]$headers['origin']
            if ($headers['host'] -ne '127.0.0.1:18765') { Send-Json $stream 403 @{error='Некорректный адрес.'}; continue }
            if ($method -eq 'OPTIONS' -and $origin -in @('http://127.0.0.1:18764', 'http://localhost:18764')) { Send-Json $stream 204 @{} $origin $true; continue }
            if ($route -eq '/health' -and $method -eq 'GET') { Send-Json $stream 200 @{app='taskboard-docker-updater'} $origin; continue }
            if ($origin -notin @('http://127.0.0.1:18764', 'http://localhost:18764')) { Send-Json $stream 403 @{error='Запрос не из Taskboard.'}; continue }
            if ($route -eq '/status' -and $method -eq 'GET') {
                $state = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } else { @{stage='idle'} }
                Send-Json $stream 200 $state $origin; continue
            }
            if ($route -eq '/install' -and $method -eq 'POST') {
                if ($updateProcess -and -not $updateProcess.HasExited) { Send-Json $stream 409 @{error='Обновление уже выполняется.'} $origin; continue }
                $length = 0
                if (-not [int]::TryParse([string]$headers['content-length'], [ref]$length) -or $length -lt 1 -or $length -gt 512 -or $headers['content-type'] -notlike 'application/json*') {
                    Send-Json $stream 400 @{error='Некорректный запрос.'} $origin; continue
                }
                $chars = [char[]]::new($length)
                $count = $reader.ReadBlock($chars, 0, $length)
                if ($count -ne $length) { Send-Json $stream 400 @{error='Запрос передан не полностью.'} $origin; continue }
                $inputData = ([string]::new($chars) | ConvertFrom-Json)
                $version = [string]$inputData.version
                if ($version -notmatch '^\d+\.\d+\.\d+$') { Send-Json $stream 400 @{error='Некорректная версия.'} $origin; continue }
                $script = Join-Path $PSScriptRoot 'docker-update-run.ps1'
                $updateProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-Version',$version) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
                Send-Json $stream 202 @{message='Обновление Docker запущено.'} $origin; continue
            }
            Send-Json $stream 404 @{error='Не найдено.'} $origin
        } catch {
            try { Send-Json $stream 500 @{error='Помощник обновления не смог обработать запрос.'} $origin } catch {}
        } finally { $client.Close() }
    }
} finally { $listener.Stop() }
