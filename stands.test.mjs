import test from 'node:test';
import assert from 'node:assert/strict';
import { imageVersion, summarizeNamespace, attachGitProjects, readStands } from './stands.mjs';

const stand={key:'qa-2',name:'QA-2',namespace:'development-qa-2'};
const deployment={kind:'Deployment',metadata:{name:'audit-portal-qa-2-deployment',generation:4,annotations:{}},spec:{replicas:2,template:{spec:{containers:[{name:'app',image:'registry.example/test/audit-portal:1.4.0'}]}}},status:{readyReplicas:1,observedGeneration:4}};
const pod=(suffix,image)=>({kind:'Pod',metadata:{name:`audit-portal-qa-2-deployment-${suffix}-p`,ownerReferences:[{kind:'ReplicaSet',name:`audit-portal-qa-2-deployment-${suffix}`}]},spec:{containers:[{name:'app',image}]},status:{phase:'Running'}});

test('Kubernetes images show the requested and actually running versions during rollout',()=>{
  const result=summarizeNamespace({items:[deployment,pod('old','registry.example/test/audit-portal:1.3.0'),pod('new','registry.example/test/audit-portal:1.4.0')]},stand);
  const service=result.services[0];
  assert.equal(service.name,'audit-portal-qa-2');
  assert.equal(service.containers[0].version,'1.4.0');
  assert.deepEqual(service.containers[0].running.map(item=>item.version),['1.3.0','1.4.0']);
  assert.equal(service.transition,true);
  assert.equal(service.pending,true);
});

test('GitLab project link is attached only for a unique exact project path',()=>{
  const snapshot={stands:[summarizeNamespace({items:[deployment]},stand)]};
  const matched=attachGitProjects(snapshot,[{path:'audit-portal',web_url:'https://git.example/digital/backend/audit-portal'}],'https://git.example');
  assert.equal(matched.stands[0].services[0].containers[0].projectUrl,'https://git.example/digital/backend/audit-portal');
  const ambiguous=attachGitProjects(snapshot,[{path:'audit-portal',web_url:'https://git.example/a'},{path:'audit-portal',web_url:'https://git.example/b'}],'https://git.example');
  assert.equal(ambiguous.stands[0].services[0].containers[0].projectUrl,'');
  assert.equal(imageVersion('registry:5000/test/service@sha256:abcdef1234567890').version,'sha256:abcdef123456');
});

test('Kubernetes read is scoped to the four configured namespaces',async()=>{
  const calls=[];
  const result=await readStands('C:/fake/kubeconfig',{run:async(_executable,args)=>{calls.push(args);return {stdout:JSON.stringify({items:[]})}}});
  assert.deepEqual(result.stands.map(item=>item.namespace),['development','development-dev-3','development-qa-2','development-qa-3']);
  assert.equal(calls.length,4);
  for(const args of calls){assert.deepEqual(args.slice(-5),['get','deployments,pods','-o','json','--request-timeout=15s']);assert.ok(args.includes('-n'))}
});
