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

// review PoC：herdr 以外的外部指令（dirname、sed、sort、tail、cut）以前也照原本的 PATH 找，repo 的 node_modules/.bin/dirname 每次 hook 都會被執行
test('review PoC: bin/run.sh runs no tool from a relative PATH entry, and the hook still runs to the end', () => {
  const { caseDirectory, repositoryPath, markerPath } = createEvilRepository();
  const toolNames = ['dirname', 'sed', 'sort', 'tail', 'cut'];
  for (const toolName of [...toolNames, 'node']) {
    fs.writeFileSync(
      path.join(repositoryPath, 'node_modules', '.bin', toolName),
      `#!/bin/sh\necho "PWNED ${toolName} $*" >> ${JSON.stringify(markerPath)}\n`,
      { mode: 0o755 },
    );
  }
  const toolsDirectory = path.join(caseDirectory, 'tools');
  fs.mkdirSync(toolsDirectory);
  for (const toolName of toolNames) {
    const toolPath = findOnPath(toolName);
    if (toolPath !== null) {
      fs.symlinkSync(toolPath, path.join(toolsDirectory, toolName));
    }
  }
  // PATH 上沒有 node，launcher 會走到 nvm 那一段：newest_nvm_node 用得到 sed、sort、tail、cut
  const homeDirectory = path.join(caseDirectory, 'home');
  const nvmBinDirectory = path.join(homeDirectory, '.nvm', 'versions', 'node', 'v22.0.0', 'bin');
  fs.mkdirSync(nvmBinDirectory, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nvmBinDirectory, 'node'));
  const runtimeDirectory = path.join(caseDirectory, 'runtime');
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const callLogPath = path.join(caseDirectory, 'herdr-calls.jsonl');
  const fakeHerdrPath = path.join(caseDirectory, 'herdr');
  const sessionId = 's-tools';
  const paneGetOutput = JSON.stringify({ result: { pane: { agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: sessionId } } } });
  fs.writeFileSync(fakeHerdrPath, [
    `#!${process.execPath}`,
    'const argumentList = process.argv.slice(2);',
    `if (argumentList[0] === 'pane' && argumentList[1] === 'get') { process.stdout.write(${JSON.stringify(paneGetOutput)}); process.exit(0); }`,
    `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(argumentList) + '\\n');`,
    '',
  ].join('\n'), { mode: 0o755 });

  const result = spawnSync(shellPath, [path.join(repositoryDirectory, 'bin', 'run.sh'), 'hooks/sidebar-hook.mjs'], {
    cwd: repositoryPath,
    env: {
      HOME: homeDirectory,
      PATH: `node_modules/.bin::.:${toolsDirectory}`,
      HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: fakeHerdrPath,
      XDG_RUNTIME_DIR: runtimeDirectory,
    },
    input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: sessionId, agent_id: 'agt', agent_type: 'gp' }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  const repoToolRuns = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '';
  assert.equal(repoToolRuns, '', 'no tool from the repo may run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const calls = fs.readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, 'the hook ran through the launcher and reported to herdr');
  assert.deepEqual(calls[0].slice(0, 3), ['pane', 'report-metadata', 'w1:p1']);
});

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
