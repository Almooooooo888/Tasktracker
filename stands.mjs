import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export const STANDS = Object.freeze([
  { key: 'dev', name: 'DEV', namespace: 'development' },
  { key: 'dev-3', name: 'DEV-3', namespace: 'development-dev-3' },
  { key: 'qa-2', name: 'QA-2', namespace: 'development-qa-2' },
  { key: 'qa-3', name: 'QA-3', namespace: 'development-qa-3' }
]);

export function imageVersion(image) {
  const name=String(image||'').split('/').at(-1)||'';
  const digest=name.indexOf('@sha256:');
  if(digest>=0)return {service:name.slice(0,digest),version:'sha256:'+name.slice(digest+8,digest+20),tag:'',digest:name.slice(digest+1)};
  const colon=name.lastIndexOf(':');
  return colon>=0?{service:name.slice(0,colon),version:name.slice(colon+1),tag:name.slice(colon+1),digest:''}:{service:name,version:'без тега',tag:'',digest:''};
}

const deploymentName = name => String(name||'').replace(/-deployment$/,'');

export function summarizeNamespace(data,stand) {
  const items=Array.isArray(data?.items)?data.items:[];
  const deployments=items.filter(item=>item.kind==='Deployment');
  const pods=items.filter(item=>item.kind==='Pod'&&item.metadata?.deletionTimestamp==null);
  const byDeployment=new Map(deployments.map(deploy=>[deploy.metadata.name,[]]));
  const names=[...byDeployment.keys()].sort((a,b)=>b.length-a.length);
  for(const pod of pods){
    const owner=pod.metadata?.ownerReferences?.find(value=>value.kind==='ReplicaSet')?.name||'';
    const deployment=names.find(name=>owner.startsWith(name+'-'));
    if(deployment)byDeployment.get(deployment).push(pod);
  }
  const services=deployments.map(deploy=>{
    const related=byDeployment.get(deploy.metadata.name)||[];
    const desired=Number(deploy.spec?.replicas??1),ready=Number(deploy.status?.readyReplicas||0);
    const containers=(deploy.spec?.template?.spec?.containers||[]).map(container=>{
      const running=new Map();
      for(const pod of related){
        if(pod.status?.phase!=='Running')continue;
        const actual=pod.spec?.containers?.find(value=>value.name===container.name)?.image;
        if(actual)running.set(actual,(running.get(actual)||0)+1);
      }
      return {name:container.name,image:container.image,...imageVersion(container.image),running:[...running].sort(([a],[b])=>a.localeCompare(b)).map(([image,pods])=>({image,version:imageVersion(image).version,pods}))};
    });
    const transition=containers.some(container=>container.running.some(item=>item.image!==container.image));
    const pending=Number(deploy.metadata?.generation||0)>Number(deploy.status?.observedGeneration||0)||ready<desired;
    const sha=String(deploy.metadata?.annotations?.['app.gitlab.com/commit-sha']||deploy.spec?.template?.metadata?.annotations?.['app.gitlab.com/commit-sha']||'');
    return {name:deploymentName(deploy.metadata.name),deployment:deploy.metadata.name,namespace:stand.namespace,desired,ready,pods:related.length,containers,transition,pending,sha:/^[0-9a-f]{7,40}$/i.test(sha)?sha:''};
  }).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  return {key:stand.key,name:stand.name,namespace:stand.namespace,services,checkedAt:new Date().toISOString(),error:null};
}

export function attachGitProjects(snapshot,projects,baseUrl) {
  const lookup=new Map();
  for(const project of projects){
    const key=String(project.path||'').toLowerCase().replaceAll('_','-');
    if(!key)continue;
    let url='';
    try{const parsed=new URL(project.web_url);if(parsed.protocol==='https:'&&parsed.origin===new URL(baseUrl).origin)url=parsed.href}catch{}
    if(!url)continue;
    if(lookup.has(key))lookup.set(key,null);
    else lookup.set(key,url);
  }
  return {...snapshot,stands:snapshot.stands.map(stand=>({...stand,services:stand.services.map(service=>({...service,containers:service.containers.map(container=>({...container,projectUrl:lookup.get(container.service.toLowerCase().replaceAll('_','-'))||''}))}))}))};
}

export async function readStands(kubeconfig,{executable=process.env.LK_KUBECTL||'kubectl',context=process.env.LK_KUBE_CONTEXT||'',run=runFile}={}) {
  if(!kubeconfig)return {stands:STANDS.map(stand=>({...stand,services:[],error:'Kubernetes не настроен: укажи kubeconfig в профиле.'})),checkedAt:new Date().toISOString()};
  const stands=await Promise.all(STANDS.map(async stand=>{
    const args=['--kubeconfig',kubeconfig];if(context)args.push('--context',context);
    args.push('-n',stand.namespace,'get','deployments,pods','-o','json','--request-timeout=15s');
    try{
      const {stdout}=await run(executable,args,{windowsHide:true,timeout:20000,maxBuffer:16*1024*1024});
      return summarizeNamespace(JSON.parse(stdout),stand);
    }catch(error){
      const detail=String(error.stderr||error.message||'').trim();
      const reason=/Forbidden/i.test(detail)?'Нет прав на чтение Deployment или pod в этом namespace.':/timed out|timeout/i.test(detail)?'Kubernetes не ответил за 20 секунд.':'Не удалось прочитать Kubernetes. Проверь VPN и kubeconfig.';
      return {...stand,services:[],checkedAt:new Date().toISOString(),error:reason};
    }
  }));
  return {stands,checkedAt:new Date().toISOString()};
}
