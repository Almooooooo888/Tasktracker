import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextEnv, cloneCreateBody } from './docker-updater.mjs';

test('Docker update preserves unrelated environment and replaces the image once', () => {
  assert.equal(nextEnv('LK_JIRA_BASE_URL=https://jira.example.com\nTASKBOARD_IMAGE=old/image:1.0.0\nLK_GITLAB_TOKEN=\n', 'almooooooo/taskboard:1.27.0'),
    'LK_JIRA_BASE_URL=https://jira.example.com\nLK_GITLAB_TOKEN=\nTASKBOARD_IMAGE=almooooooo/taskboard:1.27.0\n');
});

test('Docker update recreates the app with its mounts, port, labels and network aliases', () => {
  const old = {
    Config: { Image: 'almooooooo/taskboard:1.26.0', Env: ['LK_INSTALL_MODE=docker'], Labels: { 'com.docker.compose.service': 'jira-board' } },
    HostConfig: { Binds: ['profile:/data:rw'], PortBindings: { '18764/tcp': [{ HostIp: '127.0.0.1', HostPort: '18764' }] }, NetworkMode: 'project_default' },
    NetworkSettings: { Networks: { project_default: { Aliases: ['jira-board'] }, project_updater: { Aliases: ['jira-board'] } } }
  };
  const next = cloneCreateBody(old, 'almooooooo/taskboard:1.27.0');
  assert.equal(next.Image, 'almooooooo/taskboard:1.27.0');
  assert.deepEqual(next.HostConfig, old.HostConfig);
  assert.deepEqual(next.Config, undefined);
  assert.deepEqual(next.NetworkingConfig.EndpointsConfig.project_updater.Aliases, ['jira-board']);
  assert.equal(old.Config.Image, 'almooooooo/taskboard:1.26.0');
});

