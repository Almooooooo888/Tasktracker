import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';

const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const stateDir = process.env.UPDATER_STATE_DIR || '/updater-state';
const workspace = process.env.UPDATER_WORKSPACE || '/workspace';
const service = 'jira-board';
const repository = 'almooooooo/taskboard';
const versionPattern = /^\d+\.\d+\.\d+$/;
const statusPath = `${stateDir}/status.json`;
const tokenPath = `${stateDir}/token`;
let busy = false;
let token;

function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ socketPath, method, path, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Docker HTTP ${res.statusCode}: ${raw.slice(0, 250)}`));
        try { resolve(raw ? JSON.parse(raw) : null); }
        catch {
          for (const line of raw.split('\n')) {
            try { const item = JSON.parse(line); if (item.error) return reject(new Error(String(item.error).slice(0, 250))); } catch (error) { if (error instanceof SyntaxError) continue; return reject(error); }
          }
          resolve(raw);
        }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Docker не ответил за две минуты.')));
    req.on('error', reject);
    req.end(payload);
  });
}

export function nextEnv(previous, image) {
  const lines = previous.split(/\r?\n/).filter(line => !/^TASKBOARD_IMAGE=/.test(line));
  while (lines.at(-1) === '') lines.pop();
  lines.push(`TASKBOARD_IMAGE=${image}`);
  return lines.join('\n') + '\n';
}

export function cloneCreateBody(inspect, image) {
  const config = { ...inspect.Config, Image: image, HostConfig: inspect.HostConfig };
  const endpoints = {};
  for (const [name, endpoint] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
    endpoints[name] = { Aliases: endpoint.Aliases || [] };
  }
  if (Object.keys(endpoints).length) config.NetworkingConfig = { EndpointsConfig: endpoints };
  return config;
}

async function state(stage, message) {
  await writeFile(`${statusPath}.tmp`, JSON.stringify({ stage, message, checkedAt: new Date().toISOString() }));
  await rename(`${statusPath}.tmp`, statusPath);
}

async function currentContainer() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${service}`] }));
  const entries = await docker('GET', `/containers/json?all=1&filters=${filters}`);
  const running = entries.filter(item => item.State === 'running');
  if (running.length !== 1) throw new Error('Ожидался один работающий контейнер Taskboard.');
  const inspect = await docker('GET', `/containers/${running[0].Id}/json`);
  return inspect;
}

async function waitForVersion(version) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const config = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: 'jira-board', port: 18764, path: '/api/config', headers: { Host: '127.0.0.1:18764' } }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (error) { reject(error); } });
        });
        req.setTimeout(2000, () => req.destroy(new Error('Taskboard не ответил.')));
        req.on('error', reject);
      });
      if (config?.version === version) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function install(version, verifyVersion = waitForVersion) {
  const image = `${repository}:${version}`;
  let oldEnv, old, oldName, backupName, newId, stopped = false, renamed = false;
  try {
    oldEnv = await readFile(`${workspace}/.env`, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    await state('running', 'Скачиваю Docker-образ.');
    await docker('POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(version)}`);
    await docker('GET', `/images/${encodeURIComponent(image)}/json`);
    old = await currentContainer();
    oldName = old.Name.replace(/^\//, '');
    backupName = `${oldName}-rollback-${Date.now()}`;
    await state('running', 'Перезапускаю Taskboard.');
    await docker('POST', `/containers/${old.Id}/stop?t=10`);
    stopped = true;
    await docker('POST', `/containers/${old.Id}/rename?name=${encodeURIComponent(backupName)}`);
    renamed = true;
    const created = await docker('POST', `/containers/create?name=${encodeURIComponent(oldName)}`, cloneCreateBody(old, image));
    newId = created.Id;
    await docker('POST', `/containers/${newId}/start`);
    if (!await verifyVersion(version)) throw new Error('Новая версия не ответила после запуска.');
    await writeFile(`${workspace}/.env`, nextEnv(oldEnv || '', image));
    try { await docker('DELETE', `/containers/${old.Id}?force=1`); }
    catch { /* A stopped backup may remain; the new version is already running. */ }
    await state('done', `Установлена версия ${version}. Страница перезагрузится.`);
  } catch (error) {
    let message = error.message;
    if (stopped) {
      try {
        if (newId) await docker('DELETE', `/containers/${newId}?force=1`);
        if (renamed) await docker('POST', `/containers/${old.Id}/rename?name=${encodeURIComponent(oldName)}`);
        await docker('POST', `/containers/${old.Id}/start`);
        if (oldEnv === null) await unlink(`${workspace}/.env`).catch(e => { if (e.code !== 'ENOENT') throw e; });
        else await writeFile(`${workspace}/.env`, oldEnv);
        message += ' Прежняя версия восстановлена.';
      } catch { message += ' Откат не удался; проверь Docker-контейнеры.'; }
    }
    await state('error', message);
  } finally { busy = false; }
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

export async function startUpdater(port = 18765, verifyVersion = waitForVersion) {
  await mkdir(stateDir, { recursive: true });
  try { token = (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o644, flag: 'wx' });
  }
  const server = http.createServer(async (req, res) => {
    if (req.headers['x-updater-token'] !== token) return send(res, 403, { error: 'Нет доступа.' });
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { app: 'taskboard-docker-updater' });
    if (req.method === 'GET' && req.url === '/status') {
      try { return send(res, 200, JSON.parse(await readFile(statusPath, 'utf8'))); }
      catch { return send(res, 200, { stage: 'idle' }); }
    }
    if (req.method === 'POST' && req.url === '/install') {
      if (busy) return send(res, 409, { error: 'Обновление уже выполняется.' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 512) return send(res, 400, { error: 'Слишком большой запрос.' });
      }
      let version;
      try { version = JSON.parse(body).version; } catch { return send(res, 400, { error: 'Некорректный запрос.' }); }
      if (typeof version !== 'string' || !versionPattern.test(version)) return send(res, 400, { error: 'Некорректная версия.' });
      busy = true;
      try { await state('running', 'Начинаю обновление.'); }
      catch { busy = false; return send(res, 500, { error: 'Не удалось сохранить состояние обновления.' }); }
      void install(version, verifyVersion);
      return send(res, 202, { message: 'Обновление запущено.' });
    }
    return send(res, 404, { error: 'Не найдено.' });
  });
  await new Promise((resolve, reject) => server.listen(port, '0.0.0.0', error => error ? reject(error) : resolve()));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) startUpdater().catch(error => { console.error(error); process.exit(1); });
