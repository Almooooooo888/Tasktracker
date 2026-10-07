import test from 'node:test';
import assert from 'node:assert/strict';
import {STANDS,LK_SERVICES,deploymentView,pipelineView,activeDeploymentView,completedDeploymentView,readGitLabStands,readGitLabStandActivity} from './stands.mjs';

test('ЛК catalog includes every unique repository in the QA-2/QA-3 deployment guide',()=>{
  assert.deepEqual(STANDS.map(stand=>stand.key),['dev','dev-1','dev-2','dev-3','qa-1','qa-2','qa-3']);
  assert.deepEqual(LK_SERVICES.map(service=>service.name),[
    'api-gateway','audit-portal','audit-portal-external','dictionary-service','comment-service',
    'flow-integration-service','contour-sync-transfer','crypto-signature-service','crypto-tsl-loader',
    'audit-interaction-card','digital-ui (FE)','audit-portal-external-ui','form-constructor'
  ]);
  assert.ok(LK_SERVICES.every(service=>service.path.startsWith('digital/')));
  assert.deepEqual(LK_SERVICES.find(service=>service.name==='comment-service').documentedFor,['qa-2','qa-3']);
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

test('running pipelines do not claim an environment until GitLab records a deployment',()=>{
  const projectUrl='https://git.example/digital/backend/audit-portal';
  const pipeline=pipelineView({id:123,ref:'feature/ECP-7000',sha:'abc',status:'running',source:'web',tag:false},'audit-portal',projectUrl);
  assert.equal(pipeline.ref,'feature/ECP-7000');assert.equal(pipeline.stand,undefined);
  assert.equal(pipelineView({id:124,ref:'refs/merge-requests/1/head',status:'running',source:'merge_request_event'},'audit-portal',projectUrl),null);
  const deployment=activeDeploymentView({id:90,status:'running',ref:'feature/ECP-7000',environment:{id:7,name:'qa-2'},deployable:{tag:false}},'audit-portal',projectUrl);
  assert.equal(deployment.stand,'qa-2');assert.equal(deployment.ref,'feature/ECP-7000');
  assert.equal(activeDeploymentView({id:91,status:'running',ref:'main',environment:{id:8,name:'prod'}},'audit-portal',projectUrl),null);
  assert.equal(completedDeploymentView({id:92,status:'success',ref:'feature/ECP-7000',environment:{id:7,name:'qa-2'}},'audit-portal').stand,'qa-2');
});

test('a running deployment keeps the previous successful ref visible',async()=>{
  const calls=[];
  const fetcher=async url=>{calls.push(url.pathname+url.search);return {ok:true,json:async()=>url.pathname.endsWith('/environments')?[{id:7,name:'qa-2'}]:url.pathname.endsWith('/environments/7')?{id:7,state:'available',last_deployment:{id:91,ref:'feature/new',status:'running'}}:[{id:90,ref:'feature/old',sha:'3587eb18e1ac6903f6ece3043370e9b218a1320d',status:'success',deployable:{tag:false}}]}};
  const result=await readGitLabStands({base:'https://git.example',token:'test-only'},{fetcher,services:[{name:'audit-portal',path:'digital/backend/audit-portal'}],stands:[{key:'qa-2',name:'QA-2'}]});
  assert.equal(result.stands[0].services[0].ref,'feature/old');assert.equal(result.stands[0].services[0].state,'success');
  assert.equal(result.stands[0].services[0].lastAttempt.status,'running');
  assert.ok(calls.some(path=>path.includes('/deployments?environment=qa-2&status=success')));
});

test('activity reads active project pipelines and exact running deployments',async()=>{
  const calls=[];
  const fetcher=async url=>{calls.push(url.pathname+url.search);return {ok:true,json:async()=>url.pathname.endsWith('/pipelines')?[{id:123,ref:'feature/ECP-7000',status:'running',source:'web',tag:false},{id:122,ref:'refs/merge-requests/1/head',status:'running',source:'merge_request_event'}]:[{id:91,status:'running',ref:'feature/ECP-7000',environment:{id:7,name:'qa-2'},deployable:{tag:false}},{id:90,status:'success',ref:'feature/old',environment:{id:7,name:'qa-2'}}]}};
  const result=await readGitLabStandActivity({base:'https://git.example',token:'test-only'},{fetcher,services:[{name:'audit-portal',path:'digital/backend/audit-portal'}],stands:[{key:'qa-2',name:'QA-2'}]});
  assert.equal(result.pipelines.length,1);assert.equal(result.deployments.length,1);assert.equal(result.completed.length,1);assert.equal(result.deployments[0].stand,'qa-2');
  assert.ok(calls.some(path=>path.includes('/pipelines?')));assert.ok(calls.some(path=>path.includes('/deployments?per_page=30&sort=desc')));
});
