import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, readUpdateInfo } from './updater.mjs';

test('version comparison uses numeric components', () => {
  assert.ok(compareVersions('1.26.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.26.0', '1.26.0'), 0);
});

test('Docker update selects newest published numeric tag', async () => {
  const info = await readUpdateInfo({ currentVersion: '1.25.1', mode: 'docker',
    fetcher: async () => ({ ok: true, json: async () => ({ results: [{ name: 'latest' }, { name: '1.9.0' }, { name: '1.26.0' }] }) }) });
  assert.equal(info.latestVersion, '1.26.0');
  assert.equal(info.available, true);
  assert.equal(info.canInstall, false);
});

test('Git update does not overwrite a dirty checkout', async () => {
  const fetcher = async url => ({ ok: true, json: async () => url.includes('/commits/') ? { sha: 'b'.repeat(40) } :
    { content: Buffer.from(JSON.stringify({ version: '1.26.0' })).toString('base64') } });
  const gitCommand = async (_command, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : ' M index.html';
  const info = await readUpdateInfo({ currentVersion: '1.25.1', cwd: '.', mode: 'git', fetcher, gitCommand });
  assert.equal(info.available, true);
  assert.equal(info.canInstall, false);
  assert.match(info.reason, /локальные изменения/);
});
