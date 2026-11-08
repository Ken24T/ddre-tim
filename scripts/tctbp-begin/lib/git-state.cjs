'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Stop, git, hash } = require('./process.cjs');

function rootAt(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel'], true);
  if (result.code) throw new Stop('Select a Git checkout before Begin.');
  return fs.realpathSync(result.stdout.trim());
}

function snapshot(root) {
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], true).stdout.trim() || null;
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).stdout.trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_LOG']
    .filter(name => fs.existsSync(path.resolve(root, git(root, ['rev-parse', '--git-path', name]).stdout.trim())));
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true).stdout.trim() || null;
  let ahead = null, behind = null;
  if (upstream) {
    const counts = git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], true);
    if (!counts.code) [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  }
  const configuration = hash(git(root, ['config', '--local', '--null', '--list']).stdout);
  return { root, branch, head, dirty: Boolean(status), status, operations, upstream, ahead, behind, configuration };
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function stable(root, expected) {
  const actual = snapshot(root);
  if (!same(actual, expected)) throw new Stop('Checkout changed during Begin; inspect again before any next action.');
  return actual;
}

function blocker(state) {
  if (!state.branch) return 'Detached HEAD requires a branch decision.';
  if (state.operations.length) return `Git operation in progress: ${state.operations.join(', ')}`;
  if (state.dirty) return 'Local changes are preserved; resume is paused.';
  if (state.ahead && state.behind) return 'Current branch has diverged; automatic reconciliation is refused.';
  return null;
}

function metadataTarget(root, profile) {
  const metadata = profile.repository?.handover;
  if (!metadata) return null;
  if (typeof metadata.ref !== 'string' || !metadata.ref.startsWith('refs/remotes/origin/') ||
      typeof metadata.file !== 'string' || metadata.file.includes('..') || metadata.file.startsWith('/')) {
    throw new Stop('Invalid handover metadata reference.');
  }
  const result = git(root, ['show', `${metadata.ref}:${metadata.file}`], true);
  if (result.code) return null;
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Stop('Published handover metadata is invalid.'); }
  const branch = value.branch || value.currentBranch;
  const head = value.commit || value.head || value.commitHash;
  if (typeof branch !== 'string' || !/^[a-f0-9]{40,64}$/.test(head || '') ||
      git(root, ['check-ref-format', '--branch', branch], true).code) throw new Stop('Published handover target is ambiguous or incomplete.');
  const targetRef = `refs/remotes/origin/${branch}`;
  const actual = git(root, ['rev-parse', '--verify', targetRef], true);
  if (actual.code || actual.stdout.trim() !== head) throw new Stop('Handover metadata does not match its published branch.');
  return { branch, head, ref: targetRef };
}

function switchApproved(root, state, target, options, context) {
  if (!target || target.branch === state.branch) {
    if (options['switch-to']) throw new Stop('The approved branch no longer matches a pending switch.');
    return state;
  }
  if (!options['switch-to']) return null;
  if (options['switch-to'] !== target.branch || options['expected-head'] !== state.head ||
      options['expected-target'] !== target.head || options['expected-context'] !== context) throw new Stop('Branch switch approval is stale or names a different target.');
  stable(root, state);
  const localRef = `refs/heads/${target.branch}`;
  const local = git(root, ['rev-parse', '--verify', localRef], true);
  if (!local.code && local.stdout.trim() !== target.head) throw new Stop('The local target contains different work; no branch update was attempted.');
  const worktrees = git(root, ['worktree', 'list', '--porcelain']).stdout;
  if (worktrees.includes(`branch ${localRef}\n`)) throw new Stop('The selected branch belongs to another worktree.');
  if (local.code) git(root, ['checkout', '--no-overwrite-ignore', '--track', '-b', target.branch, target.ref]);
  else git(root, ['checkout', '--no-overwrite-ignore', target.branch]);
  const final = snapshot(root);
  if (final.branch !== target.branch || final.head !== target.head || blocker(final)) throw new Stop('Switched checkout did not match its approved target.');
  return final;
}

function resume(root, profile, state, options, report) {
  const reason = blocker(state);
  if (reason) return { state: 'BLOCKED', reason };
  stable(root, state);
  const fetched = git(root, ['fetch', '--no-tags', 'origin'], true);
  if (fetched.code) return { state: 'BLOCKED', reason: 'Origin fetch failed; published freshness is unknown.' };
  report.freshness = 'origin fetched during this Begin';
  const fresh = snapshot(root);
  if (fresh.branch !== state.branch || fresh.head !== state.head || fresh.status !== state.status ||
      fresh.configuration !== state.configuration || fresh.operations.length) {
    throw new Stop('Checkout changed while fetching; resume stopped.');
  }
  const target = metadataTarget(root, profile);
  const context = hash(JSON.stringify({ root, head: fresh.head, branch: fresh.branch, configuration: fresh.configuration,
    target, profile: profile.profileHash, release: report.release }));
  const switched = switchApproved(root, fresh, target, options, context);
  if (!switched) return { state: 'APPROVAL_REQUIRED', reason: 'Published handover selects another branch.', target,
    approval: { 'switch-to': target.branch, 'expected-head': fresh.head, 'expected-target': target.head, 'expected-context': context } };
  const blocked = blocker(switched);
  if (blocked) return { state: 'BLOCKED', reason: blocked };
  if (!switched.upstream) return { state: 'BLOCKED', reason: 'Current branch has no verified upstream.' };
  if (!switched.upstream.startsWith('origin/')) return { state: 'BLOCKED', reason: 'Begin only synchronises the declared origin upstream.' };
  const exact = git(root, ['rev-parse', '--verify', switched.upstream]).stdout.trim();
  verifyPublished(root, switched.upstream, exact);
  if (switched.behind) {
    if (switched.ahead) return { state: 'BLOCKED', reason: 'Current branch has diverged.' };
    stable(root, switched);
    git(root, ['merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', exact]);
    report.actions.push({ kind: 'fast-forward', branch: switched.branch, from: switched.head, to: exact });
    const final = snapshot(root);
    if (final.branch !== switched.branch || final.head !== exact || blocker(final)) throw new Stop('Fast-forward result did not match the verified target.');
  }
  const final = snapshot(root);
  verifyPublished(root, final.upstream, exact);
  return { state: final.ahead ? 'LOCAL_ONLY' : 'READY', head: final.head, branch: final.branch, ahead: final.ahead,
    reason: final.ahead ? 'Current branch is ahead; local work was preserved without publication.' : 'Current branch is verified against its fetched upstream.' };
}

function verifyPublished(root, upstream, expected) {
  if (!upstream?.startsWith('origin/')) throw new Stop('No origin upstream is available for publication proof.');
  const ref = `refs/heads/${upstream.slice('origin/'.length)}`;
  const result = git(root, ['ls-remote', '--exit-code', 'origin', ref], true);
  const lines = result.stdout.trim().split('\n');
  if (result.code || lines.length !== 1 || lines[0] !== `${expected}\t${ref}`) {
    throw new Stop('The live published branch is missing, changed or unverified; cached refs cannot prove READY.');
  }
}

module.exports = { rootAt, snapshot, stable, blocker, metadataTarget, resume, same, verifyPublished };
