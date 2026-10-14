import { LK_SERVICES } from './stands.mjs';

const serviceByPath = new Map(LK_SERVICES.map(service => [service.path.toLowerCase(), service.name]));
const rank = { opened: 0, unknown: 1, merged: 2, closed: 3, locked: 4 };

export function mentionsIssueKey(text, key) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return false;
  return new RegExp('(^|[^A-Z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Z0-9])', 'i').test(String(text || ''));
}

export function branchBelongsToIssue(branch, key) {
  const keys = String(branch || '').match(/[A-Z][A-Z0-9_]*-\d+/gi) || [];
  return !keys.length || keys.some(found => found.toUpperCase() === key);
}

function repositoryPath(repository) {
  return String(repository?.name || '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
}

function branchName(branch) { return String(branch?.name || '').trim(); }

export function summarizeTaskGit(jiraRepositories, gitlabRepositories, gitlabStatus = 'not-configured') {
  const services = new Map();
  const ensure = repository => {
    const path = repositoryPath(repository);
    if (!path || !serviceByPath.has(path.toLowerCase())) return null;
    const key = path.toLowerCase();
    if (!services.has(key)) services.set(key, { path, name: serviceByPath.get(key) || path.split('/').at(-1), jira: new Map(), mergeRequests: new Map() });
    return services.get(key);
  };
  for (const repository of jiraRepositories || []) {
    const service = ensure(repository);
    if (!service) continue;
    for (const branch of repository.branches || []) {
      const name = branchName(branch);
      if (name) service.jira.set(name, { name, url: String(branch.url || ''), state: 'unknown', targetBranch: '' });
    }
  }
  for (const repository of gitlabRepositories || []) {
    const service = ensure(repository);
    if (!service) continue;
    for (const branch of repository.branches || []) {
      const name = branchName(branch);
      if (!name) continue;
      const state = ['opened', 'merged', 'closed', 'locked'].includes(branch.mergeState) ? branch.mergeState : 'unknown';
      const targetBranch = String(branch.targetBranch || '').trim();
      const key = JSON.stringify([name, state, targetBranch]);
      if (!service.mergeRequests.has(key)) service.mergeRequests.set(key, { name, url: String(branch.url || ''), state, targetBranch });
    }
  }
  return {
    gitlabStatus,
    services: [...services.values()].map(service => {
      const withMr = new Set([...service.mergeRequests.values()].map(branch => branch.name));
      const branches = [...service.mergeRequests.values(), ...[...service.jira.values()].filter(branch => !withMr.has(branch.name))]
        .sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || a.name.localeCompare(b.name, 'ru'));
      return { name: service.name, path: service.path, branches };
    }).filter(service => service.branches.length).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  };
}
