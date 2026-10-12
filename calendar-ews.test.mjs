import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangePayload, parseExchangeResponse, exchangeRequestLinux } from './calendar-ews.mjs';

const wrap = content => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><soap:Body>${content}</soap:Body></soap:Envelope>`;

test('Linux Exchange client escapes request values and does not expose credentials in XML', () => {
  const request = exchangePayload({ operation: 'discover', email: 'a&b@example.com', username: 'user', password: 'secret' });
  assert.match(request.body, /a&amp;b@example\.com/);
  assert.doesNotMatch(request.body, /secret|username/);
  const events = exchangePayload({ operation: 'events', email: 'me@example.com', mailbox: 'other@example.com', start: '2026-10-01T00:00:00+03:00', end: '2026-11-01T00:00:00+03:00' });
  assert.match(events.body, /<t:Mailbox><t:EmailAddress>other@example\.com/);
  assert.equal(events.action, 'FindItem');
});

test('Linux Exchange client parses Autodiscover and calendar events', () => {
  assert.deepEqual(parseExchangeResponse('discover', '<Autodiscover><Response><Account><Protocol><EwsUrl>https://mail.example.com/EWS/Exchange.asmx</EwsUrl></Protocol></Account></Response></Autodiscover>'), { ewsUrl: 'https://mail.example.com/EWS/Exchange.asmx' });
  const xml = wrap('<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder><t:Items><t:CalendarItem><t:ItemId Id="AAMkAAAB=="/><t:Subject>Статус ЛК &amp; QA</t:Subject><t:Start>2026-10-12T11:30:00+03:00</t:Start><t:End>2026-10-12T12:00:00+03:00</t:End><t:Location>Переговорная</t:Location><t:IsAllDayEvent>false</t:IsAllDayEvent></t:CalendarItem></t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>');
  assert.deepEqual(parseExchangeResponse('events', xml), { events: [{ id: 'AAMkAAAB==', subject: 'Статус ЛК & QA', start: '2026-10-12T11:30:00+03:00', end: '2026-10-12T12:00:00+03:00', location: 'Переговорная', isAllDay: false }], limited: false });
});

test('Linux Exchange client parses attendees and free/busy without treating missing data as free', () => {
  const attendees = wrap('<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:CalendarItem><t:Organizer><t:Mailbox><t:Name>Организатор</t:Name><t:EmailAddress>owner@example.com</t:EmailAddress></t:Mailbox></t:Organizer><t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Коллега</t:Name><t:EmailAddress>person@example.com</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType></t:Attendee></t:RequiredAttendees></t:CalendarItem></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>');
  assert.deepEqual(parseExchangeResponse('attendees', attendees), { organizer: { name: 'Организатор', email: 'owner@example.com' }, attendees: [{ name: 'Коллега', email: 'person@example.com', type: 'required', response: 'Accept' }] });
  const availability = wrap('<m:GetUserAvailabilityResponse><m:FreeBusyResponseArray><m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage><m:FreeBusyView><t:MergedFreeBusy>00001111222233334444</t:MergedFreeBusy></m:FreeBusyView></m:FreeBusyResponse></m:FreeBusyResponseArray></m:GetUserAvailabilityResponse>');
  assert.deepEqual(parseExchangeResponse('availability', availability, 2), { rows: [{ merged: '00001111222233334444', error: false }, { merged: '', error: true }] });
});

test('Linux Exchange client rejects DTD, malformed and failed responses', () => {
  assert.throws(() => parseExchangeResponse('discover', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'));
  assert.throws(() => parseExchangeResponse('events', '<bad>'));
  assert.throws(() => parseExchangeResponse('events', wrap('<m:FindItemResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorAccessDenied</m:ResponseCode></m:FindItemResponseMessage>')));
});

test('Linux Exchange client sends credentials only to the configured HTTPS endpoint', async () => {
  const input = { operation: 'discover', email: 'me@example.com', username: 'DOMAIN\\me', password: 'test-password', autodiscoverUrl: 'https://autodiscover.example.com/autodiscover/autodiscover.xml' };
  let requested;
  const result = await exchangeRequestLinux(input, async (url, options) => {
    requested = { url, options };
    return new Response('<Autodiscover><Response><Account><Protocol><EwsUrl>https://mail.example.com/EWS/Exchange.asmx</EwsUrl></Protocol></Account></Response></Autodiscover>', { status: 200 });
  });
  assert.equal(requested.url, input.autodiscoverUrl);
  assert.equal(requested.options.redirect, 'error');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.headers.Authorization, 'Basic ' + Buffer.from('DOMAIN\\me:test-password').toString('base64'));
  assert.doesNotMatch(requested.options.body, /test-password/);
  assert.equal(result.ewsUrl, 'https://mail.example.com/EWS/Exchange.asmx');
  await assert.rejects(exchangeRequestLinux(input, async () => new Response('', { status: 401 })), /логин или пароль/);
});
