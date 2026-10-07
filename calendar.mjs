import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

let localSettings = {};
try { localSettings = JSON.parse(readFileSync(new URL('./diagnostics.local.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const exchangeDomain = String(process.env.LK_EXCHANGE_DOMAIN || localSettings.exchangeDomain || '').toLowerCase();
const autodiscoverUrl = String(process.env.LK_EXCHANGE_AUTODISCOVER_URL || localSettings.exchangeAutodiscoverUrl || '');

function isAllowedHost(host) { return host === exchangeDomain || host.endsWith('.' + exchangeDomain); }

export function exchangeConfiguration() {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(exchangeDomain) || !autodiscoverUrl) throw new Error('Адрес Exchange не настроен на этом компьютере.');
  let url;
  try { url = new URL(autodiscoverUrl); } catch { throw new Error('Некорректный адрес Autodiscover в локальной конфигурации.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !isAllowedHost(url.hostname.toLowerCase()) ||
      !/^\/autodiscover\/autodiscover\.xml\/?$/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('Адрес Autodiscover вне разрешённого домена Exchange.');
  }
  return {domain:exchangeDomain,autodiscoverUrl:url.toString()};
}

const exchangeErrors = {
  AuthFailed: 'Exchange не принял логин или пароль либо не разрешил доступ к календарю.',
  NoEwsUrl: 'Autodiscover не вернул адрес службы календаря EWS.',
  CalendarRejected: 'Exchange отклонил чтение календаря. Проверь права доступа к почтовому ящику.',
  AvailabilityRejected: 'Exchange не ответил данными о занятости. Проверь доступность службы Free/Busy.',
  ExchangeUnavailable: 'Не удалось подключиться к Exchange. Проверь сеть, адрес и сертификат.'
};

export function validateEwsUrl(value) {
  exchangeConfiguration();
  let url;
  try { url = new URL(value); } catch { throw new Error('Autodiscover вернул некорректный адрес EWS.'); }
  const host=url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !isAllowedHost(host) ||
      !/^\/ews\/exchange\.asmx\/?$/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('Адрес EWS находится вне разрешённого домена Exchange. Нужна проверка администратора.');
  }
  return url.toString();
}

export function calendarRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Некорректный месяц календаря.');
  const [year, number]=month.split('-').map(Number);
  if (year < 2020 || year > 2100) throw new Error('Месяц вне допустимого диапазона.');
  const next=new Date(Date.UTC(year,number,1));
  const nextMonth=`${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,'0')}`;
  return {start:`${month}-01T00:00:00+03:00`,end:`${nextMonth}-01T00:00:00+03:00`};
}

export function validateLogin({email,username,password}) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.trim())) throw new Error('Укажи адрес почтового ящика.');
  if (typeof username !== 'string' || !username.trim() || username.length > 180 || /[\r\n\x00-\x1f]/.test(username)) throw new Error('Укажи корпоративный логин.');
  if (typeof password !== 'string' || !password || password.length > 8000) throw new Error('Укажи пароль от почты.');
  return {email:email.trim(),username:username.trim(),password};
}

export function validateCalendarMailbox(email) {
  if (typeof email !== 'string' || email.length > 254 || /[\r\n\x00-\x1f]/.test(email) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.trim())) throw new Error('Некорректный адрес календаря участника.');
  return email.trim();
}

export function validateCalendarItemId(id) {
  if (typeof id !== 'string' || id.length < 8 || id.length > 1024 || !/^[A-Za-z0-9+/=_-]+$/.test(id)) throw new Error('Некорректный идентификатор встречи.');
  return id;
}

export function availabilityRequest(date,mailboxes) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Укажи дату для проверки занятости.');
  const [year,month,day]=date.split('-').map(Number),actual=new Date(Date.UTC(year,month-1,day));
  if(year<2020||year>2100||actual.getUTCFullYear()!==year||actual.getUTCMonth()!==month-1||actual.getUTCDate()!==day)throw new Error('Некорректная дата проверки занятости.');
  if(!Array.isArray(mailboxes)||mailboxes.length<1||mailboxes.length>8)throw new Error('Укажи от 1 до 8 адресов коллег.');
  const unique=[...new Set(mailboxes.map(value=>validateCalendarMailbox(value).toLowerCase()))];
  if(unique.length!==mailboxes.length)throw new Error('Удали повторяющиеся адреса коллег.');
  return {date,mailboxes:unique,start:`${date}T09:00:00`,end:`${date}T19:00:00`,intervalMinutes:30};
}

export function normalizeAvailability(request,result) {
  if(!Array.isArray(result.rows)||result.rows.length!==request.mailboxes.length)throw new Error('Exchange вернул неполный ответ о занятости.');
  return {date:request.date,intervalMinutes:request.intervalMinutes,startHour:9,rows:result.rows.map((row,index)=>{
    const email=request.mailboxes[index],merged=typeof row.merged==='string'?row.merged:'';
    if(row.error||merged.length!==20||/[^01234]/.test(merged))return {email,slots:[],error:'Занятость недоступна или не опубликована.'};
    return {email,slots:[...merged].map(Number),error:null};
  }),checkedAt:new Date().toISOString()};
}

export async function exchangeRequest(input) {
  if (process.platform !== 'win32') throw new Error('Календарь Exchange пока доступен только в локальном Windows-запуске.');
  const script=fileURLToPath(new URL('./calendar-exchange.ps1',import.meta.url));
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.PSModulePath;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
    let output='',settled=false;
    const fail=error=>{if(!settled){settled=true;reject(error)}};
    const timer=setTimeout(()=>{child.kill();fail(new Error('Exchange не ответил за 45 секунд.'))},45000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill();fail(new Error('Exchange вернул слишком большой ответ.'))}});
    child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);fail(new Error('Не удалось запустить модуль календаря.'))});
    child.on('close',code=>{
      clearTimeout(timer);if(settled)return;
      let result;try{result=JSON.parse(output.trim())}catch{return fail(new Error('Некорректный ответ модуля календаря.'))}
      if(code!==0||result.error)return fail(new Error(exchangeErrors[result.error]||exchangeErrors.ExchangeUnavailable));
      settled=true;resolve(result);
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  });
}

export async function discoverCalendar(login) {
  const {autodiscoverUrl:uri}=exchangeConfiguration();
  const result=await exchangeRequest({operation:'discover',...login,autodiscoverUrl:uri});
  return validateEwsUrl(result.ewsUrl);
}

export async function readCalendar(session,month,mailbox=session.email) {
  const range=calendarRange(month);
  mailbox=validateCalendarMailbox(mailbox);
  const result=await exchangeRequest({operation:'events',...session,...range,mailbox});
  if(!Array.isArray(result.events))throw new Error('Exchange вернул некорректный список событий.');
  return {month,mailbox,events:result.events,limited:Boolean(result.limited),checkedAt:new Date().toISOString()};
}

export async function readCalendarAttendees(session,id) {
  const result=await exchangeRequest({operation:'attendees',...session,itemId:validateCalendarItemId(id)});
  if(!Array.isArray(result.attendees))throw new Error('Exchange вернул некорректный состав встречи.');
  return {itemId:id,organizer:result.organizer||null,attendees:result.attendees};
}

export async function readAvailability(session,date,mailboxes) {
  const request=availabilityRequest(date,mailboxes);
  const result=await exchangeRequest({operation:'availability',...session,...request});
  return normalizeAvailability(request,result);
}
