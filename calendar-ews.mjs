import { XMLParser, XMLValidator } from 'fast-xml-parser';

const messageNs = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
  processEntities: true, trimValues: false, parseTagValue: false, parseAttributeValue: false });

const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const value = node => typeof node === 'string' ? node : node && typeof node === 'object' ? String(node['#text'] ?? '') : '';

function findFirst(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (Object.hasOwn(node, name)) return node[name];
  for (const child of Object.values(node)) {
    for (const entry of asArray(child)) {
      const found = findFirst(entry, name);
      if (found != null) return found;
    }
  }
  return null;
}

function envelope(body) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="${messageNs}"><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

export function exchangePayload(input) {
  if (input.operation === 'discover') {
    return { action: '', body: `<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${escapeXml(input.email)}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>` };
  }
  if (input.operation === 'events') {
    const folder = input.mailbox.toLowerCase() === input.email.toLowerCase() ? '<t:DistinguishedFolderId Id="calendar"/>' : `<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>${escapeXml(input.mailbox)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`;
    const body = `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:Subject"/><t:FieldURI FieldURI="calendar:Start"/><t:FieldURI FieldURI="calendar:End"/><t:FieldURI FieldURI="calendar:IsAllDayEvent"/><t:FieldURI FieldURI="calendar:Location"/></t:AdditionalProperties></m:ItemShape><m:CalendarView MaxEntriesReturned="500" StartDate="${escapeXml(input.start)}" EndDate="${escapeXml(input.end)}"/><m:ParentFolderIds>${folder}</m:ParentFolderIds></m:FindItem>`;
    return { action: 'FindItem', body: envelope(body) };
  }
  if (input.operation === 'attendees') {
    const body = `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="calendar:Organizer"/><t:FieldURI FieldURI="calendar:RequiredAttendees"/><t:FieldURI FieldURI="calendar:OptionalAttendees"/></t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="${escapeXml(input.itemId)}"/></m:ItemIds></m:GetItem>`;
    return { action: 'GetItem', body: envelope(body) };
  }
  if (input.operation === 'availability') {
    const mailboxes = input.mailboxes.map(email => `<t:MailboxData><t:Email><t:Address>${escapeXml(email)}</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>`).join('');
    const zone = '<t:TimeZone><t:Bias>-180</t:Bias><t:StandardTime><t:Bias>0</t:Bias><t:Time>00:00:00</t:Time><t:DayOrder>1</t:DayOrder><t:Month>1</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:StandardTime><t:DaylightTime><t:Bias>0</t:Bias><t:Time>00:00:00</t:Time><t:DayOrder>1</t:DayOrder><t:Month>7</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:DaylightTime></t:TimeZone>';
    const body = `<m:GetUserAvailabilityRequest>${zone}<m:MailboxDataArray>${mailboxes}</m:MailboxDataArray><t:FreeBusyViewOptions><t:TimeWindow><t:StartTime>${escapeXml(input.start)}</t:StartTime><t:EndTime>${escapeXml(input.end)}</t:EndTime></t:TimeWindow><t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes><t:RequestedView>FreeBusyMerged</t:RequestedView></t:FreeBusyViewOptions></m:GetUserAvailabilityRequest>`;
    return { action: 'GetUserAvailability', body: envelope(body) };
  }
  throw new Error('Неизвестная операция календаря.');
}

function mailbox(node) {
  const item = node?.Mailbox;
  if (!item?.EmailAddress) return null;
  return { name: value(item.Name), email: value(item.EmailAddress) };
}

export function parseExchangeResponse(operation, xml, count = 0) {
  if (typeof xml !== 'string' || xml.length > 4 * 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Некорректный ответ Exchange.');
  }
  const data = parser.parse(xml);
  if (operation === 'discover') {
    const ewsUrl = value(findFirst(data, 'EwsUrl'));
    if (!ewsUrl) throw new Error('Autodiscover не вернул адрес службы календаря EWS.');
    return { ewsUrl };
  }
  if (operation === 'events') {
    const message = findFirst(data, 'FindItemResponseMessage');
    if (message?.['@_ResponseClass'] !== 'Success' || value(message.ResponseCode) !== 'NoError') throw new Error('Exchange отклонил чтение календаря. Проверь права доступа к почтовому ящику.');
    const root = message.RootFolder;
    const events = asArray(root?.Items?.CalendarItem).map(item => ({ id: String(item.ItemId?.['@_Id'] || ''), subject: value(item.Subject), start: value(item.Start), end: value(item.End), location: value(item.Location), isAllDay: value(item.IsAllDayEvent) === 'true' }));
    return { events, limited: events.length >= 500 };
  }
  if (operation === 'attendees') {
    const message = findFirst(data, 'GetItemResponseMessage');
    if (message?.['@_ResponseClass'] !== 'Success' || value(message.ResponseCode) !== 'NoError') throw new Error('Exchange отклонил чтение календаря. Проверь права доступа к почтовому ящику.');
    const item = message.Items?.CalendarItem;
    if (!item) throw new Error('Exchange не вернул данные встречи.');
    const attendees = [];
    for (const [group, type] of [['RequiredAttendees', 'required'], ['OptionalAttendees', 'optional']]) {
      for (const entry of asArray(item[group]?.Attendee)) {
        const person = mailbox(entry);
        if (person) attendees.push({ ...person, type, response: value(entry.ResponseType) });
      }
    }
    return { organizer: mailbox(item.Organizer), attendees };
  }
  if (operation === 'availability') {
    const entries = asArray(findFirst(data, 'FreeBusyResponseArray')?.FreeBusyResponse);
    if (!entries.length) throw new Error('Exchange не ответил данными о занятости. Проверь доступность службы Free/Busy.');
    const rows = Array.from({ length: count }, (_, index) => {
      const entry = entries[index], message = entry?.ResponseMessage;
      const success = message?.['@_ResponseClass'] === 'Success' && value(message.ResponseCode) === 'NoError';
      return { merged: success ? value(entry.FreeBusyView?.MergedFreeBusy) : '', error: !success };
    });
    return { rows };
  }
  throw new Error('Неизвестная операция календаря.');
}

export async function exchangeRequestLinux(input, fetcher = fetch) {
  const { action, body } = exchangePayload(input);
  const uri = input.operation === 'discover' ? input.autodiscoverUrl : input.ewsUrl;
  let response;
  try {
    response = await fetcher(uri, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Basic ' + Buffer.from(`${input.username}:${input.password}`).toString('base64'), 'Content-Type': 'text/xml; charset=utf-8', ...(action ? { SOAPAction: `${messageNs}/${action}` } : {}) }, body });
  } catch { throw new Error('Не удалось подключиться к Exchange. Проверь сеть, адрес и сертификат.'); }
  if (response.status === 401 || response.status === 403) throw new Error('Exchange не принял логин или пароль либо не разрешил доступ к календарю.');
  if (!response.ok) throw new Error(`Exchange не ответил на запрос календаря (HTTP ${response.status}).`);
  const bytes = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 4 * 1024 * 1024) throw new Error('Exchange вернул слишком большой ответ.');
    bytes.push(chunk);
  }
  return parseExchangeResponse(input.operation, Buffer.concat(bytes).toString('utf8'), input.mailboxes?.length || 0);
}
