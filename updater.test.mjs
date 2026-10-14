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
  const gitCommand = async (_command, args) => ({
    'ls-remote': `${'b'.repeat(40)}\trefs/heads/main`,
    'rev-parse': 'a'.repeat(40),
    status: ' M index.html',
    fetch: '',
    show: JSON.stringify({ version: '1.26.0' })
  })[args[0]];
  const info = await readUpdateInfo({ currentVersion: '1.25.1', cwd: '.', mode: 'git', gitCommand });
  assert.equal(info.available, true);
  assert.equal(info.canInstall, false);
  assert.match(info.reason, /локальные изменения/);
});
