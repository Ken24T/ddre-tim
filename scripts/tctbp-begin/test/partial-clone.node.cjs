'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./fixture.cjs');

test('no-actions cannot implicitly fetch a missing continuation blob in a partial clone', t => {
  const f = fixture(t); f.git(f.source, 'checkout', '-b', 'other-work');
  f.write(f.source, '.tctbp/continuation/a-other.md', '# Other branch context not present as a local blob\n'); f.publish();
  f.git(f.source, 'checkout', 'main'); f.git(f.remote, 'config', 'uploadpack.allowFilter', 'true');
  const partial = path.join(f.directory, 'partial');
  f.git(f.directory, 'clone', '--filter=blob:none', `file://${f.remote}`, partial);
  function objects() {
    const root = path.join(partial, '.git/objects');
    const result = [];
    function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename); else result.push([filename, fs.statSync(filename).size]);
    } }
    walk(root); return JSON.stringify(result.sort());
  }
  const before = objects(), trace = path.join(f.directory, 'trace.jsonl');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.cjs'), '--repo', partial, '--no-actions', '--json'],
    { env: { ...process.env, GIT_TRACE2_EVENT: trace }, encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).state, 'BLOCKED');
  assert.equal(objects(), before);
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.some(event => event.event === 'child_start' && event.argv?.includes('fetch')), false);
});
