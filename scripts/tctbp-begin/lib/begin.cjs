'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Stop, hash } = require('./process.cjs');
const { load } = require('./profile.cjs');
const { rootAt, snapshot, stable, blocker, resume, verifyPublished } = require('./git-state.cjs');
const { readContinuation } = require('./continuation.cjs');
const adapters = require('./adapters.cjs');

const VERSION = require('../package.json').version;
function releaseIdentity() {
  const root = path.resolve(__dirname, '..');
  const files = ['cli.cjs', 'package.json', ...fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs')).sort().map(name => `lib/${name}`)];
  return hash(files.map(name => `${name}\0${hash(fs.readFileSync(path.join(root, name)))}`).join('\n'));
}

function begin(options, cwd = process.cwd()) {
  const report = { contract: 'tctbp-begin/1', version: VERSION, release: releaseIdentity(),
    state: 'BLOCKED', actions: [], freshness: 'cached refs; no fetch',
    git: { state: 'UNVERIFIED' }, peers: { state: 'NOT_APPLICABLE' }, data: { state: 'NOT_APPLICABLE' } };
  let root, profile;
  try {
    root = rootAt(options.repo || cwd);
    report.checkout = snapshot(root);
    profile = load(root);
    if (profile.runtimeRelease && profile.runtimeRelease !== report.release) throw new Stop('Installed Begin runtime differs from the project pin; use a matching verified release.');
    report.project = profile.project || null;
    report.mode = profile.mode;
    report.profileHash = profile.profileHash || null;
    if (options.version) { report.state = 'VERSION'; return report; }
    const readOnly = options['no-actions'] || options.preview || profile.mode !== 'resume';
    const reason = blocker(report.checkout);
    if (readOnly || reason) {
      if ((options.recover || options['continue-published'] || options['switch-to']) && readOnly) throw new Stop('This checkout is inspect/orient only; it cannot accept action approval.');
      report.git = { state: reason ? 'BLOCKED' : 'UNVERIFIED', reason: reason || profile.reason ||
        'This invocation only inspects cached local state.' };
      if (profile.peer) report.peers = { state: 'UNVERIFIED', reason: 'Peer inspection requires an ordinary Begin.' };
      if (profile.data.kind !== 'none') report.data = { state: 'SKIPPED', reason: 'No data action in this mode.' };
      report.state = reason ? 'BLOCKED' : options.preview ? 'PREVIEW' : 'ORIENTED';
      report.continuation = readContinuation(root, profile, report.checkout.branch);
      report.handoffComplete = false;
      return report;
    }
    if (profile.peer) report.peers = { state: 'UNVERIFIED', reason: 'Required peer inspection has not returned a verified result.' };
    report.peers = adapters.peers(root, profile, options, report.release);
    if (!['READY', 'UNVERIFIED', 'NOT_APPLICABLE'].includes(report.peers.state)) {
      report.git = { state: 'BLOCKED', reason: 'Peer decision is required before resume.' };
      report.state = report.peers.state === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : 'BLOCKED';
      report.handoffComplete = false;
      return report;
    }
    if (report.peers.skipResume) {
      const state = snapshot(root);
      report.git = { state: 'READY', branch: state.branch, head: state.head, reason: 'Exact approved peer recovery target verified; normal resume skipped.' };
      report.freshness = 'peer recovery publication and exact destination verified';
    } else report.git = resume(root, profile, report.checkout, options, report);
    const current = snapshot(root);
    report.checkout = current;
    if (load(root).profileHash !== profile.profileHash) throw new Stop('Begin profile changed during resume. Re-run Begin with the new profile.');
    report.data = adapters.data(root, profile, options, report.git);
    stable(root, current);
    report.continuation = readContinuation(root, profile, current.branch);
    stable(root, current);
    if (report.git.state === 'READY') {
      verifyPublished(root, current.upstream, current.head);
      stable(root, current);
      report.git.observedAt = new Date().toISOString();
    }
    report.handoffComplete = report.git.state === 'READY' &&
      ['READY', 'NOT_APPLICABLE'].includes(report.peers.state) && ['READY', 'NOT_APPLICABLE'].includes(report.data.state) &&
      report.continuation.state === 'READ';
    report.state = report.handoffComplete ? 'READY' : report.git.state === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : 'INCOMPLETE';
  } catch (error) {
    report.state = 'BLOCKED';
    report.handoffComplete = false;
    report.reason = error instanceof Stop ? error.message : 'Begin could not verify its result. Inspect the checkout before continuing.';
    if (profile?.peer && report.peers.state === 'UNVERIFIED') report.peers = { ...report.peers, state: 'BLOCKED', reason: report.reason };
    if (report.git.state === 'READY') report.git = { ...report.git, state: 'BLOCKED', reason: report.reason };
    // Preserve already-observed adapter evidence, including partial recovery receipts.
    if (root) { try { report.checkout = snapshot(root); } catch {} }
  }
  return report;
}

module.exports = { begin, VERSION, releaseIdentity };
