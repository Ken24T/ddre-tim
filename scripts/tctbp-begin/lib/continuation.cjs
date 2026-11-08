'use strict';
const { git, contained, Stop } = require('./process.cjs');

function readContinuation(root, profile, currentBranch) {
  const directories = profile.continuations?.directories || ['.tctbp/continuation'];
  if (!Array.isArray(directories) || !directories.length) throw new Stop('Invalid continuation directories.');
  directories.forEach(directory => contained(root, directory));
  const excluded = profile.continuations?.excludeRefs || [];
  const refs = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).stdout.trim().split('\n')
    .filter(ref => ref && !ref.endsWith('/HEAD') && !excluded.includes(ref));
  const candidates = [];
  for (const ref of refs) {
    const entries = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...directories], true);
    if (entries.code) continue;
    const present = new Set(entries.stdout.split('\0').filter(name => /\.md$/i.test(name) && !/[\n\r]/.test(name) &&
      directories.some(directory => name.startsWith(`${directory}/`) && !name.slice(directory.length + 1).includes('/'))));
    if (!present.size) continue;
    const log = git(root, ['log', '--format=BEGIN-COMMIT:%ct:%H', '--name-only', ref, '--', ...directories], true);
    if (log.code) continue;
    let time = 0, commit = '';
    const seen = new Set();
    for (const line of log.stdout.split('\n')) {
      const marker = /^BEGIN-COMMIT:(\d+):([a-f0-9]+)$/.exec(line);
      if (marker) { time = Number(marker[1]); commit = marker[2]; continue; }
      if (present.has(line) && !seen.has(line)) {
        seen.add(line); candidates.push({ ref, path: line, committedAt: time, commit });
      }
    }
  }
  candidates.sort((a, b) => b.committedAt - a.committedAt ||
    Number(b.ref === `refs/heads/${currentBranch}`) - Number(a.ref === `refs/heads/${currentBranch}`) ||
    a.commit.localeCompare(b.commit) || a.path.localeCompare(b.path) || a.ref.localeCompare(b.ref));
  if (!candidates.length) return { state: 'MISSING', reason: 'No committed continuation found in cached relevant refs.' };
  const selected = candidates[0];
  const body = git(root, ['show', `${selected.ref}:${selected.path}`]).stdout;
  return { state: 'READ', ...selected, content: body, selection: 'latest file change commit time across cached relevant refs' };
}

module.exports = { readContinuation };
