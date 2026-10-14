import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dockerHub = 'https://hub.docker.com/v2/repositories/almooooooo/taskboard/tags?page_size=100';
const versionPattern = /^\d+\.\d+\.\d+$/;

export function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function readJson(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Taskboard-update-check' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Источник обновлений ответил HTTP ${response.status}.`);
  return response.json();
}

async function git(command, args, cwd) {
  const result = await execFileAsync(command, ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args], { cwd, timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

export async function readUpdateInfo({ currentVersion, cwd, mode = process.platform === 'win32' ? 'git' : 'docker', fetcher = fetch, gitCommand = git }) {
  if (mode === 'docker') {
    const data = await readJson(dockerHub, fetcher);
    const versions = (data.results || []).map(tag => tag.name).filter(name => versionPattern.test(name));
    if (!versions.length) throw new Error('В Docker Hub пока нет опубликованных версий Taskboard.');
    versions.sort(compareVersions);
    const latestVersion = versions.at(-1);
    return { mode, currentVersion, latestVersion, available: compareVersions(latestVersion, currentVersion) > 0,
      source: 'Docker Hub', canInstall: false, reason: '' };
  }
  if (mode !== 'git') throw new Error('Неизвестный режим установки.');
  const [remoteRef, localCommit, status] = await Promise.all([
    gitCommand('git', ['ls-remote', 'origin', 'refs/heads/main'], cwd),
    gitCommand('git', ['rev-parse', 'HEAD'], cwd),
    gitCommand('git', ['status', '--porcelain'], cwd)
  ]);
  const remoteCommit = remoteRef.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/)?.[1];
  if (!remoteCommit) throw new Error('GitHub не вернул ветку main.');
  let latestVersion = currentVersion;
  if (remoteCommit !== localCommit) {
    await gitCommand('git', ['fetch', '--no-tags', 'origin', 'main'], cwd);
    const remotePackage = JSON.parse(await gitCommand('git', ['show', `${remoteCommit}:package.json`], cwd));
    latestVersion = remotePackage.version;
  }
  if (!versionPattern.test(latestVersion)) throw new Error('Источник вернул некорректную версию.');
  const available = localCommit !== remoteCommit && compareVersions(latestVersion, currentVersion) >= 0;
  return { mode, currentVersion, latestVersion, available, source: 'GitHub main', canInstall: available && !status,
    reason: status ? 'В папке есть локальные изменения. Сначала сохрани их в Git: автоматическое обновление их не затронет.' :
      localCommit !== remoteCommit && !available ? 'Удалённая ветка старше установленной версии.' : '',
    localCommit, remoteCommit };
}
