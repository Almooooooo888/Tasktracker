import test from 'node:test';
import assert from 'node:assert/strict';
import { branchBelongsToIssue, mentionsIssueKey, summarizeTaskGit } from './task-git.mjs';

test('issue key matching excludes longer Jira numbers', () => {
  assert.equal(mentionsIssueKey('fix/ECP-2570', 'ECP-257'), false);
  assert.equal(mentionsIssueKey('feature/ECP-257-check', 'ECP-257'), true);
  assert.equal(branchBelongsToIssue('bugfix/ECP-7577', 'ECP-7040'), false);
  assert.equal(branchBelongsToIssue('feature/ECP-7040', 'ECP-7040'), true);
});

test('task Git summary groups branches by LK service and deduplicates matching merged MRs', () => {
  const jira = [{ name: 'digital/frontend/digital-ui', branches: [{ name: 'feat/ECP-5242', url: 'https://git/branch' }] }];
  const gitlab = [{ name: 'digital/frontend/digital-ui', branches: [
    { name: 'feat/ECP-5242', mergeState: 'merged', targetBranch: 'main', url: 'https://git/mr/1' },
    { name: 'feat/ECP-5242', mergeState: 'merged', targetBranch: 'main', url: 'https://git/mr/2' }
  ] }];
  const result = summarizeTaskGit(jira, gitlab, 'found');
  assert.equal(result.services[0].name, 'digital-ui (FE)');
  assert.deepEqual(result.services[0].branches.map(({ name, state, targetBranch }) => ({ name, state, targetBranch })), [
    { name: 'feat/ECP-5242', state: 'merged', targetBranch: 'main' }
  ]);
});

test('task Git summary does not call a release merge into main and keeps unmatched Jira branches visible', () => {
  const jira = [{ name: 'digital/backend/audit-portal', branches: [{ name: 'feature/ECP-7000' }, { name: 'fix/ECP-7000' }] }];
  const gitlab = [{ name: 'digital/backend/audit-portal', branches: [{ name: 'feature/ECP-7000', mergeState: 'merged', targetBranch: 'release/1.2' }] }];
  const branches = summarizeTaskGit(jira, gitlab).services[0].branches;
  assert.equal(branches.length, 2);
  assert.equal(branches.find(branch => branch.name === 'feature/ECP-7000').targetBranch, 'release/1.2');
  assert.equal(branches.find(branch => branch.name === 'fix/ECP-7000').state, 'unknown');
});

test('task Git summary keeps absent evidence absent', () => {
  assert.deepEqual(summarizeTaskGit([], [], 'error'), { gitlabStatus: 'error', services: [] });
  assert.deepEqual(summarizeTaskGit([], [{ name: 'digital/qa/audit-portal', branches: [{ name: 'feature/ECP-257' }] }]).services, []);
});
