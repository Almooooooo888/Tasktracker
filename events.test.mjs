import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scanReadyEvents,EventStore} from './events.mjs';
const start=Date.parse('2026-09-24T10:00:00Z');
const history=(id,seconds,from,to)=>({id,created:new Date(start+seconds*1000).toISOString(),items:[{field:'status',fromString:from,toString:to}]});
function setup(histories,status='READY TO TEST',created='2026-09-01T00:00:00Z'){
 const issue={id:'10',key:'QA-1',fields:{summary:'Test',status:{name:status},created},changelog:{startAt:0,total:histories.length,histories}};
 const queries=[];
 return {issue,queries,request:async(url,body)=>{if(url==='/rest/api/2/search'){queries.push(body.jql);return {total:1,issues:[issue]}}return issue}};
}
test('baseline ignores old transitions; fast away/back is detected and deduplicated',async()=>{
 const fixture=setup([history('old',-60,'TESTING','READY TO TEST'),history('out',10,'READY TO TEST','TESTING'),history('back',11,'TESTING','READY TO TEST')]);
 const baseline=await scanReadyEvents(null,{user:'qa',now:start,knownKeys:['QA-1'],request:fixture.request});
 assert.equal(baseline.events.length,0);
 const scanned=await scanReadyEvents(baseline,{user:'qa',now:start+60000,request:fixture.request});
 assert.deepEqual(scanned.events.map(x=>x.id),['10:back:0']);
 const repeated=await scanReadyEvents(scanned,{user:'qa',now:start+120000,request:fixture.request});
 assert.equal(repeated.events.length,1);
});
test('multiple transitions retained even when issue is already closed',async()=>{
 const fixture=setup([history('a',10,'TESTING','READY TO TEST'),history('b',11,'READY TO TEST','TESTING'),history('c',12,'TESTING','READY TO TEST'),history('d',13,'READY TO TEST','Done')],'Done');
 const baseline=await scanReadyEvents(null,{user:'qa',now:start,knownKeys:['QA-1']});
 const scanned=await scanReadyEvents(baseline,{user:'qa',now:start+60000,request:fixture.request});
 assert.equal(scanned.events.length,2);assert.ok(fixture.queries.every(x=>!x.includes('Unresolved')));assert.ok(fixture.queries.some(x=>x.includes('key in')));
});
test('incomplete history or network failure does not change checkpoint; retry succeeds',async()=>{
 const fixture=setup([history('back',11,'TESTING','READY TO TEST')]);
 const baseline=await scanReadyEvents(null,{user:'qa',now:start,knownKeys:['QA-1']});
 fixture.issue.changelog.total=2;
 await assert.rejects(scanReadyEvents(baseline,{user:'qa',now:start+60000,request:fixture.request}),/неполную историю/);
 assert.equal(baseline.checkedAt,start);assert.deepEqual(baseline.events,[]);
 await assert.rejects(scanReadyEvents(baseline,{user:'qa',now:start+60000,request:async()=>{throw Error('offline')}}));
 fixture.issue.changelog.total=1;
 const retry=await scanReadyEvents(baseline,{user:'qa',now:start+3600000,request:fixture.request});assert.equal(retry.events.length,1);
});
test('journal survives restart; a later history record is a distinct event',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'jira-event-test-'));
 try{
 const fixture=setup([history('back',11,'TESTING','READY TO TEST')]);
 const baseline=await scanReadyEvents(null,{user:'qa',now:start,knownKeys:['QA-1']});
 const result=await scanReadyEvents(baseline,{user:'qa',now:start+60000,request:fixture.request});
 await new EventStore(dir).save('scope','qa',result);
 const restored=await new EventStore(dir).load('scope','qa');assert.deepEqual(restored,result);
 fixture.issue.changelog.histories.push(history('another',65,'TESTING','READY TO TEST'));fixture.issue.changelog.total=2;
 assert.equal((await scanReadyEvents(restored,{user:'qa',now:start+120000,request:fixture.request})).events.length,2);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('search pagination and creation directly in READY TO TEST',async()=>{
 const fixture=setup([],'READY TO TEST',new Date(start+10000).toISOString());
 const baseline=await scanReadyEvents(null,{user:'qa',now:start});
 const second={...fixture.issue,id:'11',key:'QA-2'};let pages=0;
 const request=async(url,body)=>{if(url==='/rest/api/2/search'){pages++;return {total:2,issues:[body.startAt===0?fixture.issue:second]}}return url.includes('QA-2')?second:fixture.issue};
 const result=await scanReadyEvents(baseline,{user:'qa',now:start+60000,request});
 assert.equal(pages,2);assert.equal(result.events.length,2);assert.ok(result.events.every(e=>e.kind==='created'));
});
