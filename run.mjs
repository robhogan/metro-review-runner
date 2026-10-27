// Runs one Metro review bot request in a react/metro checkout on Windows and
// reports the outcome as JSON. Shared by both Windows backends: the
// robhogan/metro-review-windows Actions workflow (as run.mjs) and the
// restricted metro-review account on winbox.
//
//   node runner.mjs [--setup <src.tgz> <files.tgz> <deps-hash>] \
//     <request.json> <checkout> <files dir> <result.json | ->
//
// --setup (winbox) replaces the checkout's source with <src.tgz> and the
// review's files with <files.tgz>, keeping installed node_modules, and runs
// yarn install when <deps-hash> differs from the last install. The request's
// files are copied to __review__/ in the checkout. Commands are spawned
// without a shell, from a fixed set of kinds.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 60_000;
const YARN_SCRIPTS = new Set(['typecheck', 'typecheck-ts', 'lint', 'test-smoke', 'build']);
const isWindows = process.platform === 'win32';

let argv = process.argv.slice(2);
let setup = null;
if (argv[0] === '--setup') {
  setup = {src: argv[1], files: argv[2], depsHash: argv[3]};
  argv = argv.slice(4);
}
const [requestPath, checkout, filesDir, resultPath] = argv;

function write(result) {
  const json = JSON.stringify(result, null, 2);
  if (resultPath === '-') process.stdout.write(`\n@@metro-review-result@@\n${json}\n`);
  else fs.writeFileSync(resultPath, json);
}

function capped(output) {
  return output.length > MAX_OUTPUT ? `[... ${output.length - MAX_OUTPUT} chars cut ...]\n${output.slice(-MAX_OUTPUT)}` : output;
}

function npx(args, opts) {
  // npx is a .cmd shim on Windows, which needs a shell. Its arguments here are
  // fixed or allowlisted, never free text from a request.
  return spawnSync('npx', args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: isWindows, ...opts});
}

// #region Setup (winbox)

function isNodeModules(rel) {
  return rel.split(/[\\/]/).includes('node_modules');
}

// Removes everything in the checkout except node_modules directories, so a
// new source tree can be unpacked without reinstalling.
function wipeSource(dir, rel = '') {
  for (const entry of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
    const child = path.join(rel, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      wipeSource(dir, child);
      if (fs.readdirSync(path.join(dir, child)).length === 0) fs.rmdirSync(path.join(dir, child));
    } else {
      fs.rmSync(path.join(dir, child), {force: true});
    }
  }
}

function runSetup() {
  fs.mkdirSync(checkout, {recursive: true});
  wipeSource(checkout);
  fs.rmSync(filesDir, {recursive: true, force: true});
  fs.mkdirSync(filesDir, {recursive: true});
  for (const [archive, dest] of [[setup.src, checkout], [setup.files, filesDir]]) {
    const r = spawnSync('tar', ['-xzf', archive, '-C', dest], {encoding: 'utf8'});
    if (r.status !== 0) throw new Error(`tar failed for ${archive}: ${r.stderr}`);
  }
  const marker = path.join(checkout, 'node_modules', '.metro-review-deps');
  const installed = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  if (installed === setup.depsHash) return 'dependencies reused';
  const r = npx(['--yes', 'yarn@1.22.22', 'install', '--frozen-lockfile', '--non-interactive', '--silent'], {cwd: checkout});
  if (r.status !== 0) throw new Error(`yarn install failed:\n${capped(`${r.stdout}${r.stderr}`)}`);
  fs.writeFileSync(marker, setup.depsHash);
  return 'dependencies installed';
}

// #endregion

let setupNote = null;
if (setup) {
  try {
    setupNote = runSetup();
  } catch (e) {
    write({error: e.message});
    process.exit(0);
  }
}

const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
if (fs.existsSync(filesDir)) {
  const dest = path.join(checkout, '__review__');
  fs.rmSync(dest, {recursive: true, force: true});
  fs.cpSync(filesDir, dest, {recursive: true});
}

const args = Array.isArray(request.args) ? request.args.map(String) : [];
let command;
switch (request.kind) {
  case 'jest':
    command = ['node', 'node_modules/jest/bin/jest.js', '--ci', '--no-watchman', ...args];
    break;
  case 'node':
    command = ['node', ...args];
    break;
  case 'yarn':
    if (args.length !== 1 || !YARN_SCRIPTS.has(args[0])) {
      write({error: `yarn script not allowed: ${args.join(' ')}`});
      process.exit(0);
    }
    command = ['npx', '--yes', 'yarn@1.22.22', 'run', args[0]];
    break;
  default:
    write({error: `unknown kind ${request.kind}`});
    process.exit(0);
}

const timeoutMinutes = Math.min(Math.max(Number(request.timeout_minutes) || 10, 1), 20);
const started = Date.now();
const opts = {cwd: checkout, timeout: timeoutMinutes * 60_000, env: {...process.env, CI: '1'}};
const r =
  command[0] === 'npx'
    ? npx(command.slice(1), opts)
    : spawnSync(command[0], command.slice(1), {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts});
write({
  command: command.join(' '),
  setup: setupNote,
  exit_code: r.status,
  signal: r.signal,
  timed_out: r.error?.code === 'ETIMEDOUT',
  duration_ms: Date.now() - started,
  output: capped(`${r.stdout ?? ''}${r.stderr ?? ''}`),
  platform: `${process.platform} ${process.arch} node ${process.version}`,
});
