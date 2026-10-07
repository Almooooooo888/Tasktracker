import test from 'node:test';
import assert from 'node:assert/strict';
process.env.LK_EXCHANGE_DOMAIN='example.com';
process.env.LK_EXCHANGE_AUTODISCOVER_URL='https://autodiscover.example.com/autodiscover/autodiscover.xml';
const {calendarRange, exchangeConfiguration, validateEwsUrl, validateLogin, validateCalendarMailbox, validateCalendarItemId, availabilityRequest, normalizeAvailability}=await import('./calendar.mjs');

test('calendar month range crosses year boundary', () => {
  assert.deepEqual(calendarRange('2026-12'), {
    start:'2026-12-01T00:00:00+03:00',
    end:'2027-01-01T00:00:00+03:00'
  });
  assert.throws(() => calendarRange('2026-13'));
});

test('Exchange endpoints stay under the configured HTTPS domain', () => {
  const {domain,autodiscoverUrl}=exchangeConfiguration();
  assert.equal(new URL(autodiscoverUrl).protocol,'https:');
  assert.equal(validateEwsUrl(`https://mail.${domain}/EWS/Exchange.asmx`),`https://mail.${domain}/EWS/Exchange.asmx`);
  for (const url of [
    `http://mail.${domain}/EWS/Exchange.asmx`,
    `https://mail.${domain}.evil.example/EWS/Exchange.asmx`,
    `https://mail.${domain}:444/EWS/Exchange.asmx`,
    `https://mail.${domain}/other`,
    `https://mail.${domain}/EWS/Exchange.asmx?redirect=1`
  ]) assert.throws(() => validateEwsUrl(url));
});

test('calendar login requires a mailbox, login and password', () => {
  assert.deepEqual(validateLogin({email:' user@example.com ',username:'DOMAIN\\user',password:'secret'}),{
    email:'user@example.com',username:'DOMAIN\\user',password:'secret'
  });
  assert.throws(() => validateLogin({email:'bad',username:'user',password:'secret'}));
  assert.throws(() => validateLogin({email:'user@example.com',username:'user\nadmin',password:'secret'}));
});

test('shared calendar mailbox and meeting id are validated before EWS requests', () => {
  assert.equal(validateCalendarMailbox(' colleague@example.com '),'colleague@example.com');
  for(const address of ['bad','person@example.com<xml>','person@example.com\n'])assert.throws(()=>validateCalendarMailbox(address));
  assert.equal(validateCalendarItemId('AAMkAAAB=='),'AAMkAAAB==');
  for(const id of ['short','<ItemId/>','a'.repeat(1025)])assert.throws(()=>validateCalendarItemId(id));
});

test('availability accepts a bounded day and distinct mailbox list', () => {
  const request=availabilityRequest('2026-10-07',['A@example.com','b@example.com']);
  assert.deepEqual(request,{date:'2026-10-07',mailboxes:['a@example.com','b@example.com'],start:'2026-10-07T09:00:00',end:'2026-10-07T19:00:00',intervalMinutes:30});
  for(const date of ['2026-02-30','2026-13-01','2026-10-7'])assert.throws(()=>availabilityRequest(date,['a@example.com']));
  assert.throws(()=>availabilityRequest('2026-10-07',[]));
  assert.throws(()=>availabilityRequest('2026-10-07',['A@example.com','a@example.com']));
  assert.throws(()=>availabilityRequest('2026-10-07',['bad@example.com<xml>']));
  assert.throws(()=>availabilityRequest('2026-10-07',Array.from({length:9},(_,i)=>`user${i}@example.com`)));
});

test('availability never treats missing or malformed free/busy data as free', () => {
  const request=availabilityRequest('2026-10-07',['a@example.com','b@example.com']);
  const response=normalizeAvailability(request,{rows:[{merged:'0011223344'.repeat(2),error:false},{merged:'000',error:false}]});
  assert.deepEqual(response.rows[0].slots.slice(0,5),[0,0,1,1,2]);
  assert.deepEqual(response.rows[1],{email:'b@example.com',slots:[],error:'Занятость недоступна или не опубликована.'});
  assert.throws(()=>normalizeAvailability(request,{rows:[{merged:'0'.repeat(20)}]}));
});
