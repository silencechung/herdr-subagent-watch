import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyEvent,
  breakStaleLock,
  buildMetadataArguments,
  buildTreeLines,
  countClaudeAncestors,
  createEmptySessionState,
  formatTreeLine,
  isLockOwnerGone,
  maximumTokenLength,
  nextSequence,
  normalizeSessionState,
  parseHookPayload,
  parseLockOwner,
  parsePaneAgentSession,
  prepareStateDirectory,
  readProcessInfo,
  runHook,
  sanitizeText,
} from '../hooks/sidebar-hook.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const hookScriptPath = join(testDirectory, '..', 'hooks', 'sidebar-hook.mjs');
const fixtureDirectory = join(testDirectory, 'fixtures', 'sidebar');
const startPayloadText = readFileSync(join(fixtureDirectory, 'subagent-start.json'), 'utf8');
const stopPayloadText = readFileSync(join(fixtureDirectory, 'subagent-stop.json'), 'utf8');
const startPayload = JSON.parse(startPayloadText);
const testPaneId = 'w1:pTest';
const allTokensCleared = [
  '--clear-token', 'sub1',
  '--clear-token', 'sub2',
  '--clear-token', 'sub3',
  '--clear-token', 'sub4',
  '--clear-token', 'sub5',
];

const temporaryDirectories = [];
function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-hook-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function payloadWith(overrides) {
  return JSON.stringify({ ...startPayload, ...overrides });
}

function subagent(id, startedAtMs, agentType = `type-${id}`) {
  return { id, agentType, startedAtMs };
}

describe('parseHookPayload', () => {
  test('reads the real SubagentStart payload', () => {
    const event = parseHookPayload(startPayloadText);
    assert.deepEqual(event, {
      eventName: 'SubagentStart',
      sessionId: 'a2001380-6f56-4335-81b5-f2088e6c1602',
      agentId: 'a12e8c491ce2f7f4a',
      agentType: 'general-purpose',
      transcriptPath: startPayload.transcript_path,
      cwd: startPayload.cwd,
    });
  });

  test('reads the real SubagentStop payload', () => {
    const event = parseHookPayload(stopPayloadText);
    assert.equal(event.eventName, 'SubagentStop');
    assert.equal(event.agentId, 'a12e8c491ce2f7f4a');
    assert.equal(event.agentType, 'general-purpose');
  });

  test('rejects payloads it must ignore', () => {
    assert.equal(parseHookPayload('not json'), null);
    assert.equal(parseHookPayload('null'), null);
    assert.equal(parseHookPayload(payloadWith({ hook_event_name: 'PostToolUse' })), null);
    assert.equal(parseHookPayload(payloadWith({ agent_type: '' })), null);
    assert.equal(parseHookPayload(payloadWith({ agent_type: undefined })), null);
    assert.equal(parseHookPayload(payloadWith({ session_id: '../escape' })), null);
    assert.equal(parseHookPayload(payloadWith({ agent_id: 'a/b' })), null);
  });

  test('strips control characters from agent_type', () => {
    const event = parseHookPayload(payloadWith({ agent_type: '\u001b[31mExplore\n' }));
    assert.equal(event.agentType, '[31mExplore');
  });
});

describe('applyEvent', () => {
  const startEvent = parseHookPayload(startPayloadText);
  const stopEvent = parseHookPayload(stopPayloadText);

  test('start adds a running sub agent', () => {
    const { changed, state } = applyEvent(createEmptySessionState('session'), startEvent, 1000);
    assert.equal(changed, true);
    assert.deepEqual(state.subagents, [subagent('a12e8c491ce2f7f4a', 1000, 'general-purpose')]);
  });

  test('stop removes the sub agent from the state', () => {
    const started = applyEvent(createEmptySessionState('session'), startEvent, 1000).state;
    const { changed, state } = applyEvent(started, stopEvent, 2500);
    assert.equal(changed, true);
    assert.deepEqual(state.subagents, []);
    assert.equal(started.subagents.length, 1);
  });

  test('stop for a sub agent that never started is ignored', () => {
    const emptyState = createEmptySessionState('session');
    const { changed, state } = applyEvent(emptyState, stopEvent, 2500);
    assert.equal(changed, false);
    assert.equal(state, emptyState);
  });

  test('start again after stop (resume) shows it once more', () => {
    let state = applyEvent(createEmptySessionState('session'), startEvent, 1000).state;
    state = applyEvent(state, stopEvent, 2000).state;
    state = applyEvent(state, startEvent, 3000).state;
    assert.deepEqual(state.subagents, [subagent('a12e8c491ce2f7f4a', 3000, 'general-purpose')]);
  });

  test('a repeated start without stop keeps one entry and its original start time', () => {
    let state = applyEvent(createEmptySessionState('session'), startEvent, 1000).state;
    state = applyEvent(state, startEvent, 3000).state;
    assert.deepEqual(state.subagents, [subagent('a12e8c491ce2f7f4a', 1000, 'general-purpose')]);
  });
});

describe('normalizeSessionState', () => {
  test('drops finished entries left by the previous version', () => {
    const state = normalizeSessionState({
      sessionId: 'session',
      lastSequence: 42,
      subagents: [
        { id: 'old-done', agentType: 'Plan', status: 'done', startedAtMs: 1, endedAtMs: 2 },
        { id: 'old-running', agentType: 'Explore', status: 'running', startedAtMs: 3, endedAtMs: null },
        subagent('new', 4),
        null,
        { agentType: 'no-id' },
      ],
    }, 'session');
    assert.equal(state.lastSequence, 42);
    assert.deepEqual(state.subagents.map((entry) => entry.id), ['old-running', 'new']);
  });
});