test('Docker update restores the previous container when creation fails', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'taskboard-updater-'));
  const socketPath = `\\\\.\\pipe\\taskboard-updater-${process.pid}-${Date.now()}`;
  const calls = [];
  const old = {
    Id: 'old-container', Name: '/taskboard-jira-board-1',
    Config: { Image: 'almooooooo/taskboard:1.26.0', Env: ['LK_INSTALL_MODE=docker'] },
    HostConfig: { Binds: ['profile:/data:rw'], NetworkMode: 'taskboard_default' },
    NetworkSettings: { Networks: { taskboard_default: { Aliases: ['jira-board'] } } }
  };
  const engine = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/images/create')) return res.end('{"status":"pulled"}\n');
    if (req.url.startsWith('/images/')) return res.end('{}');
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify([{ Id: old.Id, State: 'running' }]));
    if (req.url === `/containers/${old.Id}/json`) return res.end(JSON.stringify(old));
    if (req.url.startsWith('/containers/create')) { res.statusCode = 500; return res.end('{"message":"create failed"}'); }
    res.end('{}');
  });
  let updater;
  try {
    await new Promise(resolve => engine.listen(socketPath, resolve));
    process.env.DOCKER_SOCKET = socketPath;
    process.env.UPDATER_STATE_DIR = temporary;
    process.env.UPDATER_WORKSPACE = temporary;
    await writeFile(join(temporary, '.env'), 'LK_JIRA_BASE_URL=https://jira.example.com\n');
    const { startUpdater } = await import(`./docker-updater.mjs?test=${Date.now()}`);
    updater = await startUpdater(0);
    const port = updater.address().port;
    const token = (await readFile(join(temporary, 'token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${port}/install`, { method: 'POST', headers: { 'X-Updater-Token': token }, body: JSON.stringify({ version: '1.27.0' }) });
    assert.equal(response.status, 202);
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      status = JSON.parse(await readFile(join(temporary, 'status.json'), 'utf8'));
      if (status.stage === 'error') break;
    }
    assert.equal(status.stage, 'error');
    assert.match(status.message, /Прежняя версия восстановлена/);
    assert.ok(calls.some(call => call.includes('/containers/old-container/stop')));
    assert.ok(calls.some(call => call.includes('/containers/old-container/rename?name=taskboard-jira-board-1')));
    assert.ok(calls.includes('POST /containers/old-container/start'));
    assert.equal(await readFile(join(temporary, '.env'), 'utf8'), 'LK_JIRA_BASE_URL=https://jira.example.com\n');
  } finally {
    if (updater) await new Promise(resolve => updater.close(resolve));
    await new Promise(resolve => engine.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Docker update switches image and records it for the next Compose start', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'taskboard-updater-success-'));
  const socketPath = `\\\\.\\pipe\\taskboard-success-${process.pid}-${Date.now()}`;
  const calls = [];
  const old = {
    Id: 'old-container', Name: '/taskboard-jira-board-1',
    Config: { Image: 'almooooooo/taskboard:1.26.0', Env: ['LK_INSTALL_MODE=docker'] },
    HostConfig: { Binds: ['profile:/data:rw'], NetworkMode: 'taskboard_default' },
    NetworkSettings: { Networks: { taskboard_default: { Aliases: ['jira-board'] } } }
  };
  const engine = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/images/create')) return res.end('{"status":"pulled"}\n');
    if (req.url.startsWith('/images/')) return res.end('{}');
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify([{ Id: old.Id, State: 'running' }]));
    if (req.url === `/containers/${old.Id}/json`) return res.end(JSON.stringify(old));
    if (req.url.startsWith('/containers/create')) return res.end('{"Id":"new-container"}');
    res.end('{}');
  });
  let updater;
  try {
    await new Promise(resolve => engine.listen(socketPath, resolve));
    process.env.DOCKER_SOCKET = socketPath;
    process.env.UPDATER_STATE_DIR = temporary;
    process.env.UPDATER_WORKSPACE = temporary;
    const { startUpdater } = await import(`./docker-updater.mjs?success=${Date.now()}`);
    updater = await startUpdater(0, async version => version === '1.27.0');
    const port = updater.address().port;
    const token = (await readFile(join(temporary, 'token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${port}/install`, { method: 'POST', headers: { 'X-Updater-Token': token }, body: JSON.stringify({ version: '1.27.0' }) });
    assert.equal(response.status, 202);
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      status = JSON.parse(await readFile(join(temporary, 'status.json'), 'utf8'));
      if (status.stage === 'done') break;
    }
    assert.equal(status.stage, 'done');
    assert.ok(calls.includes('POST /containers/new-container/start'));
    assert.ok(calls.includes('DELETE /containers/old-container?force=1'));
    assert.equal(await readFile(join(temporary, '.env'), 'utf8'), 'TASKBOARD_IMAGE=almooooooo/taskboard:1.27.0\n');
  } finally {
    if (updater) await new Promise(resolve => updater.close(resolve));
    await new Promise(resolve => engine.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Docker update reports measured layer bytes while the image is still downloading', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'taskboard-updater-progress-'));
  const socketPath = `\\\\.\\pipe\\taskboard-progress-${process.pid}-${Date.now()}`;
  let releasePull, notifyPull;
  const pullStarted = new Promise(resolve => { notifyPull = resolve; });
  const old = {
    Id: 'old-container', Name: '/taskboard-jira-board-1',
    Config: { Image: 'almooooooo/taskboard:1.27.1' },
    HostConfig: { NetworkMode: 'taskboard_default' },
    NetworkSettings: { Networks: { taskboard_default: { Aliases: ['jira-board'] } } }
  };
  const engine = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/images/create')) {
      res.write('{"id":"abc123","status":"Downloading","progressDetail":{"current":512,"total":1024}}\n');
      notifyPull();
      await new Promise(resolve => { releasePull = resolve; });
      return res.end('{"status":"pulled"}\n');
    }
    if (req.url.startsWith('/images/')) return res.end('{}');
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify([{ Id: old.Id, State: 'running' }]));
    if (req.url === `/containers/${old.Id}/json`) return res.end(JSON.stringify(old));
    if (req.url.startsWith('/containers/create')) return res.end('{"Id":"new-container"}');
    res.end('{}');
  });
  let updater;
  try {
    await new Promise(resolve => engine.listen(socketPath, resolve));
    process.env.DOCKER_SOCKET = socketPath;
    process.env.UPDATER_STATE_DIR = temporary;
    process.env.UPDATER_WORKSPACE = temporary;
    const { startUpdater } = await import(`./docker-updater.mjs?progress=${Date.now()}`);
    updater = await startUpdater(0, async () => true);
    const token = (await readFile(join(temporary, 'token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${updater.address().port}/install`, { method: 'POST', headers: { 'X-Updater-Token': token }, body: JSON.stringify({ version: '1.27.2' }) });
    assert.equal(response.status, 202);
    await pullStarted;
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      status = JSON.parse(await readFile(join(temporary, 'status.json'), 'utf8'));
      if (status.progress) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.phase, 'download');
    assert.deepEqual(status.progress, { scope: 'layer', activity: 'download', id: 'abc123', current: 512, total: 1024 });
    releasePull();
    for (let attempt = 0; attempt < 50; attempt++) {
      status = JSON.parse(await readFile(join(temporary, 'status.json'), 'utf8'));
      if (status.stage === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.stage, 'done');
    assert.equal(status.progress, undefined);
  } finally {
    if (releasePull) releasePull();
    if (updater) await new Promise(resolve => updater.close(resolve));
    await new Promise(resolve => engine.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
