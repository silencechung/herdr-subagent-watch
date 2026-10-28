import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
const launcherPath = path.join(repositoryDirectory, 'bin', 'run.sh');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-launcher-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

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

const shellPath = findOnPath('sh');
// launcher 只用得到這些外部指令；PATH 只放它們的連結，才能確定測試裡沒有真的 node 混進來
const toolNames = ['dirname', 'sed', 'sort', 'tail', 'cut', 'stty', 'dd', 'cat'];
const toolsDirectory = path.join(temporaryRoot, 'tools');
fs.mkdirSync(toolsDirectory);
for (const toolName of toolNames) {
  const toolPath = findOnPath(toolName);
  if (toolPath !== null) {
    fs.symlinkSync(toolPath, path.join(toolsDirectory, toolName));
  }
}
const systemNodePaths = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
const existingSystemNode = systemNodePaths.find((candidate) => fs.existsSync(candidate));
const skipWithoutNode = existingSystemNode ? `a system node exists at ${existingSystemNode}` : false;

let caseCounter = 0;
function createCase() {
  caseCounter += 1;
  const caseDirectory = path.join(temporaryRoot, `case-${caseCounter}`);
  const homeDirectory = path.join(caseDirectory, 'home');
  const binDirectory = path.join(caseDirectory, 'bin');
  fs.mkdirSync(homeDirectory, { recursive: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  return { caseDirectory, homeDirectory, binDirectory };
}

// 假 node：回報版本、印出自己被怎麼呼叫，並把 stdin 原封不動印出來
function writeFakeNode(filePath, version) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
    'echo "fake-node $0"',
    'for argument in "$@"; do echo "arg:$argument"; done',
    'cat',
    '',
  ].join('\n'), { mode: 0o755 });
  return filePath;
}

function runLauncher(args, { environment = {}, cwd = temporaryRoot, input = '' } = {}) {
  return spawnSync(shellPath, [launcherPath, ...args], {
    cwd,
    env: { PATH: toolsDirectory, ...environment },
    input,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('SUBAGENT_WATCH_NODE wins and the script path is resolved from the plugin root, not the cwd', () => {
  const { binDirectory, homeDirectory } = createCase();
  const explicitNode = writeFakeNode(path.join(binDirectory, 'explicit-node'), 'v22.3.0');
  writeFakeNode(path.join(binDirectory, 'node'), 'v24.0.0');
  const result = runLauncher(['viewer.mjs', '--once'], {
    environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}`, SUBAGENT_WATCH_NODE: explicitNode },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.deepEqual(lines, [`fake-node ${explicitNode}`, `arg:${path.join(repositoryDirectory, 'viewer.mjs')}`, 'arg:--once']);
});

test('a SUBAGENT_WATCH_NODE that does not exist is an error, not a silent fallback', () => {
  const { binDirectory, homeDirectory } = createCase();
  writeFakeNode(path.join(binDirectory, 'node'), 'v24.0.0');
  const result = runLauncher(['viewer.mjs'], {
    environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}`, SUBAGENT_WATCH_NODE: '/nonexistent/node' },
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /SUBAGENT_WATCH_NODE=\/nonexistent\/node is not an executable Node\.js 22 or newer/);
  assert.equal(result.stdout, '');
});

test('a SUBAGENT_WATCH_NODE older than 22 is rejected with its version', () => {
  const { binDirectory, homeDirectory } = createCase();
  const oldNode = writeFakeNode(path.join(binDirectory, 'old-node'), 'v20.11.1');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory, SUBAGENT_WATCH_NODE: oldNode } });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /v20\.11\.1/);
});

