'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

class Stop extends Error {}

function execute(command, args, cwd, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  // Environment settings are never consent to change branches or publish work.
  delete env.TCTBP_NON_INTERACTIVE;
  delete env.TCTBP_ASSUME_YES;
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  }
  env.TCTBP_REPO_ROOT = cwd;
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: options.timeout || 60000,
    maxBuffer: 8 * 1024 * 1024, ...options, shell: false
  });
  if (result.error) throw new Stop(`${command} could not finish: ${result.error.code || 'execution error'}`);
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function git(root, args, optional = false) {
  const result = execute('git', ['-c', 'core.quotePath=false', ...args], root);
  if (result.code && !optional) throw new Stop(`Git inspection/action failed: ${args[0]}`);
  return result;
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Stop('Profile paths must stay inside the selected checkout.');
  }
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${root}${path.sep}`)) throw new Stop('Profile path escapes the checkout.');
  return result;
}

function trackedFile(root, relative) {
  const filename = contained(root, relative);
  const content = git(root, ['show', `HEAD:${relative}`], true);
  if (content.code || !fs.existsSync(filename) || fs.lstatSync(filename).isSymbolicLink() ||
      fs.realpathSync(filename) !== filename || fs.readFileSync(filename, 'utf8') !== content.stdout) {
    throw new Stop(`Required committed file is missing or changed: ${relative}`);
  }
  return filename;
}

function runJson(root, relative, args) {
  const filename = trackedFile(root, relative);
  const result = execute(process.execPath, [filename, ...args], root, { timeout: 180000 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Stop(`Adapter did not return one JSON result: ${relative}`); }
  return { code: result.code, report };
}

module.exports = { Stop, execute, git, hash, contained, trackedFile, runJson };
