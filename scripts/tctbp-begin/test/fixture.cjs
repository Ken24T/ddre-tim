'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../cli.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'begin contract '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git'), source = path.join(directory, 'source'), checkout = path.join(directory, 'checkout');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  env.HOME = path.join(directory, 'home'); fs.mkdirSync(env.HOME);
  delete env.GIT_DIR; delete env.GIT_INDEX_FILE; delete env.GIT_WORK_TREE;
  const git = (root, ...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, source);
  const write = (root, relative, value) => {
    const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value);
  };
  const profile = { schemaVersion: 1, contract: 'tctbp-begin/1', runtimeRelease: require('../lib/begin.cjs').releaseIdentity(), project: 'fixture', mode: 'resume',
    repository: { remotes: [remote] }, continuations: { directories: ['.tctbp/continuation'] }, data: { kind: 'none' }, ...options.profile };
  write(source, '.github/TCTBP_BEGIN.json', JSON.stringify(profile, null, 2));
  write(source, '.tctbp/continuation/z-old.md', '# Existing work\nRead the actual continuation.\n');
  write(source, 'work.txt', 'original\n');
  for (const [name, content] of Object.entries(options.files || {})) write(source, name, content);
  let commitTime = 1700000000;
  const commit = (root, message) => {
    const stamp = `${commitTime += 60} +0000`;
    env.GIT_AUTHOR_DATE = stamp; env.GIT_COMMITTER_DATE = stamp;
    git(root, 'add', '--all'); git(root, 'commit', '-m', message); return git(root, 'rev-parse', 'HEAD');
  };
  commit(source, 'Initial contract fixture'); git(source, 'push', 'origin', 'main');
  git(directory, 'clone', remote, checkout);
  const run = (args = [], extraEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, '--repo', checkout, '--json', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
    if (!result.stdout) throw new Error(result.stderr || 'No shared Begin output');
    return { code: result.status, report: JSON.parse(result.stdout) };
  };
  return { directory, remote, source, checkout, git, write, commit, run, profile,
    publish(message = 'Published update') { const head = commit(source, message); git(source, 'push', 'origin', 'HEAD'); return head; },
    fingerprint() { return [git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'show-ref'),
      git(checkout, 'status', '--porcelain=v1'), git(checkout, 'ls-files', '--stage')].join('\n'); } };
}

module.exports = { fixture };
