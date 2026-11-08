'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixture.cjs');

test('clean resume fetches and fast-forwards only the current branch', t => {
  const f = fixture(t);
  f.write(f.source, 'work.txt', 'published\n');
  const target = f.publish();
  const { code, report } = f.run();
  assert.equal(code, 0); assert.equal(report.state, 'READY');
  assert.equal(report.checkout.branch, 'main'); assert.equal(report.checkout.head, target);
  assert.equal(report.actions.length, 1); assert.equal(report.data.state, 'NOT_APPLICABLE');
  assert.match(report.continuation.content, /Read the actual continuation/);
});

for (const mode of ['--no-actions', '--preview']) test(`${mode} preserves checkout, index and cached refs`, t => {
  const f = fixture(t); f.write(f.source, 'work.txt', 'new remote\n'); f.publish();
  const before = f.fingerprint();
  const result = f.run([mode]);
  assert.equal(result.code, 0); assert.equal(f.fingerprint(), before);
  assert.equal(result.report.handoffComplete, false); assert.match(result.report.freshness, /cached/);
});

for (const mode of ['orient', 'inspect']) test(`${mode} profile performs no fetch or resume`, t => {
  const f = fixture(t, { profile: { mode } });
  f.write(f.source, 'work.txt', 'new remote\n'); f.publish();
  const before = f.fingerprint();
  assert.equal(f.run().report.state, 'ORIENTED'); assert.equal(f.fingerprint(), before);
});

test('dirty staged and unstaged work remains byte-identical without a fetch', t => {
  const f = fixture(t);
  f.write(f.checkout, 'work.txt', 'staged\n'); f.git(f.checkout, 'add', 'work.txt');
  f.write(f.checkout, 'work.txt', 'unstaged\n'); f.write(f.checkout, 'private-local.txt', 'local\n');
  f.write(f.source, 'work.txt', 'remote\n'); f.publish();
  const before = f.fingerprint(); const { report } = f.run();
  assert.equal(report.state, 'BLOCKED'); assert.equal(report.continuation.state, 'READ');
  assert.equal(f.fingerprint(), before); assert.equal(fs.readFileSync(path.join(f.checkout, 'work.txt'), 'utf8'), 'unstaged\n');
});

test('divergence stops reconciliation and data', t => {
  const f = fixture(t);
  f.write(f.checkout, 'local.txt', 'local\n'); const local = f.commit(f.checkout, 'Unpublished local work');
  f.write(f.source, 'remote.txt', 'remote\n'); f.publish();
  const result = f.run();
  assert.equal(result.report.git.state, 'BLOCKED'); assert.equal(result.report.checkout.head, local);
  assert.equal(result.report.actions.length, 0);
});

test('ahead work is preserved and reported local only', t => {
  const f = fixture(t); f.write(f.checkout, 'local.txt', 'local\n'); f.commit(f.checkout, 'Local work');
  const { report } = f.run(); assert.equal(report.git.state, 'LOCAL_ONLY');
  assert.equal(report.handoffComplete, false); assert.equal(report.actions.length, 0);
});

test('detached HEAD and Git operations stop before fetch', t => {
  const f = fixture(t); f.git(f.checkout, 'checkout', '--detach');
  const before = f.fingerprint();
  assert.equal(f.run().report.git.state, 'BLOCKED'); assert.equal(f.fingerprint(), before);
  f.git(f.checkout, 'checkout', 'main');
  fs.writeFileSync(path.join(f.checkout, '.git/MERGE_HEAD'), f.git(f.checkout, 'rev-parse', 'HEAD'));
  assert.equal(f.run().report.git.state, 'BLOCKED');
});

test('unknown flags and missing or ambiguous option values stop without actions', t => {
  const f = fixture(t); const before = f.fingerprint();
  for (const args of [['--yes'], ['--repo'], ['--preview', '--recover', 'abcdefghijkl'], ['--switch-to', 'other']]) {
    assert.equal(f.run(args).report.state, 'BLOCKED'); assert.equal(f.fingerprint(), before);
  }
});

test('an absent profile gives labelled inspect only', t => {
  const f = fixture(t); f.git(f.checkout, 'rm', '.github/TCTBP_BEGIN.json'); f.commit(f.checkout, 'Old unsupported checkout');
  const before = f.fingerprint(); const { report } = f.run();
  assert.equal(report.mode, 'inspect'); assert.equal(report.state, 'ORIENTED'); assert.equal(f.fingerprint(), before);
});

