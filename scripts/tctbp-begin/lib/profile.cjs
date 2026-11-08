'use strict';
const fs = require('node:fs');
const { Stop, git, hash, trackedFile } = require('./process.cjs');

const PROFILE = '.github/TCTBP_BEGIN.json';
function remoteIdentity(url) {
  const match = String(url).trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^\s?#]+)$/i);
  return match ? `github:${match[1].replace(/\.git$/i, '').toLowerCase()}` : String(url).trim();
}

function load(root) {
  const file = `${root}/${PROFILE}`;
  if (!fs.existsSync(file)) return { mode: 'inspect', reason: 'This checkout has no shared Begin profile.', data: { kind: 'none' } };
  trackedFile(root, PROFILE);
  const bytes = fs.readFileSync(file, 'utf8');
  let profile;
  try { profile = JSON.parse(bytes); } catch { throw new Stop('Begin profile is not valid JSON.'); }
  const allowed = new Set(['schemaVersion', 'contract', 'project', 'mode', 'repository', 'continuations', 'peer', 'data', 'runtimeRelease']);
  if (Object.keys(profile).some(key => !allowed.has(key)) || profile.schemaVersion !== 1 ||
      profile.contract !== 'tctbp-begin/1' || !/^[a-z0-9-]+$/.test(profile.project || '') ||
      !['inspect', 'orient', 'resume'].includes(profile.mode)) throw new Stop('Unsupported Begin profile or contract.');
  if (profile.mode === 'resume' && !/^[a-f0-9]{64}$/.test(profile.runtimeRelease || '')) throw new Stop('Action-capable Begin profiles require an exact runtime release pin.');
  const urls = git(root, ['remote', 'get-url', '--all', 'origin'], true);
  const expected = profile.repository?.remotes;
  const unenrolled = profile.mode === 'inspect' && Array.isArray(expected) && expected.length === 0;
  const identityMatches = Array.isArray(expected) && expected.length > 0 && expected.every(url => typeof url === 'string') &&
    !urls.code && urls.stdout.trim().split('\n').every(url => expected.map(remoteIdentity).includes(remoteIdentity(url)));
  if (!unenrolled && !identityMatches) {
    throw new Stop('The checkout origin does not match its declared project.');
  }
  const data = profile.data || { kind: 'none' };
  if (!['none', 'guarded-data/1'].includes(data.kind)) throw new Stop('Unsupported Begin data adapter.');
  if (data.kind !== 'none' && (!data.required || !data.command)) throw new Stop('Data capability requires a guarded adapter.');
  if (profile.peer && (profile.peer.protocol !== 'saved-work-peer/2' || !profile.peer.command)) throw new Stop('Unsupported peer protocol.');
  if (profile.mode !== 'resume' && (profile.peer || data.kind !== 'none')) throw new Stop('Read-only profiles cannot declare writing adapters.');
  return { ...profile, data, profileHash: hash(bytes) };
}

module.exports = { PROFILE, load, remoteIdentity };
