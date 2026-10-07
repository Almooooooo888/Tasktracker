import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { loadProfile, saveProfile, directory } from './profile.mjs';
import {EventStore,scanReadyEvents} from './events.mjs';
import { investigate, checkDatabaseConnection, diagnosticDefaults } from './investigation.mjs';
import { validateLogin, discoverCalendar, readCalendar, readCalendarAttendees, calendarRange, validateCalendarMailbox, validateCalendarItemId } from './calendar.mjs';
import { readStands, attachGitProjects } from './stands.mjs';
const eventStore=new EventStore(directory);
const require = createRequire(import.meta.url);
const { fetch, Agent } = require('undici');
const tlsErrorCodes = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID']);
function tlsFailure(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    const code = current.code || current.errno;
    if (tlsErrorCodes.has(code)) return `Не удалось проверить TLS-сертификат Jira (${code}). Установи доверенный CA-сертификат и перезапусти Taskboard.`;
  }
  return null;
}
let profile = await loadProfile() || {
  base: (process.env.LK_JIRA_BASE_URL || 'https://jira.example.com').replace(/\/$/, ''),
  token: process.env.LK_JIRA_TOKEN_FILE ? (await readFile(process.env.LK_JIRA_TOKEN_FILE, 'utf8')).trim() : process.env.LK_JIRA_TOKEN || '',
  account: null,
  gitlabBaseUrl: process.env.LK_GITLAB_BASE_URL || '',
  gitlabToken: process.env.LK_GITLAB_TOKEN || ''
};
const csrf = randomBytes(32).toString('hex');
let savingProfile = false;
let investigationBusy = false;
let calendarSession = null;
let calendarBusy = false;
// Same internal certificate configuration as the existing LK connector.
const dispatcher = new Agent({ connect: { rejectUnauthorized: process.env.LK_JIRA_TLS_SKIP_VERIFY !== 'true' } });
const getGitLabConnection=()=>({base:(profile.gitlabBaseUrl||process.env.LK_GITLAB_BASE_URL||'').trim().replace(/\/$/,''),token:(profile.gitlabToken||process.env.LK_GITLAB_TOKEN||'').trim()});
const publicProfile = () => ({configured: Boolean(profile.token), account: profile.account, gitlabConfigured:Boolean(getGitLabConnection().base&&getGitLabConnection().token),gitlabBaseUrl:getGitLabConnection().base,pgHost:profile.pgHost||diagnosticDefaults.pgHost,pgUser:profile.pgUser||diagnosticDefaults.pgUser,pgConfigured:Boolean((profile.pgHost||diagnosticDefaults.pgHost)&&(profile.pgUser||diagnosticDefaults.pgUser)&&(profile.pgPassword||process.env.LK_PG_PASSWORD)),kubeconfig:profile.kubeconfig||diagnosticDefaults.kubeconfig,calendarConnected:Boolean(calendarSession),calendarEmail:calendarSession?.email||'',version:'1.23.0', csrf});
const states = new Map();
const refreshTimes = new WeakMap();
const lastAccess = new WeakMap();
const releaseCache = new Map();
const releasePending = new Map();
const gitlabCache = new Map();
const gitlabPending = new Map();
const bugTypeCache = new WeakMap();
let standCache=null,standPending=null,projectCache=null,projectPending=null;
async function currentStands(){
  if(standCache&&Date.now()-standCache.at<12000)return standCache.data;
  if(standPending)return standPending;
  standPending=readStands(profile.kubeconfig||diagnosticDefaults.kubeconfig).then(data=>{standCache={at:Date.now(),data};return data}).finally(()=>{standPending=null});
  return standPending;
}
async function gitlabProjects(){
  const connection=getGitLabConnection();if(!connection.base||!connection.token)return null;
  const key=connection.base+'|'+connection.token;
  if(projectCache?.key===key&&Date.now()-projectCache.at<900000)return projectCache.projects;
  if(projectPending)return projectPending;
  projectPending=(async()=>{
    const projects=[];
    for(let page=1;page<=20;page++){
      const endpoint=new URL('/api/v4/groups/digital/projects',connection.base);
      endpoint.searchParams.set('include_subgroups','true');endpoint.searchParams.set('simple','true');endpoint.searchParams.set('per_page','100');endpoint.searchParams.set('page',String(page));
      const response=await fetch(endpoint,{headers:{'PRIVATE-TOKEN':connection.token,Accept:'application/json'},redirect:'error',dispatcher,signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('GitLab HTTP '+response.status);
      const rows=await response.json();if(!Array.isArray(rows))throw Error('GitLab вернул некорректный список проектов.');
      projects.push(...rows.map(item=>({path:item.path,web_url:item.web_url})));
      if(rows.length<100)break;
    }
    projectCache={key,at:Date.now(),projects};return projects;
  })().catch(()=>{projectCache={key,at:Date.now(),projects:null};return null}).finally(()=>{projectPending=null});
  return projectPending;
}
function getState(username) {
  let state = states.get(username);
  if (!state) {
    if (states.size >= 20) {
      const oldest = [...states.values()].filter(s => !s.refreshing).sort((a,b) => lastAccess.get(a) - lastAccess.get(b))[0];
      if (!oldest) return null;
      states.delete(oldest.user);
    }
    state = { user: username, issues: [], lastSuccess: null, error: null, historyError:null, readyEvents:[], historyCheckedAt:null, refreshing: false };
    states.set(username, state);
  }
  lastAccess.set(state, Date.now());
  if (Date.now() - (refreshTimes.get(state) || 0) >= 60000) void refresh(state);
  return state;
}
async function jira(path, body, connection = profile) {
  const response = await fetch(connection.base + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', dispatcher, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Нет доступа к Jira. Проверь токен и права пользователя.' : response.status === 400 ? 'Jira: пользователь не найден. Выбери пользователя из списка.' : `Jira: ошибка ${response.status}`);
  if(response.status===204||response.status===201)return null;
  return response.json();
}
async function getReleaseBuilder(key,connection){
  const parent=await jira(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,project,fixVersions,issuelinks`,undefined,connection),fields=parent.fields||{},project=fields.project?.key;
  if(!project)throw new Error('У релизной задачи не найден проект.');
  const [versions,types]=await Promise.all([
    jira(`/rest/api/2/project/${encodeURIComponent(project)}/versions`,undefined,connection),
    jira('/rest/api/2/issueLinkType',undefined,connection)
  ]);
  const linkedKeys=new Set();for(const link of fields.issuelinks||[]){if(link.inwardIssue?.key)linkedKeys.add(link.inwardIssue.key);if(link.outwardIssue?.key)linkedKeys.add(link.outwardIssue.key)}
  const relation=(types.issueLinkTypes||[]).find(type=>/relates to/i.test(`${type.inward||''} ${type.outward||''}`));
  return {issue:{key:parent.key,summary:fields.summary||'',project,fixVersions:(fields.fixVersions||[]).map(version=>({id:String(version.id),name:version.name})),url:`${connection.base}/browse/${encodeURIComponent(parent.key)}`},versions:(versions||[]).map(version=>({id:String(version.id),name:version.name,released:Boolean(version.released),archived:Boolean(version.archived)})).filter(version=>!version.archived),linkedKeys:[...linkedKeys],relation:relation?{name:relation.name,inward:relation.inward,outward:relation.outward}:null};
}
async function getVersionIssues(project,versionId,connection){
  let startAt=0,total=0,issues=[];
  do{
    const result=await jira('/rest/api/2/search',{jql:`project = ${JSON.stringify(project)} AND fixVersion = ${Number(versionId)} ORDER BY key`,startAt,maxResults:100,fields:['summary','status','issuetype','priority','assignee','updated','fixVersions','labels']},connection);
    if(!Array.isArray(result.issues)||!Number.isInteger(result.total))throw new Error('Некорректный ответ Jira при поиске задач версии.');
    issues.push(...result.issues);total=result.total;startAt+=result.issues.length;
    if(!result.issues.length||issues.length>=1000)break;
  }while(startAt<total);
  return {issues:issues.slice(0,1000).map(issue=>({key:issue.key,summary:issue.fields?.summary||'',status:issue.fields?.status?.name||'',type:issue.fields?.issuetype?.name||'',priority:issue.fields?.priority?.name||'',assignee:issue.fields?.assignee?.displayName||'Не назначен',updated:issue.fields?.updated||'',labels:issue.fields?.labels||[],url:`${connection.base}/browse/${encodeURIComponent(issue.key)}`})),total,truncated:total>1000};
}
async function getCreatedBugs(startAt, connection) {
  let cached = bugTypeCache.get(connection);
  if (!cached || Date.now() - cached.at > 300000) {
    const types = await jira('/rest/api/2/issuetype', undefined, connection);
    if (!Array.isArray(types)) throw new Error('Jira не вернула типы задач.');
    const ids = types.filter(type => /^(?:баг|bug|дефект|defect|ошибка)$/iu.test(String(type.name || '').trim()))
      .map(type => String(type.id)).filter(id => /^\d+$/.test(id));
    cached = {at:Date.now(), ids};
    bugTypeCache.set(connection, cached);
  }
  if (!cached.ids.length) throw new Error('В Jira не найден тип задачи «Баг» или «Дефект».');
  const jql = `reporter = currentUser() AND issuetype in (${cached.ids.join(',')}) ORDER BY created DESC`;
  const page = await jira('/rest/api/2/search', {jql,startAt,maxResults:100,fields:['summary','status','issuetype','priority','assignee','created','updated']}, connection);
  if (!Array.isArray(page.issues) || !Number.isInteger(page.total)) throw new Error('Jira вернула некорректный список багов.');
  return {issues:page.issues.map(issue => ({
    key:issue.key, url:`${connection.base}/browse/${encodeURIComponent(issue.key)}`,
    summary:issue.fields?.summary || '(без названия)', status:issue.fields?.status?.name || 'Не указан',
    type:issue.fields?.issuetype?.name || '', priority:issue.fields?.priority?.name || '',
    assignee:issue.fields?.assignee?.displayName || 'Не назначен',
    created:issue.fields?.created || '', updated:issue.fields?.updated || ''
  })), total:page.total, startAt, fetchedAt:new Date().toISOString()};
}
async function gitlabIssueBranches(key) {
  const connection=getGitLabConnection();if (!connection.base || !connection.token) return {status:'not-configured',repositories:[]};
  const cacheKey=connection.base+'|'+key, cached=gitlabCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<300000)return cached.value;
  if(gitlabPending.has(cacheKey))return gitlabPending.get(cacheKey);
  const pending=(async()=>{
    const endpoint=new URL('/api/v4/merge_requests',connection.base);
    endpoint.searchParams.set('scope','all');endpoint.searchParams.set('state','all');endpoint.searchParams.set('search',key);endpoint.searchParams.set('per_page','20');
    const response=await fetch(endpoint,{headers:{'PRIVATE-TOKEN':connection.token,Accept:'application/json'},redirect:'error',dispatcher,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('GitLab HTTP '+response.status);
    const rows=await response.json();if(!Array.isArray(rows))throw new Error('Некорректный ответ GitLab');
    const repositories=new Map();
    for(const mr of rows){
      if(![mr.title,mr.description,mr.source_branch].some(value=>String(value||'').includes(key)))continue;
      if(!mr.source_branch)continue;
      const projectPath=mr.references?.full?.replace(/![^!]+$/,'')||mr.web_url?.split('/-/merge_requests/')[0]?.replace(/^https?:\/\/[^/]+\//,'')||'Репозиторий';
      const group=repositories.get(projectPath)||{name:projectPath,url:'',branches:[]};
      group.branches.push({name:mr.source_branch,iid:mr.iid,targetBranch:mr.target_branch||'',url:mr.web_url||'',mergeState:mr.state||'',mergedAt:mr.merged_at||''});repositories.set(projectPath,group);
    }
    const value={status:'ok',repositories:[...repositories.values()].map(repo=>({...repo,branches:[...new Map(repo.branches.map(b=>[b.url||`${b.name}|${b.mergeState}`,b])).values()]}))};
    gitlabCache.set(cacheKey,{at:Date.now(),value});if(gitlabCache.size>300)gitlabCache.delete(gitlabCache.keys().next().value);return value;
  })();
  gitlabPending.set(cacheKey,pending);try{return await pending}finally{gitlabPending.delete(cacheKey)}
}
async function refresh(state) {
  if (state.refreshing) return;
  state.refreshing = true;
  refreshTimes.set(state, Date.now());
  try {
    const connection=profile;
    const scope=connection.base+'|'+(connection.account?.username||createHash('sha256').update(connection.token).digest('hex'));
    let previous;
    try{previous=await eventStore.load(scope,state.user);state.readyEvents=(previous?.events||[]).map(event=>({...event,url:`${connection.base}/browse/${encodeURIComponent(event.key)}`}));state.historyCheckedAt=previous?new Date(previous.checkedAt).toISOString():null;}catch{state.historyError='Не удалось прочитать журнал уведомлений. Проверка истории остановлена.';}
    const userLiteral = JSON.stringify(state.user);
    const jql = `("Тестировщик" = ${userLiteral} OR assignee = ${userLiteral} OR reporter = ${userLiteral}) AND resolution = Unresolved AND statusCategory != Done ORDER BY updated DESC`;
    let issues = [], startAt = 0;
    for (;;) {
      const page = await jira('/rest/api/2/search', { jql, startAt, maxResults: 100, fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated'] }, connection);
      if (!Array.isArray(page.issues) || !Number.isInteger(page.total)) throw new Error('Некорректный ответ Jira');
      issues.push(...page.issues);
      startAt += page.issues.length;
      if (startAt >= page.total) break;
      if (!page.issues.length) throw new Error('Jira вернула неполный список');
    }
    state.issues = [...new Map(issues.map(x => [x.key, { key: x.key, url: `${connection.base}/browse/${encodeURIComponent(x.key)}`, summary: x.fields.summary, status: x.fields.status.id === '10100' ? 'Сделать' : x.fields.status.name, type: x.fields.issuetype?.name, priority: x.fields.priority?.name, assignee: x.fields.assignee?.displayName || 'Не назначен', author: x.fields.reporter?.displayName || x.fields.reporter?.name || 'Не указан', updated: x.fields.updated }])).values()];
    state.lastSuccess = new Date().toISOString();
    state.error = null;
    try{
      if(previous===undefined)throw Error('Не удалось прочитать журнал уведомлений.');
      const info=await jira('/rest/api/2/serverInfo',undefined,connection);
      const result=await scanReadyEvents(previous,{user:state.user,knownKeys:state.issues.map(x=>x.key),request:(path,body)=>jira(path,body,connection),now:Date.parse(info.serverTime)});
      if(connection!==profile)return;
      await eventStore.save(scope,state.user,result);
      state.readyEvents=result.events.map(event=>({...event,url:`${connection.base}/browse/${encodeURIComponent(event.key)}`}));state.historyCheckedAt=new Date(result.checkedAt).toISOString();state.historyError=null;
    }catch(error){state.historyError='Не удалось проверить историю переходов. Повторим автоматически. '+(/^(Jira вернула неполную|Нет времени Jira)/.test(error.message)?error.message:'');}
  } catch (error) {
    state.error = tlsFailure(error) || (/^(Jira:|Нет доступа|Некорректный ответ|Jira вернула)/.test(error.message) ? error.message : 'Не удалось подключиться к Jira. Проверь сеть или VPN.');
  } finally { state.refreshing = false; }
}
async function getReleaseSnapshot(key, connection) {
  const cacheKey = connection.base + '|' + (connection.account?.username || '') + '|' + key;
  const cached = releaseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  if (releasePending.has(cacheKey)) return releasePending.get(cacheKey);
  const pending = (async () => {
    const parent = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,project,issuetype,status,assignee,updated,fixVersions,subtasks,issuelinks`, undefined, connection);
    const parentFields = parent.fields || {};
    const related = new Map();
    const addRelated = (issue, relation) => {
      if (!issue?.key || issue.key === key) return;
      const item = related.get(issue.key) || { key: issue.key, id: issue.id, relations: [] };
      if (!item.relations.includes(relation)) item.relations.push(relation);
      related.set(issue.key, item);
    };
    for (const child of parentFields.subtasks || []) addRelated(child, 'Подзадача');
    for (const link of parentFields.issuelinks || []) {
      if (link.outwardIssue) addRelated(link.outwardIssue, link.type?.outward || link.type?.name || 'Связана');
      if (link.inwardIssue) addRelated(link.inwardIssue, link.type?.inward || link.type?.name || 'Связана');
    }
    const relatedKeys = [...related.keys()].slice(0, 100);
    let issues = [];
    if (relatedKeys.length) {
      const jql = `key in (${relatedKeys.join(',')}) ORDER BY key`;
      const result = await jira('/rest/api/2/search', { jql, startAt: 0, maxResults: 100, fields: ['summary','status','issuetype','priority','assignee','updated','fixVersions'] }, connection);
      if (!Array.isArray(result.issues)) throw new Error('Некорректный ответ Jira при чтении связанных задач.');
      issues = result.issues;
    }
    const issueMap = new Map(issues.map(issue => [issue.key, issue]));
    const gitTargets = [{key: parent.key, id: parent.id}, ...relatedKeys.filter(issueKey => issueMap.has(issueKey)).map(issueKey => ({key: issueKey, id: issueMap.get(issueKey).id}))];
    const gitResults = new Map();
    let gitErrors = 0;
    let gitSkipped = Math.max(0, gitTargets.length - 31);
    const queue = gitTargets.filter(item => item.id).slice(0, 31);
    let cursor = 0;
    async function readGitBranches() {
      for (;;) {
        const index = cursor++;
        if (index >= queue.length) return;
        const item = queue[index];
        try {
          const response = await jira(`/rest/dev-status/1.0/issue/detail?issueId=${encodeURIComponent(item.id)}&applicationType=gitlab&dataType=branch`, undefined, connection);
          if (Array.isArray(response.errors) && response.errors.length) throw new Error('Git integration error');
          const repositories = Array.isArray(response.detail?.repositories) ? response.detail.repositories : [];
          gitResults.set(item.key, repositories.map(repository => ({
            name: repository.name || repository.repositoryName || 'Репозиторий',
            url: repository.url || '',
            branches: (repository.branches || []).map(branch => ({name: branch.name || branch.displayId || '', url: branch.url || branch.urlDisplay || ''})).filter(branch => branch.name)
          })).filter(repository => repository.branches.length));
        } catch { gitErrors++; gitResults.set(item.key, null); }
      }
    }
    await Promise.all(Array.from({length: Math.min(5, queue.length)}, readGitBranches));
    const gitFor = issueKey => gitResults.has(issueKey) ? gitResults.get(issueKey) : null;
    let gitlabErrors=0,gitlabSkipped=0;
    const gitlabConnection=getGitLabConnection();
    const gitlabStatus=new Map(gitTargets.map(item=>[item.key,!gitlabConnection.base||!gitlabConnection.token?'not-configured':(gitResults.get(item.key)||[]).length?'branch-linked':'not-checked']));
    if(gitlabConnection.base&&gitlabConnection.token){
      let gitlabCursor=0;
      const withoutBranches=gitTargets.filter(item=>!(gitResults.get(item.key)||[]).length),withBranches=gitTargets.filter(item=>(gitResults.get(item.key)||[]).length>0),gitlabCandidates=[...withoutBranches,...withBranches],gitlabQueue=gitlabCandidates.slice(0,10);gitlabSkipped=Math.max(0,gitlabCandidates.length-gitlabQueue.length);
      for(const item of gitlabQueue)gitlabStatus.set(item.key,'checking');
      for(const item of gitlabCandidates.slice(10))gitlabStatus.set(item.key,'skipped');
      async function readGitlab(){for(;;){const index=gitlabCursor++;if(index>=gitlabQueue.length)return;const item=gitlabQueue[index];try{const found=await gitlabIssueBranches(item.key);if(found.status==='ok'&&found.repositories.length){const existing=gitResults.get(item.key)||[];const merged=new Map([...existing,...found.repositories].map(repo=>[repo.name,repo]));gitResults.set(item.key,[...merged.values()]);gitlabStatus.set(item.key,'found');}else gitlabStatus.set(item.key,'no-match')}catch{gitlabErrors++;gitlabStatus.set(item.key,'error')}}}
      await Promise.all(Array.from({length:Math.min(2,gitlabQueue.length)},readGitlab));
    }
    const value = {
      issue: { key: parent.key, summary: parentFields.summary || '', project: parentFields.project?.key || '', type: parentFields.issuetype?.name || '', status: parentFields.status?.name || '', assignee: parentFields.assignee?.displayName || 'Не назначен', updated: parentFields.updated || '', fixVersions: (parentFields.fixVersions || []).map(version => version.name), gitRepositories: gitFor(parent.key), gitlabStatus:gitlabStatus.get(parent.key)||'not-configured', url: `${connection.base}/browse/${encodeURIComponent(parent.key)}` },
      related: relatedKeys.filter(issueKey => issueMap.has(issueKey)).map(issueKey => {
        const issue = issueMap.get(issueKey), fields = issue.fields || {};
        return { key: issueKey, summary: fields.summary || '', status: fields.status?.name || '', type: fields.issuetype?.name || '', priority: fields.priority?.name || '', assignee: fields.assignee?.displayName || 'Не назначен', updated: fields.updated || '', fixVersions: (fields.fixVersions || []).map(version => version.name), gitRepositories: gitFor(issueKey), gitlabStatus:gitlabStatus.get(issueKey)||'not-configured', relations: related.get(issueKey).relations, url: `${connection.base}/browse/${encodeURIComponent(issueKey)}` };
      }),
      inaccessibleCount: relatedKeys.filter(issueKey => !issueMap.has(issueKey)).length,
      truncated: related.size > 100,
      gitErrors,
      gitSkipped,
      gitlabConfigured:Boolean(gitlabConnection.base&&gitlabConnection.token),
      gitlabErrors,
      gitlabSkipped,
      fetchedAt: new Date().toISOString()
    };
    releaseCache.set(cacheKey, { at: Date.now(), value });
    if (releaseCache.size > 20) releaseCache.delete(releaseCache.keys().next().value);
    return value;
  })();
  releasePending.set(cacheKey, pending);
  try { return await pending; }
  finally { releasePending.delete(cacheKey); }
}
const listenPort = Number(process.env.LK_PORT || 18764);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Некорректный LK_PORT.');
const server = http.createServer(async (req, res) => {
  if (![ `127.0.0.1:${listenPort}`, `localhost:${listenPort}` ].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const url = new URL(req.url, `http://127.0.0.1:${listenPort}`);
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  if (req.method === 'GET' && url.pathname === '/api/investigation') {
    const supplied = Buffer.from(String(req.headers['x-csrf-token'] || ''));
    if (supplied.length !== csrf.length || !timingSafeEqual(supplied, Buffer.from(csrf))) return json(403,{error:'Перезагрузи страницу и повтори поиск.'});
    const kind = url.searchParams.get('kind') || '';
    const number = url.searchParams.get('number') || '';
    const minutes = Number(url.searchParams.get('minutes') || 180);
    if (!['request','notice'].includes(kind) || number.length > 120 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return json(400,{error:'Проверь вид карточки, номер и окно логов.'});
    if (investigationBusy) return json(429,{error:'Предыдущий разбор ещё выполняется. Подожди его завершения.'});
    investigationBusy = true;
    try { return json(200, await investigate({kind,number,minutes,connection:profile})); }
    catch(error) { return json(400,{error:error.message}); }
    finally { investigationBusy = false; }
  }
  if (req.method === 'POST' && ['/api/calendar/login','/api/calendar/logout'].includes(url.pathname)) {
    const supplied=Buffer.from(String(req.headers['x-csrf-token']||''));
    if(req.headers.origin!==`http://${req.headers.host}`||supplied.length!==csrf.length||!timingSafeEqual(supplied,Buffer.from(csrf)))return json(403,{error:'Перезагрузи страницу и повтори действие.'});
    if(calendarBusy)return json(409,{error:'Предыдущий запрос календаря ещё выполняется.'});
    if(url.pathname==='/api/calendar/logout'){calendarSession=null;return json(200,{connected:false})}
    if(!String(req.headers['content-type']).startsWith('application/json'))return json(415,{error:'Ожидается JSON.'});
    let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>12000)return json(413,{error:'Слишком большой запрос.'});chunks.push(chunk)}
    let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return json(400,{error:'Некорректные данные входа.'})}
    let login,month;
    try{login=validateLogin(input);month=String(input.month||'');calendarRange(month)}catch(error){return json(400,{error:error.message})}
    calendarBusy=true;
    try{
      const ewsUrl=await discoverCalendar(login),session={...login,ewsUrl};
      const result=await readCalendar(session,month);
      calendarSession=session;
      return json(200,{...result,calendarEmail:login.email});
    }catch(error){return json(502,{error:error.message})}
    finally{calendarBusy=false}
  }
  if (req.method === 'POST' && url.pathname === '/api/profile') {
    const supplied=Buffer.from(String(req.headers['x-csrf-token']||''));
    if(req.headers.origin !== `http://${req.headers.host}` || supplied.length!==csrf.length || !timingSafeEqual(supplied,Buffer.from(csrf)))return json(403,{error:'Перезагрузи страницу и повтори сохранение.'});
    if(!String(req.headers['content-type']).startsWith('application/json'))return json(415,{error:'Ожидается JSON.'});
    if(savingProfile)return json(409,{error:'Настройки уже сохраняются.'});
    savingProfile=true;
    try {
      let bytes=0, chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>16000)return json(413,{error:'Слишком большой запрос.'});chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'Некорректные настройки.'});}
      const newToken=String(input.token||'').trim();
      if(!newToken && !profile.token)return json(400,{error:'Введи токен Jira.'});
      if(newToken.length>8000 || /[\r\n]/.test(newToken))return json(400,{error:'Некорректный токен.'});
      const candidate={...profile,base:profile.base,token:newToken||profile.token,account:profile.account};
      if(newToken||!profile.account){
        let account;
        try { account=await jira('/rest/api/2/myself',undefined,candidate); }
        catch(error){return json(400,{error:error.message.startsWith('Нет доступа')?error.message:'Не удалось подключиться к Jira. Проверь адрес, сеть и токен.'});}
        if(!account.name)return json(400,{error:'Jira не вернула логин владельца токена.'});
        candidate.account={username:account.name,displayName:account.displayName||account.name};
      }
      const suppliedGitlabToken=String(input.gitlabToken||'').trim();
      const suppliedGitlabBase=String(input.gitlabBaseUrl||'').trim();
      const gitlabBase=suppliedGitlabBase.replace(/\/$/,'')||candidate.gitlabBaseUrl||process.env.LK_GITLAB_BASE_URL||'';
      const gitlabToken=suppliedGitlabToken||candidate.gitlabToken||process.env.LK_GITLAB_TOKEN||'';
      if(suppliedGitlabToken.length>8000||/[\r\n]/.test(suppliedGitlabToken))return json(400,{error:'Некорректный токен GitLab.'});
      if(suppliedGitlabBase){let parsed;try{parsed=new URL(gitlabBase)}catch{return json(400,{error:'Укажи корректный адрес GitLab, например https://gitlab.example.com.'});}if(parsed.protocol!=='https:'||parsed.username||parsed.password)return json(400,{error:'Адрес GitLab должен начинаться с https:// и не содержать логин или пароль.'});}
      if(suppliedGitlabToken){
        if(!gitlabBase)return json(400,{error:'Сначала укажи адрес GitLab.'});
        try{const response=await fetch(new URL('/api/v4/user',gitlabBase),{headers:{'PRIVATE-TOKEN':suppliedGitlabToken,Accept:'application/json'},redirect:'error',dispatcher,signal:AbortSignal.timeout(10000)});if(!response.ok)return json(400,{error:response.status===401||response.status===403?'GitLab не принял токен или не хватает прав read_api.':'Не удалось проверить доступ к GitLab (HTTP '+response.status+').'});const identity=await response.json();if(!identity.username)return json(400,{error:'GitLab не вернул пользователя токена.'});}catch(error){return json(400,{error:error.message.startsWith('GitLab')?error.message:'Не удалось подключиться к GitLab. Проверь адрес, сеть и сертификат.'});}
      }
      candidate.gitlabBaseUrl=gitlabBase;candidate.gitlabToken=gitlabToken;
      const pgHost=String(input.pgHost||'').trim(),pgUser=String(input.pgUser||'').trim(),pgPassword=String(input.pgPassword||''),kubeconfig=String(input.kubeconfig||'').trim();
      if(pgHost&&!/^[a-z0-9.-]{1,253}$/i.test(pgHost)||pgUser&&!/^[a-z0-9_.@-]{1,128}$/i.test(pgUser)||pgPassword.length>8000||/[\r\n]/.test(pgPassword)||kubeconfig.length>500||/[\r\n]/.test(kubeconfig))return json(400,{error:'Проверь адрес и учётную запись БД, пароль и путь к kubeconfig.'});
      candidate.pgHost=pgHost||candidate.pgHost||'';candidate.pgUser=pgUser||candidate.pgUser||'';candidate.pgPassword=pgPassword||candidate.pgPassword||'';candidate.kubeconfig=kubeconfig||candidate.kubeconfig||'';
      if((candidate.pgPassword||process.env.LK_PG_PASSWORD)&&(pgPassword||pgHost||pgUser)){try{await checkDatabaseConnection(candidate)}catch{return json(400,{error:'Не удалось подключиться к read-only БД. Проверь адрес, логин, пароль и сеть.'})}}
      try{await saveProfile(candidate);}catch{return json(500,{error:'Не удалось сохранить профиль на этом компьютере.'});}
      profile=candidate;states.clear();calendarSession=null;
      releaseCache.clear();
      gitlabCache.clear();
      standCache=null;projectCache=null;
      return json(200,publicProfile());
    } catch { return json(400,{error:'Не удалось сохранить профиль.'}); }
    finally { savingProfile=false; }
  }
  if(req.method==='POST'&&url.pathname==='/api/release-links'){
    const supplied=Buffer.from(String(req.headers['x-csrf-token']||''));
    if(req.headers.origin!==`http://${req.headers.host}`||supplied.length!==csrf.length||!timingSafeEqual(supplied,Buffer.from(csrf)))return json(403,{error:'Перезагрузи страницу и повтори действие.'});
    if(!String(req.headers['content-type']).startsWith('application/json'))return json(415,{error:'Ожидается JSON.'});
    let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>64000)return json(413,{error:'Слишком большой запрос.'});chunks.push(chunk)}
    let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return json(400,{error:'Некорректный запрос.'})}
    const key=String(input.key||'').trim().toUpperCase(),versionId=String(input.versionId||''),issueKeys=[...new Set((Array.isArray(input.issueKeys)?input.issueKeys:[]).map(value=>String(value).trim().toUpperCase()))],labels=[...new Set((Array.isArray(input.labels)?input.labels:[]).map(value=>String(value).trim()).filter(Boolean))];
    if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)||!/^\d+$/.test(versionId)||!issueKeys.length||issueKeys.length>500||issueKeys.some(value=>!/^[A-Z][A-Z0-9_]*-\d+$/.test(value)))return json(400,{error:'Проверь ключ релиза, версию и список задач.'});
    try{
      const builder=await getReleaseBuilder(key,profile),version=builder.versions.find(item=>item.id===versionId);if(!version)return json(400,{error:'Эта версия не относится к проекту релиза.'});
      if(!builder.relation)return json(400,{error:'В Jira не найден тип связи «relates to». Связи не созданы.'});
      const candidates=await getVersionIssues(builder.issue.project,versionId,profile),byKey=new Map(candidates.issues.map(issue=>[issue.key,issue]));
      for(const issueKey of issueKeys){const candidate=byKey.get(issueKey);if(!candidate||issueKey===key||labels.length&&!candidate.labels.some(label=>labels.includes(label)))return json(400,{error:`Задача ${issueKey} не входит в выбранный состав версии и меток.`})}
      const linked=new Set(builder.linkedKeys),created=[],skipped=[],failed=[];
      for(const issueKey of issueKeys){if(linked.has(issueKey)){skipped.push(issueKey);continue}try{await jira('/rest/api/2/issueLink',{type:{name:builder.relation.name},inwardIssue:{key},outwardIssue:{key:issueKey}},profile);created.push(issueKey)}catch{failed.push(issueKey)}}
      releaseCache.clear();
      return json(failed.length?207:200,{created,skipped,failed,relation:builder.relation.inward});
    }catch(error){const tls=tlsFailure(error);return json(error.message.startsWith('Нет доступа')?403:502,{error:tls||(error.message.startsWith('Нет доступа')||error.message.startsWith('Jira:')||error.message.startsWith('У релизной')?error.message:'Не удалось связать задачи. Проверь доступ к Jira.')})}
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/api/config') return json(200,publicProfile());
  if (url.pathname === '/api/stands') {
    if(!projectCache||Date.now()-projectCache.at>=900000)void gitlabProjects();
    const snapshot=await currentStands();
    const connection=getGitLabConnection();
    const projects=projectCache?.projects;
    const data=projects?attachGitProjects(snapshot,projects,connection.base):snapshot;
    return json(200,{...data,gitlab:!connection.base||!connection.token?'not-configured':projects?'matched':projectPending?'loading':'unavailable'});
  }
  if (url.pathname === '/api/calendar/attendees') {
    if(!calendarSession)return json(409,{error:'Сначала войди в календарь Exchange.'});
    let id;try{id=validateCalendarItemId(url.searchParams.get('id')||'')}catch(error){return json(400,{error:error.message})}
    if(calendarBusy)return json(429,{error:'Календарь уже загружается.'});
    calendarBusy=true;
    try{return json(200,await readCalendarAttendees(calendarSession,id))}
    catch(error){return json(502,{error:error.message})}
    finally{calendarBusy=false}
  }
  if (url.pathname === '/api/calendar') {
    if(!calendarSession)return json(409,{error:'Сначала войди в календарь Exchange.'});
    const month=url.searchParams.get('month')||'';
    let mailbox;try{calendarRange(month);mailbox=validateCalendarMailbox(url.searchParams.get('mailbox')||calendarSession.email)}catch(error){return json(400,{error:error.message})}
    if(calendarBusy)return json(429,{error:'Календарь уже загружается.'});
    calendarBusy=true;
    try{return json(200,await readCalendar(calendarSession,month,mailbox))}
    catch(error){return json(502,{error:error.message})}
    finally{calendarBusy=false}
  }
  if (url.pathname === '/api/my-bugs') {
    if (!profile.token) return json(409,{error:'Добавь токен в настройках профиля.'});
    const startAt=Number(url.searchParams.get('startAt') || 0);
    if (!Number.isSafeInteger(startAt) || startAt < 0 || startAt > 100000) return json(400,{error:'Некорректная страница списка.'});
    const connection=profile;
    try {
      const result=await getCreatedBugs(startAt,connection);
      if (connection!==profile) return json(409,{error:'Профиль изменён. Обнови список.'});
      return json(200,result);
    } catch(error) {
      const tls=tlsFailure(error);
      return json(error.message.startsWith('Нет доступа')?403:502,{error:tls || (/^(Jira:|Нет доступа|В Jira|Jira не|Jira вернула)/.test(error.message)?error.message:'Не удалось загрузить созданные баги. Проверь подключение к Jira.')});
    }
  }
  if(url.pathname==='/api/release-builder'){
    if(!profile.token)return json(409,{error:'Добавь токен в настройках профиля.'});
    const key=(url.searchParams.get('key')||'').trim().toUpperCase();if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))return json(400,{error:'Введи ключ релизной задачи.'});
    try{return json(200,await getReleaseBuilder(key,profile))}catch(error){const tls=tlsFailure(error);return json(error.message.startsWith('Нет доступа')?403:502,{error:tls||(error.message.startsWith('Нет доступа')||error.message.startsWith('Jira:')||error.message.startsWith('У релизной')?error.message:'Не удалось загрузить версии проекта. Проверь ключ и доступ к Jira.')})}
  }
  if(url.pathname==='/api/release-candidates'){
    if(!profile.token)return json(409,{error:'Добавь токен в настройках профиля.'});
    const key=(url.searchParams.get('key')||'').trim().toUpperCase(),versionId=url.searchParams.get('versionId')||'';if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)||!/^\d+$/.test(versionId))return json(400,{error:'Проверь релиз и выбранную версию.'});
    try{const builder=await getReleaseBuilder(key,profile);if(!builder.versions.some(version=>version.id===versionId))return json(400,{error:'Версия не относится к проекту релиза.'});const result=await getVersionIssues(builder.issue.project,versionId,profile);return json(200,{...result,linkedKeys:builder.linkedKeys,issue:builder.issue})}catch(error){const tls=tlsFailure(error);return json(error.message.startsWith('Нет доступа')?403:502,{error:tls||(error.message.startsWith('Нет доступа')||error.message.startsWith('Jira:')?error.message:'Не удалось загрузить задачи версии.')})}
  }
  if (url.pathname === '/api/users') {
    if(!profile.token)return json(409,{error:'Добавь токен в настройках профиля.'});
    const query=(url.searchParams.get('query')||'').trim();
    if(query.length<2)return json(200,{users:[]});
    if(query.length>100||/[\x00-\x1f]/u.test(query))return json(400,{error:'Слишком длинный или некорректный поисковый запрос.'});
    const connection=profile;
    try {
      const result=await jira('/rest/api/2/user/picker?query='+encodeURIComponent(query)+'&maxResults=15',undefined,connection);
      if(connection!==profile)return json(409,{error:'Профиль изменён. Повтори поиск.'});
      const users=(result.users||[]).filter(u=>u.name).map(u=>({username:u.name,displayName:u.displayName||u.name}));
      return json(200,{users});
    }catch(error){return json(502,{error:error.message.startsWith('Нет доступа')?error.message:'Не удалось найти пользователей в Jira. Проверь сеть и права на поиск пользователей.'});}
  }
  if (url.pathname === '/api/state') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if(!profile.token)return json(409,{error:'Добавь токен в настройках профиля.'});
    const username = (url.searchParams.get('user') || '').trim();
    if (!username || username.length > 120 || /[\s"\\\x00-\x1f]/u.test(username)) { res.writeHead(400); return res.end(JSON.stringify({error:'Выбери пользователя из списка.'})); }
    const state = getState(username);
    if (!state) { res.writeHead(429); return res.end(JSON.stringify({error:'Слишком много запросов. Повтори позже.'})); }
    return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/api/release') {
    if(!profile.token)return json(409,{error:'Добавь токен в настройках профиля.'});
    const key=(url.searchParams.get('key')||'').trim().toUpperCase();
    if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))return json(400,{error:'Введи ключ Jira, например ECP-6376.'});
    try{return json(200,await getReleaseSnapshot(key,profile));}
    catch(error){const tls=tlsFailure(error);return json(error.message.startsWith('Нет доступа')?403:502,{error:tls|| (error.message.startsWith('Нет доступа')||error.message.startsWith('Jira:')?error.message:'Не удалось загрузить релизную задачу. Проверь ключ, права Jira и соединение.')});}
  }
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end('{"app":"jira-board"}'); }
  if (req.url === '/') { try { const html=await readFile(new URL('./index.html', import.meta.url)); res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); } catch { res.writeHead(500); return res.end(); } }
  res.writeHead(404); res.end();
});
server.on('error', () => process.exit(1));
server.listen(listenPort, process.env.LK_LISTEN_HOST || '127.0.0.1', () => {
  setInterval(() => {
    for (const state of states.values()) {
      if (Date.now() - lastAccess.get(state) > 300000) { if (!state.refreshing) states.delete(state.user); continue; }
      if (Date.now() - (refreshTimes.get(state) || 0) >= 60000) void refresh(state);
    }
  }, 5000);
});