test('node on PATH is used when it is new enough', () => {
  const { binDirectory, homeDirectory } = createCase();
  const pathNode = writeFakeNode(path.join(binDirectory, 'node'), 'v24.1.0');
  writeFakeNode(path.join(homeDirectory, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'), 'v22.0.0');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${pathNode}$`, 'm'));
});

test('a PATH node that no longer exists (gone fnm multishell) falls through to the fnm default alias', () => {
  const { caseDirectory, binDirectory, homeDirectory } = createCase();
  fs.symlinkSync(path.join(caseDirectory, 'fnm_multishells', '123', 'bin', 'node'), path.join(binDirectory, 'node'));
  const fnmNode = writeFakeNode(path.join(homeDirectory, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'), 'v22.22.2');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${fnmNode}$`, 'm'));
});

test('a PATH node older than 22 is skipped in favour of FNM_DIR', () => {
  const { caseDirectory, binDirectory, homeDirectory } = createCase();
  writeFakeNode(path.join(binDirectory, 'node'), 'v18.20.0');
  const fnmDirectory = path.join(caseDirectory, 'custom-fnm');
  const fnmNode = writeFakeNode(path.join(fnmDirectory, 'aliases', 'default', 'bin', 'node'), 'v22.5.0');
  const result = runLauncher(['viewer.mjs'], {
    environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}`, FNM_DIR: fnmDirectory },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${fnmNode}$`, 'm'));
});

test('~/.fnm and Volta are looked at when there is no node on PATH', () => {
  const fnmCase = createCase();
  const legacyFnmNode = writeFakeNode(path.join(fnmCase.homeDirectory, '.fnm', 'aliases', 'default', 'bin', 'node'), 'v23.0.0');
  let result = runLauncher(['viewer.mjs'], { environment: { HOME: fnmCase.homeDirectory } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${legacyFnmNode}$`, 'm'));

  const voltaCase = createCase();
  const voltaNode = writeFakeNode(path.join(voltaCase.homeDirectory, '.volta', 'bin', 'node'), 'v22.1.0');
  result = runLauncher(['viewer.mjs'], { environment: { HOME: voltaCase.homeDirectory } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${voltaNode}$`, 'm'));
});

test('the macOS fnm folder of older fnm versions (with a space in its path) is looked at before ~/.fnm', () => {
  const { homeDirectory } = createCase();
  const macosFnmNode = writeFakeNode(path.join(homeDirectory, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'), 'v22.4.0');
  writeFakeNode(path.join(homeDirectory, '.fnm', 'aliases', 'default', 'bin', 'node'), 'v23.0.0');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes(`fake-node ${macosFnmNode}`), result.stdout);
});

test('nvm: the newest installed version wins, compared as numbers', () => {
  const { homeDirectory } = createCase();
  const versionsDirectory = path.join(homeDirectory, '.nvm', 'versions', 'node');
  writeFakeNode(path.join(versionsDirectory, 'v20.1.0', 'bin', 'node'), 'v20.1.0');
  writeFakeNode(path.join(versionsDirectory, 'v22.2.0', 'bin', 'node'), 'v22.2.0');
  const newestNode = writeFakeNode(path.join(versionsDirectory, 'v22.10.0', 'bin', 'node'), 'v22.10.0');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^fake-node ${newestNode}$`, 'm'));
});

test('without any usable node it explains what to install and lists the versions it rejected', { skip: skipWithoutNode }, () => {
  const { binDirectory, homeDirectory } = createCase();
  writeFakeNode(path.join(binDirectory, 'node'), 'v18.20.0');
  const result = runLauncher(['viewer.mjs'], { environment: { HOME: homeDirectory, PATH: `${binDirectory}:${toolsDirectory}` } });
  assert.equal(result.status, 127);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Node\.js 22 or newer was not found/);
  assert.match(result.stderr, /set SUBAGENT_WATCH_NODE/);
  assert.match(result.stderr, /Too old or unusable:\n {2}.+\/node \(v18\.20\.0\)/);
});

// 側邊欄 hook 已經拿掉，但還沒重跑 setup 的使用者 settings.json 裡還掛著它：有沒有 node 都要安靜地 exit 0
test('a sidebar hook left in settings.json by an older version exits 0 silently, with or without node', { skip: skipWithoutNode }, () => {
  const { binDirectory, homeDirectory } = createCase();
  const explicitNode = writeFakeNode(path.join(binDirectory, 'node'), 'v22.0.0');
  for (const environment of [{ HOME: homeDirectory }, { HOME: homeDirectory, SUBAGENT_WATCH_NODE: explicitNode }]) {
    const result = runLauncher([path.join(repositoryDirectory, 'hooks', 'sidebar-hook.mjs')], {
      environment,
      input: '{"hook_event_name":"SubagentStart"}',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('an action without node tells the user through a herdr notification', { skip: skipWithoutNode }, () => {
  const { caseDirectory, homeDirectory } = createCase();
  const callLogPath = path.join(caseDirectory, 'herdr-calls.log');
  const fakeHerdrPath = path.join(caseDirectory, 'herdr');
  fs.writeFileSync(fakeHerdrPath, `#!/bin/sh\nfor argument in "$@"; do echo "$argument"; done >> ${JSON.stringify(callLogPath)}\n`, { mode: 0o755 });
  const result = runLauncher(['scripts/setup.mjs'], {
    environment: { HOME: homeDirectory, HERDR_PLUGIN_ACTION_ID: 'setup', HERDR_BIN_PATH: fakeHerdrPath },
  });
  assert.equal(result.status, 127);
  const calls = fs.readFileSync(callLogPath, 'utf8').trim().split('\n');
  assert.deepEqual(calls.slice(0, 3), ['notification', 'show', 'subagent.watch: Node.js 22+ not found']);
});

test('stdin reaches the script untouched', () => {
  const { binDirectory, homeDirectory } = createCase();
  const explicitNode = writeFakeNode(path.join(binDirectory, 'node'), 'v22.0.0');
  const payload = '{"some":"input","agent_id":"abc"}';
  const result = runLauncher(['open-action.mjs'], {
    environment: { HOME: homeDirectory, SUBAGENT_WATCH_NODE: explicitNode },
    input: payload,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trimEnd().endsWith(payload), result.stdout);
});

test('with the real node it runs viewer.mjs end to end', () => {
  const { homeDirectory } = createCase();
  const result = runLauncher(['viewer.mjs', '--once', '--demo'], {
    environment: { HOME: homeDirectory, SUBAGENT_WATCH_NODE: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n')[0], /^2 running · 1 done │/);
});

// 只認 util-linux 的 script（認得 --version）：macOS 的 BSD script 不吃下面的 -qfec，語法也不同
const hasScript = findOnPath('script') !== null && spawnSync(findOnPath('script'), ['--version'], { encoding: 'utf8' }).status === 0;

describe('inside a popup', { skip: (!hasScript && 'util-linux script is not available') || skipWithoutNode }, () => {
  test('the error stays on screen until a key is pressed', { timeout: 15_000 }, async () => {
    const { homeDirectory } = createCase();
    const command = `exec ${JSON.stringify(shellPath)} ${JSON.stringify(launcherPath)} viewer.mjs`;
    const child = spawn(findOnPath('script'), ['-qfec', command, '/dev/null'], {
      env: { PATH: toolsDirectory, HOME: homeDirectory, HERDR_PLUGIN_ENTRYPOINT_ID: 'viewer' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    const exited = new Promise((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    });
    try {
      const startMs = Date.now();
      while (!output.includes('Press any key to close.')) {
        if (Date.now() - startMs > 5000) {
          throw new Error(`no prompt; output so far:\n${output}`);
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      assert.match(output, /Node\.js 22 or newer was not found/);
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      assert.equal(child.exitCode, null, 'the launcher exited before a key was pressed');
      child.stdin.write('x');
      assert.equal(await exited, 127);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