describe('buildTreeLines', () => {
  test('no running sub agents gives no lines', () => {
    assert.deepEqual(buildTreeLines([]), []);
  });

  test('single sub agent uses the last-branch glyph', () => {
    assert.deepEqual(buildTreeLines([subagent('a', 1, 'general-purpose')]), ['└─ general-purpose ●']);
  });

  test('ordered by start time', () => {
    const lines = buildTreeLines([
      subagent('late', 30, 'late'),
      subagent('early', 5, 'early'),
      subagent('middle', 10, 'middle'),
    ]);
    assert.deepEqual(lines, [
      '├─ early ●',
      '├─ middle ●',
      '└─ late ●',
    ]);
  });

  test('exactly five fit without a more line', () => {
    const subagents = [1, 2, 3, 4, 5].map((index) => subagent(`s${index}`, index));
    const lines = buildTreeLines(subagents);
    assert.equal(lines.length, 5);
    assert.equal(lines[4], '└─ type-s5 ●');
  });

  test('overflow collapses the last line into +N more', () => {
    const subagents = [1, 2, 3, 4, 5, 6, 7].map((index) => subagent(`s${index}`, index));
    const lines = buildTreeLines(subagents);
    assert.deepEqual(lines, [
      '├─ type-s1 ●',
      '├─ type-s2 ●',
      '├─ type-s3 ●',
      '├─ type-s4 ●',
      '└─ +3 more',
    ]);
  });

  test('lines never contain numbering or a finished mark', () => {
    const lines = buildTreeLines([subagent('a', 1, 'Plan'), subagent('b', 2, 'Explore')]);
    for (const line of lines) {
      assert.match(line, /^(├─|└─) [A-Za-z]+ ●$/);
    }
  });
});

describe('formatTreeLine', () => {
  test('truncates long agent types to 80 characters and keeps the icon', () => {
    const line = formatTreeLine('├─', 'x'.repeat(200));
    assert.equal(Array.from(line).length, maximumTokenLength);
    assert.ok(line.endsWith('x… ●'));
  });

  test('counts characters, not UTF-16 units', () => {
    const line = formatTreeLine('└─', '代'.repeat(100));
    assert.equal(Array.from(line).length, maximumTokenLength);
    assert.ok(line.startsWith('└─ 代'));
    assert.ok(line.endsWith('… ●'));
  });

  test('short agent types are untouched', () => {
    assert.equal(formatTreeLine('├─', 'Explore'), '├─ Explore ●');
  });
});

describe('buildMetadataArguments', () => {
  test('sets used tokens and clears the rest under one source', () => {
    const argumentList = buildMetadataArguments('w8:pV', ['├─ Plan ●', '└─ Explore ●'], 1234);
    assert.deepEqual(argumentList, [
      'pane', 'report-metadata', 'w8:pV',
      '--source', 'subagent.watch',
      '--seq', '1234',
      '--token', 'sub1=├─ Plan ●',
      '--token', 'sub2=└─ Explore ●',
      '--clear-token', 'sub3',
      '--clear-token', 'sub4',
      '--clear-token', 'sub5',
    ]);
  });

  test('no lines clears all five tokens', () => {
    assert.deepEqual(buildMetadataArguments('w8:pV', [], 1234).slice(7), allTokensCleared);
  });
});

describe('nextSequence', () => {
  test('follows the clock and stays strictly increasing', () => {
    assert.equal(nextSequence(0, 5000), 5000);
    assert.equal(nextSequence(5000, 5000), 5001);
    assert.equal(nextSequence(9000, 5000), 9001);
    assert.equal(nextSequence(undefined, 5000), 5000);
  });
});

describe('countClaudeAncestors', () => {
  const processTable = {
    50: { command: 'node', parentProcessId: 40 },
    40: { command: 'bash', parentProcessId: 30 },
    30: { command: 'claude', parentProcessId: 20 },
    20: { command: 'bash', parentProcessId: 10 },
    10: { command: 'claude', parentProcessId: 5 },
    5: { command: 'fish', parentProcessId: 1 },
  };
  const readInfo = (processId) => processTable[processId] ?? null;

  test('counts every claude process up the chain', () => {
    assert.equal(countClaudeAncestors(50, readInfo), 2);
    assert.equal(countClaudeAncestors(20, readInfo), 1);
    assert.equal(countClaudeAncestors(5, readInfo), 0);
  });

  test('stops quietly when the process table is unreadable', () => {
    assert.equal(countClaudeAncestors(999, readInfo), 0);
  });
});

