import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyEvent,
  buildMetadataArguments,
  buildTreeLines,
  countClaudeAncestors,
  createEmptySessionState,
  formatTreeLine,
  maximumTokenLength,
  nextSequence,
  normalizeSessionState,
  parseHookPayload,
  runHook,
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

  test('nested claude -p inside a claude pane is ignored', () => {
    const harness = createHarness({ countClaudeAncestors: () => 2 });
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

  const nestedReason = countClaudeAncestors(process.pid) >= 2 ? 'test runner itself runs under a nested claude' : false;
  test('inside herdr: calls herdr with the tree tokens, no output, under 1 second', { skip: nestedReason }, () => {
    const workDirectory = createTemporaryDirectory();
    const runtimeDirectory = join(workDirectory, 'runtime');
    const callLogPath = join(workDirectory, 'herdr-calls.jsonl');
    const fakeHerdrPath = join(workDirectory, 'herdr');
    writeFileSync(
      fakeHerdrPath,
      [
        `#!${process.execPath}`,
        `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        `process.stdout.write('noise that must not leak');`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const environment = {
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: runtimeDirectory,
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: fakeHerdrPath,
    };
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

  test('parallel starts are all recorded and the newest seq shows every sub agent', { skip: nestedReason }, async () => {
    const workDirectory = createTemporaryDirectory();
    const runtimeDirectory = join(workDirectory, 'runtime');
    const callLogPath = join(workDirectory, 'herdr-calls.jsonl');
    const fakeHerdrPath = join(workDirectory, 'herdr');
    writeFileSync(
      fakeHerdrPath,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o755 },
    );
    const environment = {
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: runtimeDirectory,
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: fakeHerdrPath,
    };
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
