import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveHerdrBinPath } from '../lib/herdr.mjs';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-security-path-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

// review PoC：使用者在別人的 repo 裡開 claude，PATH 有 `node_modules/.bin` 這種相對項目，repo 放了一個叫 herdr 的執行檔
let caseCounter = 0;
function createEvilRepository() {
  caseCounter += 1;
  const caseDirectory = path.join(temporaryRoot, `case-${caseCounter}`);
  const repositoryPath = path.join(caseDirectory, 'evil-repo');
  const markerPath = path.join(caseDirectory, 'pwned.log');
  fs.mkdirSync(path.join(repositoryPath, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(
    path.join(repositoryPath, 'node_modules', '.bin', 'herdr'),
    `#!/bin/sh\necho "PWNED $*" >> ${JSON.stringify(markerPath)}\n`,
    { mode: 0o755 },
  );
  const emptyDirectory = path.join(caseDirectory, 'empty');
  fs.mkdirSync(emptyDirectory);
  return { caseDirectory, repositoryPath, markerPath, emptyDirectory };
}

function findOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 下一個
    }
  }
  return null;
}

test('relative and empty PATH entries are never searched for herdr', () => {
  const checkedPaths = [];
  const isExecutable = (filePath) => {
    checkedPaths.push(filePath);
    return true;
  };
  assert.equal(resolveHerdrBinPath({ PATH: 'node_modules/.bin:.:bin::./tools:/opt/herdr/bin' }, isExecutable), '/opt/herdr/bin/herdr');
  assert.deepEqual(checkedPaths, ['/opt/herdr/bin/herdr']);
  assert.equal(resolveHerdrBinPath({ PATH: 'node_modules/.bin:.' }, () => true), null);
});

test('review PoC: the sidebar hook does not run a herdr from a relative PATH entry', () => {
  const { caseDirectory, repositoryPath, markerPath, emptyDirectory } = createEvilRepository();
  const runtimeDirectory = path.join(caseDirectory, 'runtime');
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const payload = JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's-r', agent_id: 'agr', agent_type: 'gp' });
  const result = spawnSync(process.execPath, [path.join(repositoryDirectory, 'hooks', 'sidebar-hook.mjs')], {
    cwd: repositoryPath,
    env: { HERDR_PANE_ID: 'w1:p1', XDG_RUNTIME_DIR: runtimeDirectory, PATH: `node_modules/.bin:${emptyDirectory}` },
    input: payload,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(markerPath), false, 'the repo herdr must not run');
  assert.deepEqual(fs.readdirSync(runtimeDirectory), []);
});

test('the open action does not pick a herdr from a relative PATH entry', () => {
  const { repositoryPath, markerPath, emptyDirectory } = createEvilRepository();
  const environment = { HOME: emptyDirectory, PATH: `node_modules/.bin:${emptyDirectory}`, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1' }) };
  const dryRun = spawnSync(process.execPath, [path.join(repositoryDirectory, 'open-action.mjs'), '--dry-run'], {
    cwd: repositoryPath,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).herdrBinPath, null);
  const realRun = spawnSync(process.execPath, [path.join(repositoryDirectory, 'open-action.mjs')], {
    cwd: repositoryPath,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(realRun.status, 1);
  assert.match(realRun.stderr, /herdr not found/);
  assert.equal(fs.existsSync(markerPath), false);
});

const systemNodePaths = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
const existingSystemNode = systemNodePaths.find((candidate) => fs.existsSync(candidate));
const shellPath = findOnPath('sh');

test('bin/run.sh does not notify through a herdr from a relative PATH entry when node is missing', { skip: existingSystemNode ? `a system node exists at ${existingSystemNode}` : false }, () => {
  const { caseDirectory, repositoryPath, markerPath, emptyDirectory } = createEvilRepository();
  const toolsDirectory = path.join(caseDirectory, 'tools');
  fs.mkdirSync(toolsDirectory);
  for (const toolName of ['dirname', 'sed', 'sort', 'tail', 'cut']) {
    const toolPath = findOnPath(toolName);
    if (toolPath !== null) {
      fs.symlinkSync(toolPath, path.join(toolsDirectory, toolName));
    }
  }
  const runLauncher = (pathValue) => spawnSync(shellPath, [path.join(repositoryDirectory, 'bin', 'run.sh'), 'scripts/setup.mjs'], {
    cwd: repositoryPath,
    env: { HOME: emptyDirectory, PATH: pathValue, HERDR_PLUGIN_ACTION_ID: 'setup' },
    encoding: 'utf8',
    timeout: 10_000,
  });

  const relativeOnly = runLauncher(`node_modules/.bin:${toolsDirectory}`);
  assert.equal(relativeOnly.status, 127);
  assert.equal(fs.existsSync(markerPath), false, 'the repo herdr must not run');

  // 對照組：同一個 herdr 放在絕對路徑的 PATH 項目裡就會被用來發通知
  const absoluteEntry = runLauncher(`${path.join(repositoryPath, 'node_modules', '.bin')}:${toolsDirectory}`);
  assert.equal(absoluteEntry.status, 127);
  assert.match(fs.readFileSync(markerPath, 'utf8'), /^PWNED notification show subagent\.watch: Node\.js 22\+ not found/);
});
