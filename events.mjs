import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const ready=value=>String(value||'').trim().toUpperCase()==='READY TO TEST';
export async function scanReadyEvents(previous,{user,knownKeys=[],request,now}) {
  if(!Number.isFinite(now))throw Error('Нет времени Jira для проверки истории.');
  if(!previous)return {startedAt:now,checkedAt:now,tracked:[...new Set(knownKeys)],events:[]};
  const minutes=Math.max(10,Math.ceil((now-previous.checkedAt)/60000)+10);
  const who=JSON.stringify(user);
  const relation=`("Тестировщик" = ${who} OR assignee = ${who} OR reporter = ${who})`;
  const tracked=[...new Set([...previous.tracked,...knownKeys])];
  const queries=[`${relation} AND updated >= -${minutes}m ORDER BY key ASC`];
  for(let i=0;i<tracked.length;i+=100)queries.push(`key in (${tracked.slice(i,i+100).map(x=>JSON.stringify(x)).join(',')}) AND updated >= -${minutes}m ORDER BY key ASC`);
  const candidates=new Map();
  for(const jql of queries){
    let startAt=0;
    for(;;){
      const page=await request('/rest/api/2/search',{jql,startAt,maxResults:100,fields:['summary','status','created']});
      if(!Array.isArray(page.issues)||!Number.isInteger(page.total))throw Error('Некорректный список изменённых задач.');
      for(const issue of page.issues)candidates.set(issue.key,issue);
      startAt+=page.issues.length;if(startAt>=page.total)break;
      if(!page.issues.length)throw Error('Неполный список изменённых задач.');
    }
  }
  const events=new Map(previous.events.map(e=>[e.id,e]));
  for(const issue of candidates.values()){
    const full=await request('/rest/api/2/issue/'+encodeURIComponent(issue.key)+'?fields=summary,status,created&expand=changelog');
    const log=full.changelog;
    if(!log||!Array.isArray(log.histories)||!Number.isInteger(log.total)||(log.startAt||0)!==0||log.histories.length!==log.total)throw Error('Jira вернула неполную историю '+issue.key+'. Проверка будет повторена.');
    for(const history of log.histories){
      if(!history.id||!Number.isFinite(Date.parse(history.created)))throw Error('Некорректное событие истории '+issue.key);
      if(Date.parse(history.created)<previous.startedAt)continue;
      for(const [index,item] of (history.items||[]).entries())if((item.field==='status'||item.fieldId==='status')&&ready(item.toString)){
        const id=`${full.id||issue.key}:${history.id}:${index}`;
        if(!events.has(id))events.set(id,{id,key:issue.key,summary:full.fields.summary,at:history.created,from:item.fromString||'',currentStatus:full.fields.status?.name||'',kind:'transition'});
      }
    }
    // Jira may create an issue directly in READY TO TEST without a status change entry.
    const firstChange=[...log.histories].sort((a,b)=>Date.parse(a.created)-Date.parse(b.created)).flatMap(h=>h.items||[]).find(i=>i.field==='status'||i.fieldId==='status');
    if(Date.parse(full.fields.created)>=previous.startedAt&&ready(firstChange?firstChange.fromString:full.fields.status?.name)){
      const id=`${full.id||issue.key}:created`;
      if(!events.has(id))events.set(id,{id,key:issue.key,summary:full.fields.summary,at:full.fields.created,from:'Создана',currentStatus:full.fields.status?.name||'',kind:'created'});
    }
  }
  return {startedAt:previous.startedAt,checkedAt:now,tracked:[...new Set([...tracked,...candidates.keys()])],events:[...events.values()]};
}

export class EventStore {
  constructor(directory){this.directory=directory;}
  filename(scope,user){return path.join(this.directory,'ready-'+createHash('sha256').update(scope+'\n'+user).digest('hex')+'.json');}
  async load(scope,user){try{return JSON.parse(await readFile(this.filename(scope,user),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
  async save(scope,user,value){await mkdir(this.directory,{recursive:true,mode:0o700});const filename=this.filename(scope,user);await writeFile(filename+'.tmp',JSON.stringify(value),{mode:0o600});await rename(filename+'.tmp',filename);}
}
