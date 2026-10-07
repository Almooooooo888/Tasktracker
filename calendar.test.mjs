import test from 'node:test';
import assert from 'node:assert/strict';
process.env.LK_EXCHANGE_DOMAIN='example.com';
process.env.LK_EXCHANGE_AUTODISCOVER_URL='https://autodiscover.example.com/autodiscover/autodiscover.xml';
const {calendarRange, exchangeConfiguration, validateEwsUrl, validateLogin, validateCalendarMailbox, validateCalendarItemId}=await import('./calendar.mjs');

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
