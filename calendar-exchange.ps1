$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Read-Xml([string]$text) {
    $settings = [System.Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [System.Xml.XmlReader]::Create([IO.StringReader]::new($text), $settings)
    try {
        $document = [System.Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return $document
    } finally { $reader.Dispose() }
}

function Value-Of($node, [string]$name) {
    $child = $node.SelectSingleNode("./*[local-name()='$name']")
    if ($null -eq $child) { return '' }
    return $child.InnerText
}

function Mailbox-Of($node) {
    if ($null -eq $node) { return $null }
    $mailbox = $node.SelectSingleNode("./*[local-name()='Mailbox']")
    if ($null -eq $mailbox) { return $null }
    $email = Value-Of $mailbox 'EmailAddress'
    if (-not $email) { return $null }
    return @{ name = Value-Of $mailbox 'Name'; email = $email }
}

try {
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $secret = ConvertTo-SecureString ([string]$inputData.password) -AsPlainText -Force
    $credential = [Management.Automation.PSCredential]::new([string]$inputData.username, $secret)
    if ($inputData.operation -eq 'discover') {
        $address = [Security.SecurityElement]::Escape([string]$inputData.email)
        $body = '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>' + $address + '</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>'
        $uri = [string]$inputData.autodiscoverUrl
        $response = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'text/xml; charset=utf-8' -Body $body -Credential $credential -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20
        $xml = Read-Xml ([string]$response.Content)
        $ewsNode = $xml.SelectSingleNode("//*[local-name()='EwsUrl']")
        if ($null -eq $ewsNode) { throw 'NoEwsUrl' }
        @{ ewsUrl = $ewsNode.InnerText } | ConvertTo-Json -Compress
    } elseif ($inputData.operation -eq 'events') {
        $uri = [string]$inputData.ewsUrl
        $start = [Security.SecurityElement]::Escape([string]$inputData.start)
        $end = [Security.SecurityElement]::Escape([string]$inputData.end)
        $mailbox = [Security.SecurityElement]::Escape([string]$inputData.mailbox)
        $folder = if ([string]::Equals([string]$inputData.mailbox, [string]$inputData.email, [StringComparison]::OrdinalIgnoreCase)) { '<t:DistinguishedFolderId Id="calendar"/>' } else { '<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>' + $mailbox + '</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>' }
        $body = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body><m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:Subject"/><t:FieldURI FieldURI="calendar:Start"/><t:FieldURI FieldURI="calendar:End"/><t:FieldURI FieldURI="calendar:IsAllDayEvent"/><t:FieldURI FieldURI="calendar:Location"/></t:AdditionalProperties></m:ItemShape><m:CalendarView MaxEntriesReturned="500" StartDate="' + $start + '" EndDate="' + $end + '"/><m:ParentFolderIds>' + $folder + '</m:ParentFolderIds></m:FindItem></soap:Body></soap:Envelope>'
        $response = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'text/xml; charset=utf-8' -Body $body -Credential $credential -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20 -Headers @{ SOAPAction = 'http://schemas.microsoft.com/exchange/services/2006/messages/FindItem' }
        $xml = Read-Xml ([string]$response.Content)
        $result = $xml.SelectSingleNode("//*[local-name()='FindItemResponseMessage']")
        if ($null -eq $result -or $result.Attributes['ResponseClass'].Value -ne 'Success' -or (Value-Of $result 'ResponseCode') -ne 'NoError') { throw 'CalendarRejected' }
        $events = @($xml.SelectNodes("//*[local-name()='CalendarItem']") | ForEach-Object {
            $item = $_
            $idNode = $item.SelectSingleNode("./*[local-name()='ItemId']")
            [ordered]@{
                id = if ($idNode) { $idNode.Attributes['Id'].Value } else { '' }
                subject = Value-Of $item 'Subject'
                start = Value-Of $item 'Start'
                end = Value-Of $item 'End'
                location = Value-Of $item 'Location'
                isAllDay = (Value-Of $item 'IsAllDayEvent') -eq 'true'
            }
        })
        @{ events = $events; limited = $events.Count -ge 500 } | ConvertTo-Json -Compress -Depth 6

    } elseif ($inputData.operation -eq 'attendees') {
        $uri = [string]$inputData.ewsUrl
        $itemId = [Security.SecurityElement]::Escape([string]$inputData.itemId)
        $body = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body><m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="calendar:Organizer"/><t:FieldURI FieldURI="calendar:RequiredAttendees"/><t:FieldURI FieldURI="calendar:OptionalAttendees"/></t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="' + $itemId + '"/></m:ItemIds></m:GetItem></soap:Body></soap:Envelope>'
        $response = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'text/xml; charset=utf-8' -Body $body -Credential $credential -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20 -Headers @{ SOAPAction = 'http://schemas.microsoft.com/exchange/services/2006/messages/GetItem' }
        $xml = Read-Xml ([string]$response.Content)
        $result = $xml.SelectSingleNode("//*[local-name()='GetItemResponseMessage']")
        if ($null -eq $result -or $result.Attributes['ResponseClass'].Value -ne 'Success' -or (Value-Of $result 'ResponseCode') -ne 'NoError') { throw 'CalendarRejected' }
        $item = $result.SelectSingleNode("./*[local-name()='Items']/*[local-name()='CalendarItem']")
        if ($null -eq $item) { throw 'CalendarRejected' }
        $organizer = Mailbox-Of ($item.SelectSingleNode("./*[local-name()='Organizer']"))
        $attendees = @()
        foreach ($group in @('RequiredAttendees', 'OptionalAttendees')) {
            foreach ($entry in $item.SelectNodes("./*[local-name()='$group']/*[local-name()='Attendee']")) {
                $person = Mailbox-Of $entry
                if ($person) { $attendees += @{ name = $person.name; email = $person.email; type = if ($group -eq 'RequiredAttendees') { 'required' } else { 'optional' }; response = Value-Of $entry 'ResponseType' } }
            }
        }
        @{ organizer = $organizer; attendees = @($attendees) } | ConvertTo-Json -Compress -Depth 6
    } else { throw 'InvalidOperation' }
} catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $code = if ($status -eq 401 -or $status -eq 403) { 'AuthFailed' } elseif ($_.Exception.Message -eq 'NoEwsUrl') { 'NoEwsUrl' } elseif ($_.Exception.Message -eq 'CalendarRejected') { 'CalendarRejected' } else { 'ExchangeUnavailable' }
    @{ error = $code } | ConvertTo-Json -Compress
    exit 1
}
