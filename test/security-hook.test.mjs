import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
const hookScriptPath = path.join(repositoryDirectory, 'hooks', 'sidebar-hook.mjs');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-security-hook-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const mainSessionId = 'main-session-0001';
const paneId = 'w1:pSecurity';

let caseCounter = 0;
function createCaseDirectory() {
  caseCounter += 1;
  const caseDirectory = path.join(temporaryRoot, `case-${caseCounter}`);
  fs.mkdirSync(caseDirectory, { recursive: true });
  return caseDirectory;
}

function startPayload(sessionId, agentId) {
  return JSON.stringify({
    hook_event_name: 'SubagentStart',
    session_id: sessionId,
    agent_id: agentId,
    agent_type: 'general-purpose',
    transcript_path: `/tmp/${sessionId}.jsonl`,
    cwd: '/tmp',
  });
}

// 假 herdr：FAKE_PANE_SESSION 有值時 `pane get` 回報這個 session，沒有就像 herdr 沒拿到 agent_session；report-metadata 記到 log
function writeFakeHerdr(caseDirectory) {
  const fakeHerdrPath = path.join(caseDirectory, 'herdr');
  const callLogPath = path.join(caseDirectory, 'herdr-calls.jsonl');
  fs.writeFileSync(fakeHerdrPath, [
    `#!${process.execPath}`,
    'const argumentList = process.argv.slice(2);',
    "if (argumentList[0] === 'pane' && argumentList[1] === 'get') {",
    '  const value = process.env.FAKE_PANE_SESSION;',
    "  const pane = value ? { agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value } } : { agent: 'claude' };",
    '  process.stdout.write(JSON.stringify({ result: { pane } }));',
    '  process.exit(0);',
    '}',
    `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(argumentList) + '\\n');`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { fakeHerdrPath, callLogPath };
}

function readCalls(callLogPath) {
  if (!fs.existsSync(callLogPath)) {
    return [];
  }
  return fs.readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('claude wrapper and nested claude, with a real process tree', () => {
  // 名為 claude 的 process：真正的 claude 用指向 node 的 symlink 冒充（comm 取執行路徑的檔名），wrapper 是沒有 exec 的 sh script
  function createProcessTree() {
    const caseDirectory = createCaseDirectory();
    const realDirectory = path.join(caseDirectory, 'real');
    const wrapperDirectory = path.join(caseDirectory, 'wrapper');
    fs.mkdirSync(realDirectory);
    fs.mkdirSync(wrapperDirectory);
    const realClaudePath = path.join(realDirectory, 'claude');
    fs.symlinkSync(process.execPath, realClaudePath);
    const fakeClaudeScriptPath = path.join(caseDirectory, 'fake-claude.mjs');
    // FAKE_CLAUDE_NEST=1：像 pane 裡的 claude 用 Bash tool 跑 `claude -p`，中間隔一層不會 exec 的 shell（Bash tool 會在指令後面接 `pwd -P`）
    fs.writeFileSync(fakeClaudeScriptPath, [
      "import { spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      'if (process.env.FAKE_CLAUDE_NEST === "1") {',
      '  spawnSync("sh", ["-c", `"${process.env.REAL_CLAUDE}" "${process.env.FAKE_CLAUDE_SCRIPT}"; true`], { env: { ...process.env, FAKE_CLAUDE_NEST: "0" }, stdio: "ignore" });',
      '} else {',
      '  const hook = spawnSync("sh", ["-c", `"${process.env.NODE_BINARY}" "${process.env.HOOK_SCRIPT}"`], { input: process.env.HOOK_PAYLOAD, encoding: "utf8" });',
      '  fs.writeFileSync(process.env.DONE_PATH, JSON.stringify({ status: hook.status, stdout: hook.stdout }));',
      '}',
      '',
    ].join('\n'));
    const wrapperPath = path.join(wrapperDirectory, 'claude');
    fs.writeFileSync(wrapperPath, `#!/bin/sh\n"${realClaudePath}" "${fakeClaudeScriptPath}"\n`, { mode: 0o755 });
    const runtimeDirectory = path.join(caseDirectory, 'runtime');
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    const { fakeHerdrPath, callLogPath } = writeFakeHerdr(caseDirectory);
    const donePath = path.join(caseDirectory, 'done.json');
    const environment = {
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: runtimeDirectory,
      HERDR_PANE_ID: paneId,
      HERDR_BIN_PATH: fakeHerdrPath,
      NODE_BINARY: process.execPath,
      HOOK_SCRIPT: hookScriptPath,
      REAL_CLAUDE: realClaudePath,
      FAKE_CLAUDE_SCRIPT: fakeClaudeScriptPath,
      DONE_PATH: donePath,
    };
    return { realClaudePath, fakeClaudeScriptPath, wrapperPath, runtimeDirectory, callLogPath, donePath, environment };
  }

  // 跑測試的 process 本身可能在 claude 底下（例如在 Claude Code 裡跑測試）；背景執行再讓 sh 結束，fake claude 就被 reparent，祖先只剩自己這一串
  async function runDetached(command, environment, donePath) {
    spawnSync('sh', ['-c', `${command} >/dev/null 2>&1 </dev/null &`], { env: environment, stdio: 'ignore' });
    const deadlineMs = Date.now() + 8000;
    while (Date.now() < deadlineMs) {
      if (fs.existsSync(donePath)) {
        return JSON.parse(fs.readFileSync(donePath, 'utf8'));
      }
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 20);
      });
    }
    throw new Error('fake claude did not finish');
  }

  test('a wrapper named claude no longer hides every event when herdr knows the pane session', async () => {
    const tree = createProcessTree();
    const environment = { ...tree.environment, FAKE_PANE_SESSION: mainSessionId, HOOK_PAYLOAD: startPayload(mainSessionId, 'wrapped') };
    const result = await runDetached(`"${tree.wrapperPath}"`, environment, tree.donePath);
    assert.deepEqual(result, { status: 0, stdout: '' });
    const calls = readCalls(tree.callLogPath);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('sub1=└─ general-purpose ●'));
  });

  test('a wrapper named claude is counted once when herdr has no session for the pane', async () => {
    const tree = createProcessTree();
    const environment = { ...tree.environment, HOOK_PAYLOAD: startPayload(mainSessionId, 'wrapped-fallback') };
    const result = await runDetached(`"${tree.wrapperPath}"`, environment, tree.donePath);
    assert.equal(result.status, 0);
    assert.equal(readCalls(tree.callLogPath).length, 1);
  });

  test('claude -p run by the pane claude through a shell is still skipped when herdr has no session', async () => {
    const tree = createProcessTree();
    const environment = { ...tree.environment, FAKE_CLAUDE_NEST: '1', HOOK_PAYLOAD: startPayload('nested-session-0002', 'nested') };
    const result = await runDetached(`"${tree.realClaudePath}" "${tree.fakeClaudeScriptPath}"`, environment, tree.donePath);
    assert.deepEqual(result, { status: 0, stdout: '' });
    assert.deepEqual(readCalls(tree.callLogPath), []);
    assert.deepEqual(fs.readdirSync(tree.runtimeDirectory), []);
  });

  test('claude -p with its own session is skipped when herdr reports the main session', async () => {
    const tree = createProcessTree();
    const environment = {
      ...tree.environment,
      FAKE_CLAUDE_NEST: '1',
      FAKE_PANE_SESSION: mainSessionId,
      HOOK_PAYLOAD: startPayload('nested-session-0003', 'nested'),
    };
    const result = await runDetached(`"${tree.realClaudePath}" "${tree.fakeClaudeScriptPath}"`, environment, tree.donePath);
    assert.equal(result.status, 0);
    assert.deepEqual(readCalls(tree.callLogPath), []);
  });
});

