// Service catalog: Confluence "Деплой личного кабинета на qa стенде и работа с ним", v7 (25.08.2026).
// Its QA-2/QA-3 lists describe documentation scope, not proof of deployment on any stand.
export const STANDS=Object.freeze(['dev','dev-1','dev-2','dev-3','qa-1','qa-2','qa-3'].map(key=>({key,name:key.toUpperCase()})));
export const LK_SERVICES=Object.freeze([
  {name:'api-gateway',path:'digital/backend/api-gateway',documentedFor:['qa-2','qa-3']},
  {name:'audit-portal',path:'digital/backend/audit-portal',documentedFor:['qa-2']},
  {name:'audit-portal-external',path:'digital/backend/audit-portal-external',documentedFor:['qa-3']},
  {name:'dictionary-service',path:'digital/backend/dictionary-service',documentedFor:['qa-2','qa-3']},
  {name:'comment-service',path:'digital/backend/comment-service',documentedFor:['qa-2','qa-3']},
  {name:'flow-integration-service',path:'digital/backend/integration-services/flow-integration-service',documentedFor:['qa-2','qa-3']},
  {name:'contour-sync-transfer',path:'digital/backend/contour-sync-transfer',documentedFor:['qa-2']},
  {name:'crypto-signature-service',path:'digital/backend/security/crypto-signature-service',documentedFor:['qa-3']},
  {name:'crypto-tsl-loader',path:'digital/backend/security/crypto-tsl-loader',documentedFor:['qa-3']},
  {name:'audit-interaction-card',path:'digital/frontend/audit-interaction-card',documentedFor:['qa-2','qa-3']},
  {name:'digital-ui (FE)',path:'digital/frontend/digital-ui',documentedFor:['qa-2']},
  {name:'audit-portal-external-ui',path:'digital/frontend/audit-portal-external-ui',documentedFor:['qa-2']},
  {name:'form-constructor',path:'digital/frontend/form-constructor',documentedFor:['qa-2','qa-3']}
]);

export function deploymentView(environment,projectUrl){
  const deployment=environment.last_deployment;
  if(!deployment)return {state:environment.state==='stopped'?'stopped':'no-deployment'};
  const sha=/^[0-9a-f]{40}$/i.test(deployment.sha||'')?deployment.sha:'';
  const ref=String(deployment.ref||'');
  const tag=deployment.deployable?.tag;
  return {state:environment.state==='stopped'?'stopped':deployment.status==='success'?'success':deployment.status||'unknown',ref,refType:tag===true?'tag':tag===false?'branch':'unknown',sha,finishedAt:deployment.deployable?.finished_at||'',deploymentId:deployment.id||null,commitUrl:sha?`${projectUrl}/-/commit/${sha}`:'',environmentUrl:`${projectUrl}/-/environments/${environment.id}`};
}

async function limited(items,limit,task){
  let next=0;
  const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const index=next++;results[index]=await task(items[index])}
  }));
  return results;
}

export async function readGitLabStands({base,token},{fetcher=fetch,dispatcher,services=LK_SERVICES,stands=STANDS}={}){
  const checkedAt=new Date().toISOString();
  if(!base||!token)return {checkedAt,source:'gitlab',stands:stands.map(stand=>({...stand,services:[]})),error:'GitLab не настроен в профиле.'};
  const origin=new URL(base);
  if(origin.protocol!=='https:')throw Error('Для GitLab нужен HTTPS-адрес.');
  const request=async path=>{
    const response=await fetcher(new URL(path,origin),{headers:{'PRIVATE-TOKEN':token,Accept:'application/json'},redirect:'error',dispatcher,signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error(`GitLab HTTP ${response.status}`);
    return response.json();
  };
  const projects=await limited(services,5,async service=>{
    const url=`${origin.origin}/${service.path}`;
    const prefix=`/api/v4/projects/${encodeURIComponent(service.path)}/environments`;
    try{
      const environments=await request(`${prefix}?per_page=100`);
      if(!Array.isArray(environments))throw Error('Некорректный ответ GitLab');
      return {service,url,prefix,environments};
    }catch(error){return {service,url,prefix,error:error.message,environments:[]}}
  });
  const jobs=projects.flatMap(project=>stands.map(stand=>({project,stand,environment:project.environments.find(item=>item.name===stand.key)})));
  const details=await limited(jobs,8,async({project,environment})=>{
    if(project.error)return {state:'error',error:project.error};
    if(!environment)return {state:'no-environment'};
    try{return deploymentView(await request(`${project.prefix}/${environment.id}`),project.url)}
    catch(error){return {state:'error',error:error.message}}
  });
  return {checkedAt:new Date().toISOString(),source:'gitlab',stands:stands.map((stand,standIndex)=>({...stand,services:projects.map((project,index)=>({name:project.service.name,documentedFor:project.service.documentedFor||[],projectUrl:project.url,...details[index*stands.length+standIndex]}))}))};
}