describe('runHook', () => {
  function createHarness(overrides = {}) {
    const runtimeDirectory = createTemporaryDirectory();
    const herdrCalls = [];
    let clockMs = 1_000_000;
    const dependencies = {
      now: () => clockMs,
      runHerdr: (binaryPath, argumentList, timeoutMs) => {
        herdrCalls.push({ binaryPath, argumentList, timeoutMs });
      },
      isExecutable: () => true,
      queryPaneAgentSession: () => ({ agent: 'claude', sessionId: startPayload.session_id }),
      countClaudeAncestors: () => 1,
      deadlineMs: Number.POSITIVE_INFINITY,
      ...overrides,
    };
    const environment = {
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: '/fake/herdr',
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    return {
      runtimeDirectory,
      stateDirectory: join(runtimeDirectory, 'subagent-watch'),
      herdrCalls,
      environment,
      dependencies,
      advanceClock: (durationMs) => {
        clockMs += durationMs;
      },
    };
  }

  test('start then stop updates state, pane mapping and herdr tokens', () => {
    const harness = createHarness();
    const startResult = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(startResult.action, 'reported');
    assert.deepEqual(startResult.lines, ['└─ general-purpose ●']);
    assert.equal(harness.herdrCalls.length, 1);
    assert.equal(harness.herdrCalls[0].binaryPath, '/fake/herdr');
    assert.deepEqual(harness.herdrCalls[0].argumentList.slice(0, 7), [
      'pane', 'report-metadata', testPaneId, '--source', 'subagent.watch', '--seq', '1000000',
    ]);

    const paneMapping = JSON.parse(readFileSync(join(harness.stateDirectory, `pane-${testPaneId}.json`), 'utf8'));
    assert.deepEqual(Object.keys(paneMapping).sort(), ['cwd', 'sessionId', 'transcriptPath', 'updatedAtMs']);
    assert.equal(paneMapping.sessionId, startPayload.session_id);
    assert.equal(paneMapping.transcriptPath, startPayload.transcript_path);
    assert.equal(paneMapping.cwd, startPayload.cwd);
    assert.equal(paneMapping.updatedAtMs, 1_000_000);

    const sessionStatePath = join(harness.stateDirectory, `session-${startPayload.session_id}.json`);
    let sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf8'));
    assert.deepEqual(sessionState.subagents, [
      subagent('a12e8c491ce2f7f4a', 1_000_000, 'general-purpose'),
    ]);

    harness.advanceClock(2000);
    const stopResult = runHook(stopPayloadText, harness.environment, harness.dependencies);
    assert.equal(stopResult.action, 'reported');
    assert.deepEqual(stopResult.lines, []);
    assert.equal(harness.herdrCalls[1].argumentList[6], '1002000');
    assert.deepEqual(harness.herdrCalls[1].argumentList.slice(7), allTokensCleared);
    sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf8'));
    assert.deepEqual(sessionState.subagents, []);
    assert.equal(sessionState.lastSequence, 1_002_000);

    const leftovers = readdirSync(harness.stateDirectory).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('start two, stop one, stop the other: two lines, then one └─ line, then everything cleared', () => {
    const harness = createHarness();
    const firstStart = payloadWith({ agent_id: 'first', agent_type: 'Explore' });
    const secondStart = payloadWith({ agent_id: 'second', agent_type: 'Plan' });
    const firstStop = payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'first', agent_type: 'Explore' });
    const secondStop = payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'second', agent_type: 'Plan' });

    runHook(firstStart, harness.environment, harness.dependencies);
    harness.advanceClock(10);
    const bothRunning = runHook(secondStart, harness.environment, harness.dependencies);
    assert.deepEqual(bothRunning.lines, ['├─ Explore ●', '└─ Plan ●']);

    harness.advanceClock(10);
    const oneLeft = runHook(firstStop, harness.environment, harness.dependencies);
    assert.deepEqual(oneLeft.lines, ['└─ Plan ●']);
    assert.deepEqual(oneLeft.argumentList.slice(7), [
      '--token', 'sub1=└─ Plan ●',
      '--clear-token', 'sub2',
      '--clear-token', 'sub3',
      '--clear-token', 'sub4',
      '--clear-token', 'sub5',
    ]);

    harness.advanceClock(10);
    const noneLeft = runHook(secondStop, harness.environment, harness.dependencies);
    assert.deepEqual(noneLeft.lines, []);
    assert.deepEqual(noneLeft.argumentList.slice(7), allTokensCleared);
    assert.equal(harness.herdrCalls.length, 4);
  });

  test('+N more only counts sub agents that are still running', () => {
    const harness = createHarness();
    for (let index = 1; index <= 7; index += 1) {
      harness.advanceClock(10);
      runHook(payloadWith({ agent_id: `s${index}`, agent_type: `worker${index}` }), harness.environment, harness.dependencies);
    }
    assert.equal(harness.herdrCalls.at(-1).argumentList.at(-1), 'sub5=└─ +3 more');

    const stop = (index) => {
      harness.advanceClock(10);
      return runHook(
        payloadWith({ hook_event_name: 'SubagentStop', agent_id: `s${index}`, agent_type: `worker${index}` }),
        harness.environment,
        harness.dependencies,
      );
    };
    assert.deepEqual(stop(1).lines, [
      '├─ worker2 ●',
      '├─ worker3 ●',
      '├─ worker4 ●',
      '├─ worker5 ●',
      '└─ +2 more',
    ]);
    assert.deepEqual(stop(4).lines, [
      '├─ worker2 ●',
      '├─ worker3 ●',
      '├─ worker5 ●',
      '├─ worker6 ●',
      '└─ worker7 ●',
    ]);
  });

  test('a state file from the previous version drops its finished sub agents on the next event', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    const sessionStatePath = join(harness.stateDirectory, `session-${startPayload.session_id}.json`);
    writeFileSync(sessionStatePath, JSON.stringify({
      sessionId: startPayload.session_id,
      lastSequence: 1_000_000,
      subagents: [
        { id: 'a12e8c491ce2f7f4a', agentType: 'general-purpose', status: 'running', startedAtMs: 1_000_000, endedAtMs: null },
        { id: 'finished', agentType: 'Plan', status: 'done', startedAtMs: 900_000, endedAtMs: 950_000 },
      ],
    }));
    harness.advanceClock(10);
    const result = runHook(payloadWith({ agent_id: 'second', agent_type: 'Explore' }), harness.environment, harness.dependencies);
    assert.deepEqual(result.lines, ['├─ general-purpose ●', '└─ Explore ●']);
    const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf8'));
    assert.deepEqual(sessionState.subagents.map((entry) => entry.id), ['a12e8c491ce2f7f4a', 'second']);
  });

  test('two events in the same millisecond still get increasing seq', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    runHook(payloadWith({ agent_id: 'second', agent_type: 'Explore' }), harness.environment, harness.dependencies);
    assert.equal(harness.herdrCalls[0].argumentList[6], '1000000');
    assert.equal(harness.herdrCalls[1].argumentList[6], '1000001');
    assert.deepEqual(harness.herdrCalls[1].argumentList.slice(7, 11), [
      '--token', 'sub1=├─ general-purpose ●',
      '--token', 'sub2=└─ Explore ●',
    ]);
  });

  test('stop for an unknown sub agent does not call herdr', () => {
    const harness = createHarness();
    const result = runHook(stopPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.action, 'unchanged');
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('outside herdr nothing is written and herdr is not called', () => {
    const harness = createHarness();
    const environment = { ...harness.environment, HERDR_PANE_ID: undefined };
    assert.deepEqual(runHook(startPayloadText, environment, harness.dependencies), {
      action: 'skipped',
      reason: 'not-in-herdr',
    });
    assert.equal(existsSync(harness.stateDirectory), false);
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('missing herdr binary is skipped quietly', () => {
    const harness = createHarness({ isExecutable: () => false });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.reason, 'herdr-not-found');
    assert.equal(existsSync(harness.stateDirectory), false);
  });

  test('without HERDR_BIN_PATH, herdr is looked up on PATH instead of a fixed install path', () => {
    const checkedPaths = [];
    const harness = createHarness({
      isExecutable: (filePath) => {
        checkedPaths.push(filePath);
        return filePath === '/second/bin/herdr';
      },
    });
    const environment = { ...harness.environment, HERDR_BIN_PATH: undefined, PATH: '/first/bin:/second/bin:/third/bin' };
    const result = runHook(startPayloadText, environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(harness.herdrCalls[0].binaryPath, '/second/bin/herdr');
    assert.deepEqual(checkedPaths.slice(0, 2), ['/first/bin/herdr', '/second/bin/herdr']);
    assert.ok(!checkedPaths.includes('/third/bin/herdr'));
  });

  test('without HERDR_BIN_PATH and without herdr on PATH the hook skips quietly', () => {
    const harness = createHarness({ isExecutable: () => false });
    const environment = { ...harness.environment, HERDR_BIN_PATH: undefined, PATH: '/first/bin:/second/bin' };
    const result = runHook(startPayloadText, environment, harness.dependencies);
    assert.equal(result.reason, 'herdr-not-found');
    assert.equal(existsSync(harness.stateDirectory), false);
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('without a session from herdr, nested claude -p inside a claude pane is ignored', () => {
    const harness = createHarness({ queryPaneAgentSession: () => null, countClaudeAncestors: () => 2 });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.reason, 'nested-claude');
    assert.equal(existsSync(harness.stateDirectory), false);
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('corrupt session state is replaced instead of crashing', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    writeFileSync(join(harness.stateDirectory, `session-${startPayload.session_id}.json`), '{broken');
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.lines, ['└─ general-purpose ●']);
  });
});

describe('hook script as Claude Code runs it', () => {
  function runScript(environment, inputText) {
    const startedAtMs = Date.now();
    const result = spawnSync(process.execPath, [hookScriptPath], {
      input: inputText,
      env: environment,
      encoding: 'utf8',
      timeout: 5000,
    });
    return { ...result, elapsedMs: Date.now() - startedAtMs };
  }

  // 假 herdr：`pane get` 回報這個 pane 的 claude session，其他呼叫記到 log；兩種都故意往 stdout 印東西，確認不會漏進 hook 的輸出
  function writeFakeHerdr(workDirectory, callLogPath) {
    const fakeHerdrPath = join(workDirectory, 'herdr');
    const paneGetOutput = JSON.stringify({
      result: { pane: { agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: startPayload.session_id } } },
    });
    writeFileSync(
      fakeHerdrPath,
      [
        `#!${process.execPath}`,
        'const argumentList = process.argv.slice(2);',
        `if (argumentList[0] === 'pane' && argumentList[1] === 'get') { process.stdout.write(${JSON.stringify(paneGetOutput)}); process.exit(0); }`,
        `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(argumentList) + '\\n');`,
        `process.stdout.write('noise that must not leak');`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return fakeHerdrPath;
  }

  function createScriptCase() {
    const workDirectory = createTemporaryDirectory();
    const runtimeDirectory = join(workDirectory, 'runtime');
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    const callLogPath = join(workDirectory, 'herdr-calls.jsonl');
    const environment = {
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: runtimeDirectory,
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: writeFakeHerdr(workDirectory, callLogPath),
    };
    return { runtimeDirectory, callLogPath, environment };
  }

  test('outside herdr: exit 0, no output, nothing written, under 1 second', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const result = runScript({ PATH: process.env.PATH, XDG_RUNTIME_DIR: runtimeDirectory }, startPayloadText);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(runtimeDirectory), []);
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
  });

  test('garbage input: exit 0 and no output', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const result = runScript({
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: runtimeDirectory,
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: '/nonexistent/herdr',
    }, '\u0000garbage');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('inside herdr: calls herdr with the tree tokens, no output, under 1 second', () => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const result = runScript(environment, startPayloadText);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), ['pane', 'report-metadata', testPaneId, '--source', 'subagent.watch']);
    assert.ok(calls[0].includes('sub1=└─ general-purpose ●'));
    assert.ok(existsSync(join(runtimeDirectory, 'subagent-watch', `pane-${testPaneId}.json`)));
  });

  test('an event from another session in the same pane (nested claude -p) is skipped by the script', () => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const result = runScript(environment, payloadWith({ session_id: 'nested-session-0000' }));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(callLogPath), false);
    assert.deepEqual(readdirSync(runtimeDirectory), []);
  });

  test('parallel starts are all recorded and the newest seq shows every sub agent', async () => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const parallelCount = 6;
    const runs = Array.from({ length: parallelCount }, (unused, index) => {
      return new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [hookScriptPath], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.on('close', (status) => {
          resolvePromise({ status, output });
        });
        child.stdin.end(payloadWith({ agent_id: `parallel${index}`, agent_type: `worker${index}` }));
      });
    });
    const results = await Promise.all(runs);
    for (const result of results) {
      assert.equal(result.status, 0);
      assert.equal(result.output, '');
    }
    const sessionState = JSON.parse(readFileSync(
      join(runtimeDirectory, 'subagent-watch', `session-${startPayload.session_id}.json`),
      'utf8',
    ));
    assert.equal(sessionState.subagents.length, parallelCount);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, parallelCount);
    const newestCall = calls.reduce((newest, call) => (Number(call[6]) > Number(newest[6]) ? call : newest));
    assert.ok(newestCall.includes('sub5=└─ +2 more'));
    const sequences = calls.map((call) => Number(call[6]));
    assert.equal(new Set(sequences).size, parallelCount);
  });
});