test('changed profile and a different project origin fail closed', t => {
  const f = fixture(t);
  f.write(f.checkout, '.github/TCTBP_BEGIN.json', JSON.stringify({ ...f.profile, mode: 'orient' }));
  assert.equal(f.run().report.state, 'BLOCKED');
  f.git(f.checkout, 'restore', '.github/TCTBP_BEGIN.json');
  f.git(f.checkout, 'remote', 'set-url', 'origin', path.join(f.directory, 'different.git'));
  assert.equal(f.run().report.state, 'BLOCKED');
});

test('continuation selection uses change commit time across refs, never filename order or checkout', t => {
  const f = fixture(t); f.git(f.source, 'checkout', '-b', 'fresh-work');
  f.write(f.source, '.tctbp/continuation/a-new.md', '# Fresh branch continuation\n'); f.publish();
  f.git(f.source, 'checkout', 'main');
  // Fixture commits have increasing timestamps independent of wall-clock sleeps.
  f.git(f.source, 'checkout', '-b', 'newest-work');
  f.write(f.source, '.tctbp/continuation/0-latest.md', '# Actual latest content\n');
  f.publish();
  const { report } = f.run();
  assert.equal(report.checkout.branch, 'main');
  assert.equal(report.continuation.path, '.tctbp/continuation/0-latest.md');
  assert.match(report.continuation.content, /Actual latest content/);
});

function handover(f) {
  f.git(f.source, 'checkout', '-b', 'next-work');
  f.write(f.source, 'next.txt', 'next\n'); const target = f.publish();
  f.git(f.source, 'checkout', '-b', 'tctbp/handover-state');
  f.write(f.source, '.github/TCTBP_STATE.json', JSON.stringify({ branch: 'next-work', commit: target })); f.publish();
  f.git(f.source, 'checkout', 'main');
  return target;
}

test('published handover requires exact branch-switch approval even with noninteractive environment', t => {
  const f = fixture(t, { profile: { repository: { remotes: [], handover: { ref: 'refs/remotes/origin/tctbp/handover-state', file: '.github/TCTBP_STATE.json' } } } });
  f.profile.repository.remotes = [f.remote];
  f.write(f.source, '.github/TCTBP_BEGIN.json', JSON.stringify(f.profile)); f.publish();
  f.git(f.checkout, 'pull', '--ff-only');
  const target = handover(f), previous = f.git(f.checkout, 'rev-parse', 'HEAD');
  const result = f.run([], { TCTBP_NON_INTERACTIVE: '1' });
  assert.equal(result.report.git.state, 'APPROVAL_REQUIRED'); assert.equal(result.report.checkout.head, previous);
  const approved = f.run(['--switch-to', 'next-work', '--expected-head', previous, '--expected-target', target, '--expected-context', result.report.git.approval['expected-context']]);
  assert.equal(approved.report.state, 'READY'); assert.equal(approved.report.checkout.branch, 'next-work');
});

