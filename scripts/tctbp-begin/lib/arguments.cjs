'use strict';
const { Stop } = require('./process.cjs');

function parse(argv) {
  const result = {};
  const boolean = new Set(['json', 'no-actions', 'preview', 'no-sync', 'version']);
  const valued = new Set(['repo', 'switch-to', 'expected-head', 'expected-target', 'expected-context', 'recover', 'continue-published']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Stop(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(result, key)) throw new Stop(`Repeated option: ${arg}`);
    if (boolean.has(key)) result[key] = true;
    else if (valued.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else throw new Stop(`Unknown option or missing value: ${arg}`);
  }
  if (result['no-actions'] && result.preview) throw new Stop('Choose no-actions or preview.');
  if ((result['no-actions'] || result.preview) &&
      (result['switch-to'] || result.recover || result['continue-published'])) {
    throw new Stop('Read-only modes cannot approve actions.');
  }
  if (result.recover && result['continue-published']) throw new Stop('Choose one peer decision.');
  const switching = ['switch-to', 'expected-head', 'expected-target', 'expected-context'].filter(key => result[key]);
  if (switching.length && switching.length !== 4) throw new Stop('A switch needs the named branch, both full preview commit IDs and its exact context.');
  if (result['expected-context'] && !/^[a-f0-9]{64}$/.test(result['expected-context'])) throw new Stop('Invalid branch preview context.');
  for (const key of ['expected-head', 'expected-target']) {
    if (result[key] && !/^[a-f0-9]{40,64}$/.test(result[key])) throw new Stop('Approval must name full commit IDs.');
  }
  return result;
}

module.exports = { parse };
