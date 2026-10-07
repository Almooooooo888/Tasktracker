import test from 'node:test';
import assert from 'node:assert/strict';
import {STANDS,LK_SERVICES,deploymentView,readGitLabStands} from './stands.mjs';

test('ЛК scope contains only curated services and seven DEV/QA environments',()=>{
  assert.deepEqual(STANDS.map(stand=>stand.key),['dev','dev-1','dev-2','dev-3','qa-1','qa-2','qa-3']);
  assert.equal(LK_SERVICES.length,8);
  assert.ok(LK_SERVICES.every(service=>service.path.startsWith('digital/')));
});

test('GitLab deployment carries the deployed ref, commit and tag/branch kind',()=>{
  const branch=deploymentView({id:97,state:'available',last_deployment:{id:23985,ref:'feature/ECP-6496',sha:'3587eb18e1ac6903f6ece3043370e9b218a1320d',status:'success',deployable:{tag:false,finished_at:'2026-10-06T14:35:36.904Z'}}},'https://git.example/digital/backend/audit-portal');
  assert.equal(branch.ref,'feature/ECP-6496');assert.equal(branch.refType,'branch');assert.equal(branch.state,'success');assert.equal(branch.sha.slice(0,8),'3587eb18');
  assert.equal(deploymentView({id:1,state:'available',last_deployment:{ref:'v1.2.3',status:'success',deployable:{tag:true}}},'https://git.example/a').refType,'tag');
  assert.equal(deploymentView({id:1,state:'available',last_deployment:{ref:'main',status:'failed'}},'https://git.example/a').state,'failed');
  const stopped=deploymentView({id:1,state:'stopped',last_deployment:{ref:'main',status:'success'}},'https://git.example/a');
  assert.equal(stopped.state,'stopped');assert.equal(stopped.ref,'main');
});

test('read-only GitLab requests select the exact environment deployment',async()=>{
  const calls=[];
  const fetcher=async url=>{calls.push(url.pathname);return {ok:true,json:async()=>url.pathname.endsWith('/environments')?[{id:97,name:'qa-2'}]:{id:97,state:'available',last_deployment:{id:23985,ref:'feature/ECP-6496',sha:'3587eb18e1ac6903f6ece3043370e9b218a1320d',status:'success',deployable:{tag:false}}}}};
  const result=await readGitLabStands({base:'https://git.example',token:'test-only'},{fetcher,services:[{name:'audit-portal',path:'digital/backend/audit-portal'}],stands:[{key:'qa-2',name:'QA-2'}]});
  assert.deepEqual(calls,['/api/v4/projects/digital%2Fbackend%2Faudit-portal/environments','/api/v4/projects/digital%2Fbackend%2Faudit-portal/environments/97']);
  assert.equal(result.stands[0].services[0].ref,'feature/ECP-6496');
});