test('stale branch-switch approval and another worktree cannot be overridden', t => {
  const f = fixture(t, { profile: { repository: { remotes: [], handover: { ref: 'refs/remotes/origin/tctbp/handover-state', file: '.github/TCTBP_STATE.json' } } } });
  f.profile.repository.remotes = [f.remote]; f.write(f.source, '.github/TCTBP_BEGIN.json', JSON.stringify(f.profile)); f.publish();
  f.git(f.checkout, 'pull', '--ff-only');
  const target = handover(f), previous = f.git(f.checkout, 'rev-parse', 'HEAD'); const preview = f.run();
  const context = preview.report.git.approval['expected-context'];
  assert.equal(f.run(['--switch-to', 'next-work', '--expected-head', '0'.repeat(40), '--expected-target', target, '--expected-context', context]).report.state, 'BLOCKED');
  f.git(f.checkout, 'branch', 'next-work', 'origin/next-work');
  f.git(f.checkout, 'worktree', 'add', path.join(f.directory, 'other worktree'), 'next-work');
  assert.equal(f.run(['--switch-to', 'next-work', '--expected-head', previous, '--expected-target', target, '--expected-context', context]).report.state, 'BLOCKED');
  assert.equal(f.git(f.checkout, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

const dataProfile = { data: { kind: 'guarded-data/1', command: 'scripts/data.cjs', required: true } };
const dataScript = "const fs=require('node:fs');fs.writeFileSync('data-action','attempted');console.log(JSON.stringify({state:'READY'}));";
test('no-sync skips a required data capability and stays incomplete', t => {
  const f = fixture(t, { profile: dataProfile, files: { 'scripts/data.cjs': dataScript } });
  const { report } = f.run(['--no-sync']);
  assert.equal(report.git.state, 'READY'); assert.equal(report.data.state, 'SKIPPED'); assert.equal(report.handoffComplete, false);
  assert.equal(fs.existsSync(path.join(f.checkout, 'data-action')), false);
});

test('failed Git resume cannot invoke a data adapter', t => {
  const f = fixture(t, { profile: dataProfile, files: { 'scripts/data.cjs': dataScript } });
  f.git(f.checkout, 'branch', '--unset-upstream'); const { report } = f.run();
  assert.equal(report.git.state, 'BLOCKED'); assert.equal(report.data.state, 'BLOCKED');
  assert.equal(fs.existsSync(path.join(f.checkout, 'data-action')), false);
});

test('adapter partial-write evidence is retained and checkout changes block completion', t => {
  const f = fixture(t, { profile: dataProfile, files: { 'scripts/data.cjs': dataScript } });
  const { report } = f.run(); assert.equal(report.state, 'BLOCKED'); assert.equal(report.handoffComplete, false);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'data-action'), 'utf8'), 'attempted');
});

test('inherited Git directory and index overrides do not redirect the selected checkout', t => {
  const f = fixture(t); const { report } = f.run(['--no-actions'], { GIT_DIR: path.join(f.source, '.git'), GIT_INDEX_FILE: path.join(f.directory, 'fake-index') });
  assert.equal(report.checkout.root, f.checkout); assert.equal(report.state, 'ORIENTED');
  assert.equal(fs.existsSync(path.join(f.directory, 'fake-index')), false);
});

test('ignored work cannot be overwritten by an incoming tracked file', t => {
  const f = fixture(t, { files: { '.gitignore': 'notes.local\n' } });
  f.write(f.checkout, 'notes.local', 'valuable private notes\n');
  f.write(f.source, 'notes.local', 'incoming tracked notes\n');
  f.git(f.source, 'add', '-f', 'notes.local'); f.publish();
  const previous = f.git(f.checkout, 'rev-parse', 'HEAD');
  const { report } = f.run(); assert.equal(report.state, 'BLOCKED');
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD'), previous);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'notes.local'), 'utf8'), 'valuable private notes\n');
});

test('a deleted live published branch cannot be certified from cached refs', t => {
  const f = fixture(t);
  f.git(f.remote, 'update-ref', 'refs/heads/keep', f.git(f.source, 'rev-parse', 'HEAD'));
  f.git(f.remote, 'update-ref', '-d', 'refs/heads/main');
  const { report } = f.run(); assert.equal(report.state, 'BLOCKED'); assert.equal(report.handoffComplete, false);
});

test('archived nested continuation files are excluded from active orientation', t => {
  const f = fixture(t); f.write(f.source, '.tctbp/continuation/archive/newer.md', '# Historical only\n'); f.publish();
  const { report } = f.run(); assert.equal(report.continuation.path, '.tctbp/continuation/z-old.md');
});

test('a data step cannot leave final Git READY after live publication changed', t => {
  const f = fixture(t, { profile: dataProfile, files: { 'scripts/data.cjs': 'console.log(JSON.stringify({state:"READY"}));' } });
  const previous = f.git(f.source, 'rev-parse', 'HEAD');
  const script = `require('node:child_process').execFileSync('git',['-C',${JSON.stringify(f.remote)},'update-ref','refs/heads/main',${JSON.stringify(previous)}]);console.log(JSON.stringify({state:'READY'}));`;
  f.write(f.source, 'scripts/data.cjs', script); f.publish(); f.git(f.checkout, 'pull', '--ff-only');
  const { report } = f.run(); assert.equal(report.state, 'BLOCKED'); assert.equal(report.git.state, 'BLOCKED');
  assert.equal(report.data.state, 'READY'); assert.equal(report.handoffComplete, false);
});

const peerProfile = { peer: { protocol: 'saved-work-peer/2', command: 'scripts/peer.cjs' } };
function peerScript(value, code) { return `console.log(${JSON.stringify(JSON.stringify(value))});process.exitCode=${code};`; }
test('peer approval is distinct, pauses before fetch, and retains the exact preview', t => {
  const id = 'b'.repeat(32);
  const f = fixture(t, { profile: peerProfile, files: { 'scripts/peer.cjs': peerScript({ status: 'pending', id, peers: { source: { status: 'pending' } } }, 20) } });
  const before = f.fingerprint(), result = f.run();
  assert.equal(result.code, 20); assert.equal(result.report.state, 'APPROVAL_REQUIRED');
  assert.equal(result.report.peers.id, id); assert.equal(f.fingerprint(), before);
});

test('only-unknown accepted peers remain named and unverified', t => {
  const f = fixture(t, { profile: peerProfile, files: { 'scripts/peer.cjs': peerScript({ status: 'ready', unverified: true, unverified_peers: ['other-machine'] }, 0) } });
  const { report } = f.run(); assert.equal(report.peers.state, 'UNVERIFIED');
  assert.deepEqual(report.peers.unverified_peers, ['other-machine']); assert.equal(report.git.state, 'READY'); assert.equal(report.handoffComplete, false);
});

test('approval cannot use an absent shared preview or survive a changed project profile', t => {
  const id = 'c'.repeat(32);
  const f = fixture(t, { profile: peerProfile, files: { 'scripts/peer.cjs': peerScript({ status: 'pending', id }, 20) } });
  assert.match(f.run(['--recover', id]).report.reason, /No matching/);
  f.run();
  f.write(f.checkout, '.github/TCTBP_BEGIN.json', JSON.stringify({ ...f.profile, project: 'changed-fixture' })); f.commit(f.checkout, 'Changed declared identity');
  assert.match(f.run(['--recover', id]).report.reason, /approval expired/);
});

test('an unverified peer recovery target never skips into ordinary resume', t => {
  const f = fixture(t, { profile: peerProfile, files: { 'scripts/peer.cjs': peerScript({ status: 'ready', skipResume: true, target: { branch: 'wrong', head: '0'.repeat(40) } }, 0) } });
  const before = f.fingerprint(), result = f.run();
  assert.equal(result.report.state, 'BLOCKED'); assert.equal(f.fingerprint(), before);
});

test('an action-capable profile cannot omit its release pin', t => {
  const f = fixture(t); delete f.profile.runtimeRelease;
  f.write(f.checkout, '.github/TCTBP_BEGIN.json', JSON.stringify(f.profile)); f.commit(f.checkout, 'Unpinned profile');
  const before = f.fingerprint(), result = f.run();
  assert.equal(result.report.state, 'BLOCKED'); assert.match(result.report.reason, /release pin/); assert.equal(f.fingerprint(), before);
});

test('a branch preview expires when local workflow configuration changes', t => {
  const f = fixture(t, { profile: { repository: { remotes: [], handover: { ref: 'refs/remotes/origin/tctbp/handover-state', file: '.github/TCTBP_STATE.json' } } } });
  f.profile.repository.remotes = [f.remote]; f.write(f.source, '.github/TCTBP_BEGIN.json', JSON.stringify(f.profile)); f.publish(); f.git(f.checkout, 'pull', '--ff-only');
  const target = handover(f), previous = f.git(f.checkout, 'rev-parse', 'HEAD'), preview = f.run();
  f.git(f.checkout, 'config', 'core.hooksPath', path.join(f.directory, 'different-hooks'));
  const result = f.run(['--switch-to', 'next-work', '--expected-head', previous, '--expected-target', target, '--expected-context', preview.report.git.approval['expected-context']]);
  assert.equal(result.report.state, 'BLOCKED'); assert.equal(result.report.checkout.branch, 'main');
});

test('missing adapter evidence cannot imply that a declared data action did nothing', t => {
  const f = fixture(t, { profile: dataProfile, files: { 'scripts/data.cjs': 'console.log("unparseable after an attempted step");process.exitCode=1;' } });
  const { report } = f.run();
  assert.equal(report.data.state, 'BLOCKED'); assert.equal(report.data.partialPossible, true);
  assert.match(report.data.completion, /UNCONFIRMED/); assert.equal(report.handoffComplete, false);
});

test('a malformed peer result stays a blocked peer outcome', t => {
  const f = fixture(t, { profile: peerProfile, files: { 'scripts/peer.cjs': 'console.log("no verified peer JSON");process.exitCode=1;' } });
  const before = f.fingerprint(), result = f.run();
  assert.equal(result.report.peers.state, 'BLOCKED'); assert.equal(result.report.peers.recoveryAttempted, false);
  assert.equal(f.fingerprint(), before);
});
