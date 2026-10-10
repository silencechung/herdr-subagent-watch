import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
const openActionPath = path.join(repositoryDirectory, 'open-action.mjs');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-open-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const fakeBinDirectory = path.join(temporaryRoot, 'bin');
fs.mkdirSync(fakeBinDirectory);
const fakeHerdrPath = path.join(fakeBinDirectory, 'herdr');
fs.writeFileSync(fakeHerdrPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const emptyDirectory = path.join(temporaryRoot, 'empty');
fs.mkdirSync(emptyDirectory);

function runOpenAction(args, extraEnvironment) {
  const environment = {
    HOME: temporaryRoot,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1' }),
    ...extraEnvironment,
  };
  return spawnSync(process.execPath, [openActionPath, ...args], { env: environment, encoding: 'utf8', timeout: 10_000 });
}

test('without HERDR_BIN_PATH the open action uses herdr from PATH', () => {
  const result = runOpenAction(['--dry-run'], { PATH: `${fakeBinDirectory}:${emptyDirectory}` });
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.herdrBinPath, fakeHerdrPath);
  assert.deepEqual(entry.wouldRun, [
    fakeHerdrPath, 'plugin', 'pane', 'open', '--plugin', 'subagent.watch', '--entrypoint', 'viewer', '--env', 'SUBAGENT_WATCH_PANE_ID=w1:p1',
  ]);
});

test('HERDR_BIN_PATH from herdr wins over PATH', () => {
  const result = runOpenAction(['--dry-run'], { PATH: fakeBinDirectory, HERDR_BIN_PATH: '/run/herdr-from-server' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).wouldRun[0], '/run/herdr-from-server');
});

test('with no herdr at all it fails with a clear message instead of guessing a path', () => {
  const result = runOpenAction([], { PATH: emptyDirectory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /herdr not found: HERDR_BIN_PATH is not set and there is no herdr on PATH/);
});
