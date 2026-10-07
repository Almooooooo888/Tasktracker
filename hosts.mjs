import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {domainToASCII} from 'node:url';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const HOSTS_PATH=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','drivers','etc','hosts'):null;
const BEGIN='# Taskboard LK BEGIN',END='# Taskboard LK END';
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const readText=async filename=>{
  try{return new TextDecoder('utf-8',{fatal:true}).decode(await readFile(filename))}
  catch(error){if(error.code)throw error;throw Error('Файл hosts не в UTF-8. Taskboard не будет менять его кодировку.')}
};

export function validateEntries(input){
  if(!Array.isArray(input)||input.length>100)throw Error('Можно сохранить не более 100 записей.');
  const seen=new Set();
  return input.map((entry,index)=>{
    const ip=String(entry?.ip||'').trim(),rawHost=String(entry?.host||'').trim().toLowerCase();
    const host=domainToASCII(rawHost);
    if(!isIP(ip))throw Error(`Строка ${index+1}: укажи корректный IPv4 или IPv6.`);
    if(!host||host!==rawHost||host.length>253||!host.split('.').every(label=>label.length>0&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw Error(`Строка ${index+1}: укажи корректное имя хоста латиницей.`);
    if(seen.has(host))throw Error(`Имя ${host} указано несколько раз.`);
    seen.add(host);return {ip,host};
  });
}

export function parseHosts(text){
  const lines=text.split(/\r?\n/),begin=lines.indexOf(BEGIN),end=lines.indexOf(END);
  if((begin<0)!==(end<0)||begin>=0&&(end<=begin||lines.lastIndexOf(BEGIN)!==begin||lines.lastIndexOf(END)!==end))throw Error('Служебный блок Taskboard в hosts повреждён. Проверь файл вручную.');
  const managed=begin<0?[]:lines.slice(begin+1,end);
  const unmanaged=begin<0?lines:[...lines.slice(0,begin),...lines.slice(end+1)];
  const parseLine=line=>{const clean=line.split('#',1)[0].trim(),parts=clean.split(/\s+/);return parts.length>=2&&isIP(parts[0])?parts.slice(1).map(host=>({ip:parts[0],host})):[]};
  const entries=managed.flatMap(parseLine),existing=unmanaged.flatMap(parseLine);
  return {begin,end,lines,entries,existing};
}

export function renderHosts(text,input){
  const entries=validateEntries(input),parsed=parseHosts(text);
  if(!entries.length&&parsed.begin<0)return text;
  for(const entry of entries){if(parsed.existing.some(item=>item.host.toLowerCase()===entry.host))throw Error(`${entry.host} уже задан вне блока Taskboard. Измени эту запись вручную или выбери другое имя.`)}
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const lines=parsed.begin<0?parsed.lines:[...parsed.lines.slice(0,parsed.begin),...parsed.lines.slice(parsed.end+1)];
  while(lines.at(-1)==='')lines.pop();
  if(entries.length)lines.push('',BEGIN,...entries.map(entry=>`${entry.ip}\t${entry.host}`),END);
  return lines.join(eol)+eol;
}

export async function readHosts(filename=HOSTS_PATH){
  if(!filename)throw Error('Редактирование системного hosts доступно только в Windows.');
  const text=await readText(filename),parsed=parseHosts(text);
  return {entries:parsed.entries,existing:parsed.existing,hash:digest(text),path:filename};
}

function runElevation(script,inputFile,resultFile){
  return new Promise((resolve,reject)=>{
    const quote=value=>`'${value.replaceAll("'","''")}'`;
    const args=[script,inputFile,resultFile].map(quote).join(',');
    const command=`$ErrorActionPreference='Stop'; $a=@(${args}); $p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$a[0]+'"'),'-InputFile',('"'+$a[1]+'"'),'-ResultFile',('"'+$a[2]+'"')) -Wait -PassThru; exit $p.ExitCode`;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(Error('Windows не завершила запрос прав за две минуты.'))},120000);
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Сохранение отклонено Windows. Нужны права администратора.'))});
  });
}

export async function saveHosts({entries,hash},{filename=HOSTS_PATH,directory,run=runElevation}={}){
  if(!filename||process.platform!=='win32')throw Error('Запись системного hosts доступна только в Windows.');
  if(!/^[0-9a-f]{64}$/.test(String(hash||'')))throw Error('Обнови список hosts перед сохранением.');
  const current=await readText(filename);
  if(digest(current)!==hash)throw Error('Файл hosts изменился после открытия вкладки. Обнови список перед сохранением.');
  const content=renderHosts(current,entries);
  if(content===current)return readHosts(filename);
  await mkdir(directory,{recursive:true});
  const id=randomBytes(12).toString('hex'),inputFile=path.join(directory,`hosts-${id}.json`),resultFile=path.join(directory,`hosts-${id}.result.json`);
  const script=fileURLToPath(new URL('./hosts-elevated.ps1',import.meta.url));
  try{
    await writeFile(inputFile,JSON.stringify({expectedHash:hash,content}),{mode:0o600,flag:'wx'});
    await run(script,inputFile,resultFile);
    const result=JSON.parse(await readFile(resultFile,'utf8'));
    if(!result.ok)throw Error(result.error||'Не удалось сохранить hosts.');
    return readHosts(filename);
  }finally{await Promise.allSettled([unlink(inputFile),unlink(resultFile)])}
}