describe('the session herdr reports for the pane decides who may update it', () => {
  const herdrFixtureDirectory = join(testDirectory, 'fixtures', 'herdr');
  const readHerdrFixture = (name) => readFileSync(join(herdrFixtureDirectory, name), 'utf8');

  function createHarness(overrides = {}) {
    const runtimeDirectory = createTemporaryDirectory();
    const herdrCalls = [];
    const paneQueries = [];
    const dependencies = {
      now: () => 1_000_000,
      runHerdr: (binaryPath, argumentList) => {
        herdrCalls.push(argumentList);
      },
      isExecutable: () => true,
      queryPaneAgentSession: (binaryPath, paneId, timeoutMs) => {
        paneQueries.push({ binaryPath, paneId, timeoutMs });
        return null;
      },
      countClaudeAncestors: () => 1,
      deadlineMs: Number.POSITIVE_INFINITY,
      ...overrides,
    };
    const environment = { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory };
    return { runtimeDirectory, herdrCalls, paneQueries, dependencies, environment };
  }

  test('agent_session from `herdr pane get` is read as a session id', () => {
    assert.deepEqual(parsePaneAgentSession(readHerdrFixture('pane-get-claude.json')), {
      agent: 'claude',
      sessionId: 'aaaa1111-0000-4000-8000-00000000c1a0',
    });
    assert.equal(parsePaneAgentSession(readHerdrFixture('pane-get-claude-without-session.json')), null);
    assert.equal(parsePaneAgentSession(readHerdrFixture('pane-get-codex.json')), null);
    assert.equal(parsePaneAgentSession(readHerdrFixture('pane-get-shell.json')), null);
    assert.equal(parsePaneAgentSession('noise'), null);
    assert.equal(parsePaneAgentSession(JSON.stringify({ result: { pane: { agent_session: { value: 42 } } } })), null);
  });

  test('an agent_session holding a transcript path is reduced to its session id', () => {
    const output = JSON.stringify({ result: { pane: { agent_session: { agent: 'claude', value: '/home/u/.claude/projects/-x/abc-123.jsonl' } } } });
    assert.deepEqual(parsePaneAgentSession(output), { agent: 'claude', sessionId: 'abc-123' });
  });

  test('a claude wrapper (two claude ancestors) still updates the sidebar when herdr says it is the pane session', () => {
    const harness = createHarness({
      queryPaneAgentSession: () => ({ agent: 'claude', sessionId: startPayload.session_id }),
      countClaudeAncestors: () => 2,
    });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(harness.herdrCalls.length, 1);
  });

  test('another session in the same pane (nested claude -p) is skipped without writing anything', () => {
    const harness = createHarness({
      queryPaneAgentSession: () => ({ agent: 'claude', sessionId: 'main-session' }),
      countClaudeAncestors: () => 1,
    });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.deepEqual(result, { action: 'skipped', reason: 'not-pane-session' });
    assert.deepEqual(readdirSync(harness.runtimeDirectory), []);
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('a pane whose session belongs to another agent is skipped', () => {
    const harness = createHarness({ queryPaneAgentSession: () => ({ agent: 'codex', sessionId: startPayload.session_id }) });
    assert.equal(runHook(startPayloadText, harness.environment, harness.dependencies).reason, 'not-pane-session');
  });

  test('without a session from herdr the ancestor scan decides', () => {
    const single = createHarness({ countClaudeAncestors: () => 1 });
    assert.equal(runHook(startPayloadText, single.environment, single.dependencies).action, 'reported');
    const nested = createHarness({ countClaudeAncestors: () => 2 });
    assert.equal(runHook(startPayloadText, nested.environment, nested.dependencies).reason, 'nested-claude');
  });

  test('the pane query gets the pane id and a timeout that leaves room for the report', () => {
    const harness = createHarness({ deadlineMs: 1_000_250 });
    runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.deepEqual(harness.paneQueries, [{ binaryPath: '/fake/herdr', paneId: testPaneId, timeoutMs: 150 }]);

    const unbounded = createHarness();
    runHook(startPayloadText, unbounded.environment, unbounded.dependencies);
    assert.equal(unbounded.paneQueries[0].timeoutMs, 300);

    const outOfTime = createHarness({ deadlineMs: 1_000_100 });
    runHook(startPayloadText, outOfTime.environment, outOfTime.dependencies);
    assert.deepEqual(outOfTime.paneQueries, [], 'no time left: skip the query and fall back to the ancestor scan');
  });

  test('a claude wrapper directly above claude counts once; claude -p behind a shell still counts twice', () => {
    const wrapperTable = {
      50: { command: 'node', parentProcessId: 40 },
      40: { command: 'sh', parentProcessId: 30 },
      30: { command: 'claude', parentProcessId: 20 },
      20: { command: 'claude', parentProcessId: 10 },
      10: { command: 'fish', parentProcessId: 1 },
    };
    assert.equal(countClaudeAncestors(50, (processId) => wrapperTable[processId] ?? null), 1);
    const nestedBehindWrapper = {
      ...wrapperTable,
      20: { command: 'claude', parentProcessId: 15 },
      15: { command: 'bash', parentProcessId: 12 },
      12: { command: 'claude', parentProcessId: 11 },
      11: { command: 'claude', parentProcessId: 10 },
    };
    assert.equal(countClaudeAncestors(50, (processId) => nestedBehindWrapper[processId] ?? null), 2);
  });
});

describe('invisible characters in agent_type', () => {
  test('bidi controls and zero-width characters are removed along with control characters', () => {
    assert.equal(sanitizeText('‮evil‬'), 'evil');
    assert.equal(sanitizeText('a⁦b⁧c⁨d⁩'), 'abcd');
    assert.equal(sanitizeText('x​y‌z‍‎‏'), 'xyz');
    assert.equal(sanitizeText('‪‫‭plan﻿⁠'), 'plan');
    assert.equal(sanitizeText('代理 Explore'), '代理 Explore');
  });

  test('the review PoC agent_type reaches herdr without any Cc or Cf character', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const herdrCalls = [];
    const result = runHook(
      payloadWith({ agent_type: 'gp\u001b]52;c;QQ==\u0007\u009b2J‮evil⁦' }),
      { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory },
      {
        now: () => 1_000_000,
        isExecutable: () => true,
        queryPaneAgentSession: () => null,
        countClaudeAncestors: () => 1,
        runHerdr: (binaryPath, argumentList) => {
          herdrCalls.push(argumentList);
        },
        deadlineMs: Number.POSITIVE_INFINITY,
      },
    );
    assert.equal(result.action, 'reported');
    const tokens = herdrCalls[0].filter((argument) => argument.startsWith('sub1='));
    assert.deepEqual(tokens, ['sub1=└─ gp]52;c;QQ==2Jevil ●']);
    for (const argument of herdrCalls[0]) {
      assert.doesNotMatch(argument, /[\p{Cc}\p{Cf}]/u);
    }
  });
});

describe('state folder in XDG_RUNTIME_DIR', () => {
  const baseDependencies = {
    now: () => 1_000_000,
    isExecutable: () => true,
    queryPaneAgentSession: () => null,
    countClaudeAncestors: () => 1,
    runHerdr: () => {},
    deadlineMs: Number.POSITIVE_INFINITY,
  };
  const environmentFor = (runtimeDirectory) => ({ HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory });

  test('a subagent-watch folder that is a symlink is not used', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const elsewhere = createTemporaryDirectory();
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(runtimeDirectory, 'subagent-watch'));
    const result = runHook(startPayloadText, environmentFor(runtimeDirectory), baseDependencies);
    assert.deepEqual(result, { action: 'skipped', reason: 'unsafe-state-directory' });
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  test('review PoC: a world-writable folder with a symlink planted at the old temp name is not written through', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    mkdirSync(stateDirectory);
    chmodSync(stateDirectory, 0o777);
    const victimPath = join(createTemporaryDirectory(), 'victim.txt');
    writeFileSync(victimPath, 'original\n');
    symlinkSync(victimPath, join(stateDirectory, `pane-${testPaneId}.json.${process.pid}.tmp`));
    const result = runHook(startPayloadText, environmentFor(runtimeDirectory), baseDependencies);
    assert.equal(result.reason, 'unsafe-state-directory');
    assert.equal(readFileSync(victimPath, 'utf8'), 'original\n');
  });

  test('a folder owned by another user is not used', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const result = runHook(startPayloadText, environmentFor(runtimeDirectory), { ...baseDependencies, getUserId: () => process.getuid() + 1 });
    assert.equal(result.reason, 'unsafe-state-directory');
  });

  test('prepareStateDirectory accepts only an own, real, 0700 folder', () => {
    const runtimeDirectory = createTemporaryDirectory();
    assert.equal(prepareStateDirectory(runtimeDirectory, process.getuid()), join(runtimeDirectory, 'subagent-watch'));
    assert.equal(statSync(join(runtimeDirectory, 'subagent-watch')).mode & 0o777, 0o700);
    chmodSync(join(runtimeDirectory, 'subagent-watch'), 0o750);
    assert.equal(prepareStateDirectory(runtimeDirectory, process.getuid()), null);
    assert.equal(prepareStateDirectory(join(runtimeDirectory, 'missing'), process.getuid()), null);
    assert.equal(existsSync(join(runtimeDirectory, 'missing')), false, 'XDG_RUNTIME_DIR itself is never created');
  });

  test('symlinks planted at the old predictable temp names in an own folder are left alone', () => {
    const runtimeDirectory = createTemporaryDirectory();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    mkdirSync(stateDirectory, { mode: 0o700 });
    const victimPath = join(createTemporaryDirectory(), 'victim.txt');
    writeFileSync(victimPath, 'original\n');
    symlinkSync(victimPath, join(stateDirectory, `pane-${testPaneId}.json.${process.pid}.tmp`));
    symlinkSync(victimPath, join(stateDirectory, `session-${startPayload.session_id}.json.${process.pid}.tmp`));
    const result = runHook(startPayloadText, environmentFor(runtimeDirectory), baseDependencies);
    assert.equal(result.action, 'reported');
    assert.equal(readFileSync(victimPath, 'utf8'), 'original\n');
    const leftovers = readdirSync(stateDirectory).filter((name) => /\.(lock|tmp)$|\.break-/.test(name) && !name.endsWith(`.${process.pid}.tmp`));
    assert.deepEqual(leftovers, []);
  });
});

