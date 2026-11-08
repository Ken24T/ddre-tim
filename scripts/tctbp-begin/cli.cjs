#!/usr/bin/env node
'use strict';
const { parse } = require('./lib/arguments.cjs');
const { begin, VERSION, releaseIdentity } = require('./lib/begin.cjs');

let report, options = {};
try {
  options = parse(process.argv.slice(2));
  report = options.version ? { contract: 'tctbp-begin/1', version: VERSION, release: releaseIdentity(), state: 'VERSION' } : begin(options);
} catch (error) {
  report = { contract: 'tctbp-begin/1', state: 'BLOCKED', handoffComplete: false, reason: error.message };
}
if (options.json || process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
else {
  console.log(`Begin ${report.version || VERSION}: ${report.state}`);
  if (report.checkout) console.log(`Checkout: ${report.checkout.root}\nBranch: ${report.checkout.branch || '(detached)'}\nCommit: ${report.checkout.head}`);
  if (report.reason) console.log(report.reason);
  for (const key of ['git', 'peers', 'data']) {
    if (report[key]) console.log(`${key}: ${report[key].state}${report[key].reason ? ` — ${report[key].reason}` : ''}`);
  }
  if (report.continuation?.state === 'READ') {
    console.log(`Continuation: ${report.continuation.ref}:${report.continuation.path}\n${report.continuation.content}`);
  }
}
process.exitCode = ['READY', 'ORIENTED', 'PREVIEW', 'VERSION'].includes(report.state) ? 0 : report.state === 'APPROVAL_REQUIRED' ? 20 : 1;