describe('stale lock race (review scenario: scratchpad/code-review/stale-lock-race.mjs)', () => {
  async function runTrial(caseDirectory, trial, parallelCount, writeStaleLock) {
    const runtimeDirectory = path.join(caseDirectory, `runtime-${trial}`);
    const stateDirectory = path.join(runtimeDirectory, 'subagent-watch');
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const sessionId = 'race-session';
    writeStaleLock(path.join(stateDirectory, `session-${sessionId}.json.lock`));
    const environment = { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtimeDirectory, HERDR_PANE_ID: paneId, HERDR_BIN_PATH: path.join(caseDirectory, 'herdr') };
    const outputs = await Promise.all(Array.from({ length: parallelCount }, (unused, index) => new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [hookScriptPath], { env: { ...environment, FAKE_PANE_SESSION: sessionId }, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.on('close', (status) => {
        resolvePromise({ status, output });
      });
      child.stdin.end(startPayload(sessionId, `agent${index}`));
    })));
    for (const output of outputs) {
      assert.deepEqual(output, { status: 0, output: '' });
    }
    const state = JSON.parse(fs.readFileSync(path.join(stateDirectory, `session-${sessionId}.json`), 'utf8'));
    const leftovers = fs.readdirSync(stateDirectory).filter((name) => /\.lock$|\.tmp$|\.break-/.test(name));
    return { count: state.subagents.length, leftovers };
  }

  function writeOldEmptyLock(lockPath) {
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, old, old);
  }

  function writeDeadOwnerLock(lockPath) {
    const deadProcessId = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadProcessId, startTime: '1', createdAtMs: Date.now() }));
  }

  for (const [name, writeStaleLock] of [['an empty lock left by the previous version', writeOldEmptyLock], ['a lock whose holder died', writeDeadOwnerLock]]) {
    test(`8 hooks racing for ${name} lose no update`, { timeout: 60_000 }, async () => {
      const caseDirectory = createCaseDirectory();
      writeFakeHerdr(caseDirectory);
      const counts = [];
      for (let trial = 0; trial < 8; trial += 1) {
        const { count, leftovers } = await runTrial(caseDirectory, trial, 8, writeStaleLock);
        counts.push(count);
        assert.deepEqual(leftovers, []);
      }
      assert.deepEqual(counts, Array(8).fill(8));
    });
  }
});