describe('session lock', () => {
  function createLockCase(overrides = {}) {
    const runtimeDirectory = createTemporaryDirectory();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    mkdirSync(stateDirectory, { mode: 0o700 });
    const lockPath = join(stateDirectory, `session-${startPayload.session_id}.json.lock`);
    const herdrCalls = [];
    const dependencies = {
      now: () => Date.now(),
      isExecutable: () => true,
      queryPaneAgentSession: () => null,
      countClaudeAncestors: () => 1,
      runHerdr: (binaryPath, argumentList) => {
        herdrCalls.push(argumentList);
      },
      deadlineMs: Date.now() + 400,
      ...overrides,
    };
    const environment = { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory };
    return { stateDirectory, lockPath, herdrCalls, dependencies, environment };
  }

  function makeOld(filePath, ageMs) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(filePath, old, old);
  }

  function deadProcessId() {
    return spawnSync(process.execPath, ['-e', '']).pid;
  }

  const ownStartTime = readProcessInfo(process.pid).startTime;

  test('the lock holds the pid and start time of its holder while the state is updated', () => {
    let lockOwner = null;
    const lockCase = createLockCase({
      runHerdr: () => {
        lockOwner = JSON.parse(readFileSync(lockCase.lockPath, 'utf8'));
      },
    });
    assert.equal(runHook(startPayloadText, lockCase.environment, lockCase.dependencies).action, 'reported');
    assert.equal(lockOwner.pid, process.pid);
    assert.equal(lockOwner.startTime, ownStartTime);
    assert.equal(typeof lockOwner.createdAtMs, 'number');
    assert.equal(existsSync(lockCase.lockPath), false);
  });

  test('a lock whose holder has exited is taken over right away, even when it is brand new', () => {
    const lockCase = createLockCase();
    writeFileSync(lockCase.lockPath, JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() }));
    const result = runHook(startPayloadText, lockCase.environment, lockCase.dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(existsSync(lockCase.lockPath), false);
  });

  test('a lock held by a live process is never removed: the hook gives up within its budget', () => {
    const lockCase = createLockCase({ deadlineMs: Date.now() + 300 });
    writeFileSync(lockCase.lockPath, JSON.stringify({ pid: process.pid, startTime: ownStartTime, createdAtMs: Date.now() }));
    makeOld(lockCase.lockPath, 5000);
    const before = statSync(lockCase.lockPath);
    const startedAtMs = Date.now();
    const result = runHook(startPayloadText, lockCase.environment, lockCase.dependencies);
    assert.deepEqual(result, { action: 'skipped', reason: 'lock-timeout' });
    assert.ok(Date.now() - startedAtMs < 400, `took ${Date.now() - startedAtMs}ms`);
    assert.equal(statSync(lockCase.lockPath).ino, before.ino);
    assert.equal(lockCase.herdrCalls.length, 0);
    rmSync(lockCase.lockPath);
  });

  test('a reused pid (same pid, different start time) counts as gone', () => {
    const lockCase = createLockCase();
    writeFileSync(lockCase.lockPath, JSON.stringify({ pid: process.pid, startTime: `${ownStartTime}9`, createdAtMs: Date.now() }));
    assert.equal(runHook(startPayloadText, lockCase.environment, lockCase.dependencies).action, 'reported');
  });

  test('an empty lock from the previous version is stale only after 2 seconds', () => {
    const fresh = createLockCase({ deadlineMs: Date.now() + 250 });
    writeFileSync(fresh.lockPath, '');
    assert.equal(runHook(startPayloadText, fresh.environment, fresh.dependencies).reason, 'lock-timeout');
    assert.equal(existsSync(fresh.lockPath), true);
    rmSync(fresh.lockPath);

    const old = createLockCase();
    writeFileSync(old.lockPath, '');
    makeOld(old.lockPath, 3000);
    assert.equal(runHook(startPayloadText, old.environment, old.dependencies).action, 'reported');
  });

  test('a .break file left by a killed process blocks takeover only until it is 2 seconds old', async () => {
    const lockCase = createLockCase({ deadlineMs: Date.now() + 250 });
    writeFileSync(lockCase.lockPath, JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() }));
    const breakPath = `${lockCase.lockPath}.break-${statSync(lockCase.lockPath).ino}`;
    linkSync(lockCase.lockPath, breakPath);
    assert.equal(runHook(startPayloadText, lockCase.environment, lockCase.dependencies).reason, 'lock-timeout');
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 2100);
    });
    const result = runHook(startPayloadText, lockCase.environment, { ...lockCase.dependencies, deadlineMs: Date.now() + 400 });
    assert.equal(result.action, 'reported');
    assert.equal(existsSync(breakPath), false);
    assert.equal(existsSync(lockCase.lockPath), false);
  });

  // ext4 會把剛釋放的 inode 馬上給下一個新檔，tmpfs 不會：刪掉再建時 inode 同不同由檔案系統決定，兩種都要守住
  test('review race: a lock judged stale but replaced by a fresh one before the takeover is left alone', () => {
    const lockCase = createLockCase();
    const staleContent = JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() });
    writeFileSync(lockCase.lockPath, staleContent);
    const staleInode = statSync(lockCase.lockPath).ino;
    // 另一個 process 在這段時間接管了失效的 lock 並建好自己的
    rmSync(lockCase.lockPath);
    const freshContent = JSON.stringify({ pid: process.pid, startTime: ownStartTime, createdAtMs: Date.now() });
    writeFileSync(lockCase.lockPath, freshContent);
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode, staleContent), false);
    assert.equal(readFileSync(lockCase.lockPath, 'utf8'), freshContent);
    assert.deepEqual(readdirSync(lockCase.stateDirectory).filter((name) => name.includes('.break-')), []);
    rmSync(lockCase.lockPath);
  });

  // 刪掉再建不保證拿到同一個 inode；就地覆寫內容才能在任何檔案系統上穩定做出「inode 相同、內容不同」的新 lock
  test('review race: a fresh lock that reuses the stale lock\'s inode is left alone', () => {
    const lockCase = createLockCase();
    const staleContent = JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() });
    writeFileSync(lockCase.lockPath, staleContent);
    const staleInode = statSync(lockCase.lockPath).ino;
    const freshContent = JSON.stringify({ pid: process.pid, startTime: ownStartTime, createdAtMs: Date.now() });
    writeFileSync(lockCase.lockPath, freshContent);
    assert.equal(statSync(lockCase.lockPath).ino, staleInode);
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode, staleContent), false);
    assert.equal(existsSync(lockCase.lockPath), true, 'the fresh lock on the reused inode must survive');
    assert.equal(readFileSync(lockCase.lockPath, 'utf8'), freshContent);
    assert.deepEqual(readdirSync(lockCase.stateDirectory).filter((name) => name.includes('.break-')), []);
    rmSync(lockCase.lockPath);
  });

  test('only one of two takeovers of the same stale lock succeeds', () => {
    const lockCase = createLockCase();
    const staleContent = JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() });
    writeFileSync(lockCase.lockPath, staleContent);
    const staleInode = statSync(lockCase.lockPath).ino;
    const breakPath = `${lockCase.lockPath}.break-${staleInode}`;
    linkSync(lockCase.lockPath, breakPath);
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode, staleContent), false, 'someone else holds the .break name');
    assert.equal(statSync(lockCase.lockPath).ino, staleInode);
    rmSync(breakPath);
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode, staleContent), true);
    assert.equal(existsSync(lockCase.lockPath), false);
  });

  test('a takeover without the content it judged stale removes nothing', () => {
    const lockCase = createLockCase();
    writeFileSync(lockCase.lockPath, JSON.stringify({ pid: deadProcessId(), startTime: '1', createdAtMs: Date.now() }));
    const staleInode = statSync(lockCase.lockPath).ino;
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode), false);
    assert.equal(breakStaleLock(lockCase.lockPath, staleInode, null), false);
    assert.equal(statSync(lockCase.lockPath).ino, staleInode);
    assert.deepEqual(readdirSync(lockCase.stateDirectory).filter((name) => name.includes('.break-')), []);
    rmSync(lockCase.lockPath);
  });

  test('releasing never deletes another lock that reuses this run\'s inode', () => {
    const otherContent = JSON.stringify({ pid: process.pid, startTime: `${ownStartTime}9`, createdAtMs: Date.now() });
    let ownInode = null;
    const lockCase = createLockCase({
      runHerdr: () => {
        ownInode = statSync(lockCase.lockPath).ino;
        // 等同「這次的 lock 被當成失效接管、別人新建的 lock 拿到同一個 inode」
        writeFileSync(lockCase.lockPath, otherContent);
      },
    });
    assert.equal(runHook(startPayloadText, lockCase.environment, lockCase.dependencies).action, 'reported');
    assert.equal(existsSync(lockCase.lockPath), true, 'the lock on the reused inode must survive our release');
    assert.equal(statSync(lockCase.lockPath).ino, ownInode);
    assert.equal(readFileSync(lockCase.lockPath, 'utf8'), otherContent);
    rmSync(lockCase.lockPath);
  });

  test('releasing never deletes a lock that is no longer the one this run created', () => {
    const lockCase = createLockCase({
      runHerdr: () => {
        const replacementPath = `${lockCase.lockPath}.replacement`;
        writeFileSync(replacementPath, JSON.stringify({ pid: process.pid, startTime: ownStartTime, createdAtMs: Date.now() }));
        renameSync(replacementPath, lockCase.lockPath);
      },
    });
    assert.equal(runHook(startPayloadText, lockCase.environment, lockCase.dependencies).action, 'reported');
    assert.equal(existsSync(lockCase.lockPath), true, 'the lock that replaced ours must survive our release');
    rmSync(lockCase.lockPath);
  });

  test('lock owners: only positive integer pids are accepted, and a missing process is gone', () => {
    assert.equal(parseLockOwner(''), null);
    assert.equal(parseLockOwner(JSON.stringify({ pid: 0 })), null);
    assert.equal(parseLockOwner(JSON.stringify({ pid: -1 })), null);
    assert.equal(parseLockOwner(JSON.stringify({ pid: '12' })), null);
    assert.deepEqual(parseLockOwner(JSON.stringify({ pid: 12, startTime: '34' })), { pid: 12, startTime: '34' });
    assert.equal(isLockOwnerGone({ pid: deadProcessId(), startTime: null }), true);
    assert.equal(isLockOwnerGone({ pid: process.pid, startTime: ownStartTime }), false);
    assert.equal(isLockOwnerGone({ pid: process.pid, startTime: null }), false);
    assert.equal(isLockOwnerGone({ pid: process.pid, startTime: ownStartTime }, () => ({ state: 'Z', startTime: ownStartTime })), true);
  });
});
