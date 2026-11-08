'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Stop, hash, runJson, trackedFile } = require('./process.cjs');
const { snapshot, stable, blocker } = require('./git-state.cjs');

function bindingFile(id) {
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(id || '')) throw new Stop('Invalid peer preview identifier.');
  return path.join(os.homedir(), '.local/state/tctbp-begin/approvals', `${id}.json`);
}

function peerBinding(root, profile, release) {
  const command = trackedFile(root, profile.peer.command);
  return { root, profile: profile.profileHash, release, command: hash(fs.readFileSync(command)) };
}

function peers(root, profile, options, release) {
  if (!profile.peer) {
    if (options.recover || options['continue-published']) throw new Stop('This project has no saved-work peer handover capability.');
    return { state: 'NOT_APPLICABLE' };
  }
  const binding = peerBinding(root, profile, release);
  const approval = options.recover || options['continue-published'];
  const args = ['--json'];
  if (approval) {
    let recorded;
    try { recorded = JSON.parse(fs.readFileSync(bindingFile(approval), 'utf8')); }
    catch { throw new Stop('No matching shared Begin preview exists; inspect again before approving a handover.'); }
    if (JSON.stringify(recorded) !== JSON.stringify(binding)) throw new Stop('Begin release, profile or controller changed; approval expired.');
    args.push(options.recover ? '--recover' : '--continue-published', approval);
  }
  let result;
  try { result = runJson(root, profile.peer.command, args); }
  catch (error) {
    return { state: 'BLOCKED', reason: error.message, recoveryAttempted: Boolean(options.recover),
      partialPossible: Boolean(options.recover), completion: options.recover ? 'UNCONFIRMED: inspect private recovery receipts before retrying.' : 'Peer inspection did not return verified evidence.' };
  }
  const report = result.report;
  if (report.id && !approval) {
    const filename = bindingFile(report.id);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  }
  const acceptedUnknown = report.status === 'ready' && (report.unverified || report.unverified_peers?.length);
  const state = result.code === 0 && report.status === 'ready' ? (acceptedUnknown ? 'UNVERIFIED' : 'READY') :
    report.status === 'unknown' ? 'UNKNOWN' : report.status === 'pending' ? 'APPROVAL_REQUIRED' : 'BLOCKED';
  if (report.skipResume) {
    const current = snapshot(root);
    if (state !== 'READY' && state !== 'UNVERIFIED' || !report.target || blocker(current) ||
        current.branch !== report.target.branch || current.head !== report.target.head) {
      return { ...report, state: 'BLOCKED', status: 'blocked', nativeStatus: report.status,
        reason: 'Peer recovery did not produce its exact verified destination. Preserve its receipts and inspect.',
        recoveryAttempted: Boolean(options.recover), partialPossible: true, adapterExit: result.code };
    }
  }
  return { ...report, state, adapterExit: result.code };
}

function data(root, profile, options, gitState) {
  if (profile.data.kind === 'none') return { state: 'NOT_APPLICABLE' };
  if (options['no-sync']) return { state: 'SKIPPED', reason: 'Requested no-sync; required data handoff is incomplete.' };
  if (gitState.state !== 'READY') return { state: 'BLOCKED', reason: 'Data actions require a fresh verified Git READY result.' };
  const pin = snapshot(root);
  if (pin.branch !== gitState.branch || pin.head !== gitState.head || blocker(pin)) throw new Stop('Git readiness changed before the data adapter.');
  stable(root, pin);
  let result;
  try {
    result = runJson(root, profile.data.command, ['--json', '--expected-branch', pin.branch, '--expected-head', pin.head]);
  } catch (error) {
    return { state: 'BLOCKED', reason: error.message, partialPossible: true,
      completion: 'UNCONFIRMED: the adapter may have completed local steps. Inspect its private receipts before retrying.' };
  }
  try { stable(root, pin); } catch (error) {
    return { ...result.report, state: 'BLOCKED', reason: error.message, partialPossible: true, adapterExit: result.code };
  }
  return result.code === 0 && result.report.state === 'READY' ? result.report :
    { ...result.report, state: 'BLOCKED', adapterExit: result.code };
}

module.exports = { peers, data };
