#!/usr/bin/env node
// Shared development policy 1.0.0: read-only size signals, never size-only failure.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXTENSIONS = new Set('.js .cjs .mjs .jsx .ts .tsx .py .sh .bash .ps1 .psm1 .rs .go .java .kt .kts .cs .cpp .c .h .hpp .css .scss .sass .less .html .vue .svelte .json .jsonc .yaml .yml .toml .xml .sql .md .mdx .rst .adoc .txt'.split(' '));
const DOCS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const STYLES = new Set(['.css', '.scss', '.sass', '.less']);

function countPhysicalLines(source) {
  return source ? source.split(/\r\n|\n|\r/).length - Number(/(?:\r\n|\n|\r)$/.test(source)) : 0;
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Git inspection failed.');
  return result.stdout.split('\0').filter(Boolean);
}

function readPolicy(root) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, '.github/development-policy.json'), 'utf8'));
  const r = policy.reporting;
  const component = value => typeof value === 'string' && value.length > 0 &&
    value !== '.' && value !== '..' && !/[/\\\x00-\x1f]/.test(value);
  if (policy.schemaVersion !== 1 || policy.id !== 'shared-development-policy' ||
      typeof policy.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(policy.version) ||
      policy.document !== '.github/DEVELOPMENT_POLICY.md' || !r ||
      r.mode !== 'advisory' || r.lineCounting !== 'physical' || r.failOnSize !== false ||
      !Number.isInteger(r.reviewPromptLines) || r.reviewPromptLines < 1 ||
      !Number.isInteger(r.designReviewLines) || r.designReviewLines < r.reviewPromptLines ||
      !Array.isArray(policy.exclusions?.directories) || !policy.exclusions.directories.every(component) ||
      !Array.isArray(policy.exclusions?.files) || !policy.exclusions.files.every(component)) {
    throw new Error('Invalid shared development policy.');
  }
  return policy;
}

function inspect(root, { changed = false } = {}) {
  const policy = readPolicy(root);
  const tracked = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const changedPaths = changed ? new Set([
    ...git(root, ['diff', '--name-only', '-z']),
    ...git(root, ['diff', '--cached', '--name-only', '-z']),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]) : null;
  const directories = new Set(policy.exclusions.directories);
  const excludedFiles = new Set(policy.exclusions.files);
  const files = [];
  const excluded = [];
  for (const relative of [...new Set(tracked)].sort()) {
    if (changedPaths && !changedPaths.has(relative)) continue;
    const parts = relative.split('/');
    const extension = path.extname(relative).toLowerCase();
    if (parts.some(p => directories.has(p)) || excludedFiles.has(parts.at(-1)) ||
        /\.min\.[cm]?js$/.test(relative)) continue;
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) throw new Error('A source path escapes the repository.');
    let st;
    try { st = fs.lstatSync(filename); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (st.isSymbolicLink()) { excluded.push({ path: relative, reason: 'symlink' }); continue; }
    const parent = fs.realpathSync(path.dirname(filename));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('A source directory escapes the repository.');
    if (!st.isFile()) throw new Error('A source path is not a regular file.');
    const fd = fs.openSync(filename, 'r');
    const bytes = Buffer.alloc(1024);
    let header;
    try { header = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8'); }
    finally { fs.closeSync(fd); }
    const named = ['Makefile', 'Dockerfile', '.gitignore', '.gitattributes', '.editorconfig'].includes(parts.at(-1));
    const shebang = /^#![^\r\n]*\b(?:(?:ba|z|k|da)?sh|python(?:[23](?:\.\d+)?)?|node(?:js)?|pwsh|perl|ruby|awk)(?:\s|$)/.test(header);
    if (!EXTENSIONS.has(extension) && !named && !shebang) continue;
    const generated = header.split(/\r\n|\n|\r/).slice(0, 5).some(line =>
      /^\s*(?:\/\/|#|\/\*+|\*|<!--)\s*(?:@generated(?:\s|$)|(?:(?:this file (?:is|was) )?(?:automatically )?generated|code generated)\b.*\bdo not edit\b)/i.test(line));
    if (generated) { excluded.push({ path: relative, reason: 'marked generated' }); continue; }
    if (st.size > 8 * 1024 * 1024) {
      files.push({ path: relative, kind: 'large input', signal: 'design-review', lines: null, reason: 'Over 8 MiB; inspect separately.' });
      continue;
    }
    const source = fs.readFileSync(filename, 'utf8');
    const lines = countPhysicalLines(source);
    const signal = lines >= policy.reporting.designReviewLines ? 'design-review' :
      lines >= policy.reporting.reviewPromptLines ? 'structure-review' : 'none';
    const kind = DOCS.has(extension) ? 'documentation' : STYLES.has(extension) ? 'style' :
      /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.|(^|\/)test-/.test(relative) ? 'test' : 'source/configuration';
    files.push({ path: relative, kind, lines, signal });
  }
  return { policy: policy.id, version: policy.version, mode: 'advisory', counting: 'physical',
    scope: changed ? 'working changes' : 'repository overview', files, excluded,
    reviewNeeded: files.filter(f => f.signal !== 'none').length,
    note: 'Size signals require judgement; this report is not a completed review or approval.' };
}

function main(argv = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
  try {
    if (argv.includes('--help')) {
      console.log('Usage: node scripts/check-modularity.cjs [--changed] [--json|--list]\nRead-only advisory report for code and documentation.');
      return 0;
    }
    if (argv.some(a => !['--changed', '--json', '--list'].includes(a))) throw new Error('Unsupported report option; no files were changed.');
    const report = inspect(root, { changed: argv.includes('--changed') });
    if (argv.includes('--json') || argv.includes('--list')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Modularity review — ${report.version}, advisory, physical lines (${report.scope})`);
      for (const f of report.files.filter(f => f.signal !== 'none').slice(0, 30)) console.log(`  ${f.signal}: ${f.path} (${f.lines ?? '>8 MiB'}; ${f.kind})`);
      console.log(`${report.files.length} files inspected; ${report.reviewNeeded} review signals; ${report.excluded.length} explicit exclusions. Use --json for the full report.`);
      console.log(report.note);
    }
    return 0;
  } catch (error) {
    console.error(`Modularity inspection failed: ${error.message}`);
    return 1;
  }
}

module.exports = { countPhysicalLines, inspect, main };
if (require.main === module) process.exitCode = main();
