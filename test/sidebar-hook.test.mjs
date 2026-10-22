import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMetadataArguments,
  buildSidebarLine,
  countClaudeAncestors,
  fallbackSequenceBaseNs,
  listSessionSubagents,
  parseHookPayload,
  parsePaneAgentSession,
  parseSubagentFile,
  prepareStateDirectory,
  readBootTimeSeconds,
  readLegacySubagents,
  runHook,
  sanitizeText,
  subagentFileName,
  takeSequence,
  totalBudgetMs,
} from '../hooks/sidebar-hook.mjs';
import { hookTimeoutSeconds } from '../lib/setup-claude.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const hookScriptPath = join(testDirectory, '..', 'hooks', 'sidebar-hook.mjs');
const fixtureDirectory = join(testDirectory, 'fixtures', 'sidebar');
const startPayloadText = readFileSync(join(fixtureDirectory, 'subagent-start.json'), 'utf8');
const stopPayloadText = readFileSync(join(fixtureDirectory, 'subagent-stop.json'), 'utf8');
const startPayload = JSON.parse(startPayloadText);
const testPaneId = 'w1:pTest';
const testBootTimeSeconds = 1_790_000_000n;
const testBootTimeNs = testBootTimeSeconds * 1_000_000_000n;
// 舊安裝的 config.toml 還有 $sub2～$sub5：每次回報都要清掉
const legacyTokensCleared = [
  '--clear-token', 'sub2',
  '--clear-token', 'sub3',
  '--clear-token', 'sub4',
  '--clear-token', 'sub5',
];
const allTokensCleared = ['--clear-token', 'sub1', ...legacyTokensCleared];
const runningTokens = (count) => ['--token', `sub1=● ${count} running`, ...legacyTokensCleared];

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

describe('sub agent files', () => {
  const content = (overrides = {}) => JSON.stringify({ sessionId: 'abc', id: 'agent1', agentType: 'Plan', startedAtMs: 5, ...overrides });

  test('a file counts only when its session and id match its name', () => {
    assert.equal(subagentFileName('abc', 'agent1'), 'sub-abc-agent1.json');
    assert.deepEqual(parseSubagentFile(content(), 'abc', 'sub-abc-agent1.json'), subagent('agent1', 5, 'Plan'));
    // session「abc」的前綴 sub-abc- 也對得上 session「abc-x」的檔：內容的 sessionId 不同，不算
    assert.equal(parseSubagentFile(content({ sessionId: 'abc-x', id: 'agent1' }), 'abc', 'sub-abc-x-agent1.json'), null);
    assert.equal(parseSubagentFile(content({ id: 'other' }), 'abc', 'sub-abc-agent1.json'), null);
    assert.equal(parseSubagentFile(content({ id: '../x' }), 'abc', 'sub-abc-../x.json'), null);
    assert.equal(parseSubagentFile(content({ startedAtMs: 'soon' }), 'abc', 'sub-abc-agent1.json'), null);
    assert.equal(parseSubagentFile(content({ agentType: 3 }), 'abc', 'sub-abc-agent1.json'), null);
    assert.equal(parseSubagentFile('{broken', 'abc', 'sub-abc-agent1.json'), null);
  });

  test('listing a session reads only its own finished files, not temporary ones or other sessions', () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, 'sub-abc-agent1.json'), content());
    writeFileSync(join(directory, 'sub-abc-agent2.json.0011223344556677.tmp'), content({ id: 'agent2' }));
    writeFileSync(join(directory, 'sub-abc-x-agent3.json'), content({ sessionId: 'abc-x', id: 'agent3' }));
    writeFileSync(join(directory, 'sub-other-agent4.json'), content({ sessionId: 'other', id: 'agent4' }));
    writeFileSync(join(directory, 'session-abc.json'), JSON.stringify({ subagents: [subagent('agent5', 1)] }));
    assert.deepEqual(listSessionSubagents(directory, 'abc'), [subagent('agent1', 5, 'Plan')]);
  });

  test('running entries of the previous version\'s state file are read for migration; finished ones are dropped', () => {
    const subagents = readLegacySubagents({
      sessionId: 'session',
      lastSequence: 42,
      subagents: [
        { id: 'old-done', agentType: 'Plan', status: 'done', startedAtMs: 1, endedAtMs: 2 },
        { id: 'old-running', agentType: 'Explore', status: 'running', startedAtMs: 3, endedAtMs: null },
        subagent('new', 4),
        subagent('../escape', 5),
        null,
        { agentType: 'no-id' },
      ],
    });
    assert.deepEqual(subagents, [subagent('old-running', 3, 'Explore'), subagent('new', 4)]);
    assert.deepEqual(readLegacySubagents(null), []);
    assert.deepEqual(readLegacySubagents({ subagents: 'x' }), []);
  });
});

describe('buildSidebarLine', () => {
  test('no running sub agents gives no line', () => {
    assert.equal(buildSidebarLine(0), null);
  });

  test('shows only the count of running sub agents, with no upper limit', () => {
    assert.equal(buildSidebarLine(1), '● 1 running');
    assert.equal(buildSidebarLine(7), '● 7 running');
    assert.equal(buildSidebarLine(123), '● 123 running');
  });
});

describe('buildMetadataArguments', () => {
  test('sets sub1 to the line and always clears sub2 to sub5 left in older configs, under one source', () => {
    const argumentList = buildMetadataArguments('w8:pV', '● 2 running', 1234);
    assert.deepEqual(argumentList, [
      'pane', 'report-metadata', 'w8:pV',
      '--source', 'subagent.watch',
      '--seq', '1234',
      '--token', 'sub1=● 2 running',
      '--clear-token', 'sub2',
      '--clear-token', 'sub3',
      '--clear-token', 'sub4',
      '--clear-token', 'sub5',
    ]);
  });

  test('no line clears all five tokens', () => {
    assert.deepEqual(buildMetadataArguments('w8:pV', null, 1234).slice(7), allTokensCleared);
  });
});

describe('takeSequence', () => {
  const herdrMaximumSequence = 2n ** 64n - 1n;

  test('is boot time in ns plus the monotonic clock, as a BigInt', () => {
    const sequence = takeSequence(1_791_608_737n, 123_456_789n);
    assert.equal(typeof sequence, 'bigint');
    assert.equal(sequence, 1_791_608_737_123_456_789n);
    assert.equal(String(sequence), '1791608737123456789');
  });

  test('keeps increasing across a reboot, where the monotonic clock starts over', () => {
    // 前一次開機跑了 30 天，最後一次回報；重開機 1 秒後的第一次回報
    const lastBeforeReboot = takeSequence(1_790_000_000n, 30n * 86_400n * 1_000_000_000n);
    const firstAfterReboot = takeSequence(1_790_000_000n + 30n * 86_400n + 60n, 1_000_000_000n);
    assert.ok(firstAfterReboot > lastBeforeReboot);
  });

  test('is far above the millisecond seq of the previous version and far below the u64 limit herdr accepts', () => {
    const previousVersionSequence = BigInt(Date.parse('2030-01-01T00:00:00Z'));
    const now = takeSequence(readBootTimeSeconds() ?? 1_790_000_000n, process.hrtime.bigint());
    assert.ok(now > previousVersionSequence * 1000n);
    assert.ok(takeSequence(4_000_000_000n, 100n * 365n * 86_400n * 1_000_000_000n) < herdrMaximumSequence);
  });

  test('without a boot time it falls back to a fixed base that still beats the previous version\'s millisecond seq', () => {
    assert.equal(takeSequence(null, 42n), fallbackSequenceBaseNs + 42n);
    assert.ok(takeSequence(null, 0n) > BigInt(Date.parse('2100-01-01T00:00:00Z')));
    assert.ok(takeSequence(null, 0n) < takeSequence(1_790_000_000n, 0n));
  });

  test('on Linux the boot time is read from btime in /proc/stat', () => {
    const procStat = 'cpu  1 2 3\nintr 5\nctxt 6\nbtime 1791608737\nprocesses 7\n';
    const readOnLinux = (readText) => readBootTimeSeconds({ platform: 'linux', readText });
    assert.equal(readOnLinux(() => procStat), 1_791_608_737n);
    assert.equal(readOnLinux(() => 'cpu 1 2 3\n'), null);
    assert.equal(readOnLinux(() => 'btime 0\n'), null);
    assert.equal(readOnLinux(() => 'btime -5\n'), null);
    assert.equal(readOnLinux(() => {
      throw new Error('ENOENT');
    }), null);
    if (process.platform === 'linux' && existsSync('/proc/stat')) {
      assert.equal(typeof readBootTimeSeconds(), 'bigint');
    }
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
    let monotonicNs = 0n;
    const dependencies = {
      now: () => clockMs,
      readBootTimeSeconds: () => testBootTimeSeconds,
      monotonicNs: () => {
        monotonicNs += 1n;
        return monotonicNs;
      },
      runHerdr: (binaryPath, argumentList, timeoutMs) => {
        herdrCalls.push({ binaryPath, argumentList, timeoutMs });
      },
      isExecutable: () => true,
      queryPaneAgentSession: () => ({ agent: 'claude', sessionId: startPayload.session_id }),
      countClaudeAncestors: () => 1,
      // fixture 的 transcript_path 是實測時的真實路徑，開發機上可能真的存在：這組測試不看 transcript，清除死掉 sub 的規則另有測試
      readFileTail: () => ({ isMissing: true }),
      deadlineMs: Number.POSITIVE_INFINITY,
      ...overrides,
    };
    const environment = {
      HERDR_PANE_ID: testPaneId,
      HERDR_BIN_PATH: '/fake/herdr',
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    return {
      runtimeDirectory,
      stateDirectory,
      herdrCalls,
      environment,
      dependencies,
      advanceClock: (durationMs) => {
        clockMs += durationMs;
      },
      readSubagents: (sessionId = startPayload.session_id) => listSessionSubagents(stateDirectory, sessionId),
      subagentFilePath: (agentId, sessionId = startPayload.session_id) => join(stateDirectory, subagentFileName(sessionId, agentId)),
    };
  }

  test('start then stop writes and removes the sub agent file, writes the pane mapping and reports to herdr', () => {
    const harness = createHarness();
    const startResult = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(startResult.action, 'reported');
    assert.equal(startResult.runningCount, 1);
    assert.equal(startResult.line, '● 1 running');
    assert.equal(harness.herdrCalls.length, 1);
    assert.equal(harness.herdrCalls[0].binaryPath, '/fake/herdr');
    assert.deepEqual(harness.herdrCalls[0].argumentList.slice(0, 7), [
      'pane', 'report-metadata', testPaneId, '--source', 'subagent.watch', '--seq', String(testBootTimeNs + 1n),
    ]);

    const paneMapping = JSON.parse(readFileSync(join(harness.stateDirectory, `pane-${testPaneId}.json`), 'utf8'));
    assert.deepEqual(Object.keys(paneMapping).sort(), ['cwd', 'sessionId', 'transcriptPath', 'updatedAtMs']);
    assert.equal(paneMapping.sessionId, startPayload.session_id);
    assert.equal(paneMapping.transcriptPath, startPayload.transcript_path);
    assert.equal(paneMapping.cwd, startPayload.cwd);
    assert.equal(paneMapping.updatedAtMs, 1_000_000);

    const subagentFilePath = harness.subagentFilePath('a12e8c491ce2f7f4a');
    assert.deepEqual(JSON.parse(readFileSync(subagentFilePath, 'utf8')), {
      sessionId: startPayload.session_id,
      id: 'a12e8c491ce2f7f4a',
      agentType: 'general-purpose',
      startedAtMs: 1_000_000,
    });
    assert.equal(statSync(subagentFilePath).mode & 0o777, 0o600);

    harness.advanceClock(2000);
    const stopResult = runHook(stopPayloadText, harness.environment, harness.dependencies);
    assert.equal(stopResult.action, 'reported');
    assert.equal(stopResult.runningCount, 0);
    assert.equal(stopResult.line, null);
    assert.equal(harness.herdrCalls[1].argumentList[6], String(testBootTimeNs + 2n));
    assert.deepEqual(harness.herdrCalls[1].argumentList.slice(7), allTokensCleared);
    assert.equal(existsSync(subagentFilePath), false);

    // 沒有 lock、沒有 session 狀態檔，暫存檔也不會留下
    assert.deepEqual(readdirSync(harness.stateDirectory), [`pane-${testPaneId}.json`]);
  });

  test('start again after stop (resume) shows it once more', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    harness.advanceClock(1000);
    runHook(stopPayloadText, harness.environment, harness.dependencies);
    harness.advanceClock(1000);
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.runningCount, 1);
    assert.deepEqual(harness.readSubagents(), [subagent('a12e8c491ce2f7f4a', 1_002_000, 'general-purpose')]);
  });

  // resume 時上一輪的 stop 沒收到：啟動時間沿用舊的話，上一輪的結束訊號會被當成這一輪的，正在跑的 sub 被清掉
  test('a repeated start without stop (a resume whose stop was missed) keeps one entry with the new start time', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    harness.advanceClock(2000);
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.runningCount, 1);
    assert.deepEqual(harness.readSubagents(), [subagent('a12e8c491ce2f7f4a', 1_002_000, 'general-purpose')]);
  });

  test('start two, stop one, stop the other: 2 running, then 1 running, then everything cleared', () => {
    const harness = createHarness();
    const firstStart = payloadWith({ agent_id: 'first', agent_type: 'Explore' });
    const secondStart = payloadWith({ agent_id: 'second', agent_type: 'Plan' });
    const firstStop = payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'first', agent_type: 'Explore' });
    const secondStop = payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'second', agent_type: 'Plan' });

    runHook(firstStart, harness.environment, harness.dependencies);
    harness.advanceClock(10);
    const bothRunning = runHook(secondStart, harness.environment, harness.dependencies);
    assert.deepEqual(bothRunning.argumentList.slice(7), runningTokens(2));

    harness.advanceClock(10);
    const oneLeft = runHook(firstStop, harness.environment, harness.dependencies);
    assert.deepEqual(oneLeft.argumentList.slice(7), runningTokens(1));

    harness.advanceClock(10);
    const noneLeft = runHook(secondStop, harness.environment, harness.dependencies);
    assert.equal(noneLeft.line, null);
    assert.deepEqual(noneLeft.argumentList.slice(7), allTokensCleared);
    assert.equal(harness.herdrCalls.length, 4);
  });

  // 舊版最多 5 行、第 5 行是 +N more；現在只有數量，超過 5 個也照實顯示
  test('the count has no upper limit and only counts sub agents that are still running', () => {
    const harness = createHarness();
    for (let index = 1; index <= 7; index += 1) {
      harness.advanceClock(10);
      runHook(payloadWith({ agent_id: `s${index}`, agent_type: `worker${index}` }), harness.environment, harness.dependencies);
    }
    assert.deepEqual(harness.herdrCalls.at(-1).argumentList.slice(7), runningTokens(7));

    const stop = (index) => {
      harness.advanceClock(10);
      return runHook(
        payloadWith({ hook_event_name: 'SubagentStop', agent_id: `s${index}`, agent_type: `worker${index}` }),
        harness.environment,
        harness.dependencies,
      );
    };
    assert.equal(stop(1).line, '● 6 running');
    assert.equal(stop(4).line, '● 5 running');
    // 已經停掉的再收到一次 stop：檔不在，不算改動、不回報
    assert.equal(stop(4).action, 'unchanged');
  });

  // 升級：舊版 hook 寫的 session 狀態檔裡還在跑的 sub 搬成 sub 檔，不會在升級後第一次重畫時從側邊欄消失
  test('running sub agents in the previous version\'s state file are moved to sub agent files and the old file is removed', () => {
    const harness = createHarness();
    mkdirSync(harness.stateDirectory, { mode: 0o700 });
    const legacyPath = join(harness.stateDirectory, `session-${startPayload.session_id}.json`);
    writeFileSync(legacyPath, JSON.stringify({
      sessionId: startPayload.session_id,
      lastSequence: 999_000,
      subagents: [
        { id: 'oldrunning', agentType: 'Plan', status: 'running', startedAtMs: 990_000, endedAtMs: null },
        { id: 'finished', agentType: 'Plan', status: 'done', startedAtMs: 900_000, endedAtMs: 950_000 },
        subagent('oldrunning2', 995_000, 'Explore'),
      ],
    }));
    // 舊版留下的 lock 不擋任何事，也不會被動到
    const legacyLockPath = `${legacyPath}.lock`;
    writeFileSync(legacyLockPath, JSON.stringify({ pid: process.pid, startTime: '1', createdAtMs: 0 }));
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.line, '● 3 running');
    assert.equal(existsSync(legacyPath), false);
    assert.equal(existsSync(legacyLockPath), true);
    assert.deepEqual(harness.readSubagents().map((entry) => entry.id).sort(), ['a12e8c491ce2f7f4a', 'oldrunning', 'oldrunning2']);

    // 舊版的 sub 收到 SubagentStop 時照常拿掉
    harness.advanceClock(10);
    const stopped = runHook(payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'oldrunning', agent_type: 'Plan' }), harness.environment, harness.dependencies);
    assert.equal(stopped.line, '● 2 running');
  });

  test('migration never overwrites a sub agent file the new version already wrote', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    writeFileSync(join(harness.stateDirectory, `session-${startPayload.session_id}.json`), JSON.stringify({
      sessionId: startPayload.session_id,
      subagents: [subagent('a12e8c491ce2f7f4a', 1, 'stale')],
    }));
    harness.advanceClock(10);
    runHook(payloadWith({ hook_event_name: 'Stop' }), harness.environment, harness.dependencies);
    assert.deepEqual(harness.readSubagents(), [subagent('a12e8c491ce2f7f4a', 1_000_000, 'general-purpose')]);
    assert.equal(existsSync(join(harness.stateDirectory, `session-${startPayload.session_id}.json`)), false);
  });

  // 搬舊檔是這次事件唯一的改動時也要回報：Stop 沒拿掉任何 sub，但側邊欄要畫出剛搬過來的 sub
  test('a Stop whose only change is moving the previous version\'s running sub agents still reports them to herdr', () => {
    const harness = createHarness();
    mkdirSync(harness.stateDirectory, { mode: 0o700 });
    writeFileSync(join(harness.stateDirectory, `session-${startPayload.session_id}.json`), JSON.stringify({
      sessionId: startPayload.session_id,
      subagents: [subagent('oldrunning', 990_000, 'Plan')],
    }));
    const result = runHook(payloadWith({ hook_event_name: 'Stop' }), harness.environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.removed, []);
    assert.equal(harness.herdrCalls.length, 1);
    assert.deepEqual(harness.herdrCalls[0].argumentList.slice(7), runningTokens(1));
    assert.deepEqual(harness.readSubagents().map((entry) => entry.id), ['oldrunning']);
  });

  test('seq follows the monotonic clock, so two events in the same millisecond still get increasing seq', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    runHook(payloadWith({ agent_id: 'second', agent_type: 'Explore' }), harness.environment, harness.dependencies);
    assert.equal(harness.herdrCalls[0].argumentList[6], String(testBootTimeNs + 1n));
    assert.equal(harness.herdrCalls[1].argumentList[6], String(testBootTimeNs + 2n));
    assert.deepEqual(harness.herdrCalls[1].argumentList.slice(7), runningTokens(2));
  });

  test('without a readable boot time the seq uses the fallback base', () => {
    const harness = createHarness({ readBootTimeSeconds: () => null });
    runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(harness.herdrCalls[0].argumentList[6], String(fallbackSequenceBaseNs + 1n));
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

  test('corrupt or mismatched sub agent files are skipped instead of crashing', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    writeFileSync(harness.subagentFilePath('broken'), '{broken');
    writeFileSync(harness.subagentFilePath('mismatch'), JSON.stringify({ sessionId: startPayload.session_id, id: 'other', agentType: 'x', startedAtMs: 1 }));
    writeFileSync(join(harness.stateDirectory, `session-${startPayload.session_id}.json`), '{broken');
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(result.runningCount, 1, 'broken and mismatched files are not counted');
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

  // 預算從 main() 開始算，不含 node 啟動；很忙時實測最慢約預算再加 0.5 秒。至少留一半給這些，才不會碰到 Claude Code 的 timeout
  test('the time budget stays at most half of the hook timeout in settings.json', () => {
    assert.ok(totalBudgetMs > 0);
    assert.ok(totalBudgetMs * 2 <= hookTimeoutSeconds * 1000, `budget ${totalBudgetMs}ms, timeout ${hookTimeoutSeconds}s`);
  });

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

  test('inside herdr: calls herdr with the count token, no output, under 1 second', () => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const result = runScript(environment, startPayloadText);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), ['pane', 'report-metadata', testPaneId, '--source', 'subagent.watch']);
    assert.deepEqual(calls[0].slice(7), runningTokens(1));
    assert.ok(existsSync(join(runtimeDirectory, 'subagent-watch', `pane-${testPaneId}.json`)));
  });

  function runScriptAsync(environment, payloadText) {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [hookScriptPath], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.on('close', (status) => {
        resolvePromise({ status, output });
      });
      child.stdin.end(payloadText);
    });
  }

  // 假 herdr 照 herdr 的規則（實測）依送達的先後處理：seq 小於或等於上次收下的就忽略，所以 seq 一樣時收先到的那筆。
  // call log 的順序就是假 herdr 收到的順序；上次收下的 seq 跟真的 herdr 一樣跨階段保留
  function createFakeHerdrDisplay(callLogPath) {
    let readCount = 0;
    let lastAcceptedSequence = -1n;
    let shownTokens = null;
    return () => {
      const calls = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(readCount);
      readCount += calls.length;
      for (const call of calls) {
        const sequence = BigInt(call[6]);
        if (sequence > lastAcceptedSequence) {
          lastAcceptedSequence = sequence;
          shownTokens = call.slice(7);
        }
      }
      return { calls, shownTokens };
    };
  }

  // 同一個 seq 被兩個以上的 hook 拿到的組：[{ sequence, count, isNewest }]
  function findSequenceCollisions(calls) {
    const countBySequence = new Map();
    for (const call of calls) {
      countBySequence.set(call[6], (countBySequence.get(call[6]) ?? 0) + 1);
    }
    const newest = calls.reduce((best, call) => (BigInt(call[6]) > best ? BigInt(call[6]) : best), -1n);
    return [...countBySequence].filter(([, count]) => count > 1).map(([sequence, count]) => ({ sequence, count, isNewest: BigInt(sequence) === newest }));
  }

  // 沒有 lock 之後，平行的 hook 各自改自己的檔、各自回報：不管怎麼交錯，假 herdr 最後顯示的一定要等於檔案最後的狀態，一次都不能漏。
  // seq 撞號（不同核心在同一個 ns 讀時鐘）不算錯，不檢查「每個 seq 都不一樣」：同一個 seq 代表兩個 hook 在同一個 ns 取號，
  // 兩邊取號時自己的改動都已經完成、readdir 都在取號之後，所以兩筆都看得到 seq 不大於它的每一個改動；
  // 之後才完成的改動，那個 hook 是改完才取號，seq 一定比較大，會蓋過這兩筆。herdr 收先到的那筆也一樣正確。
  // 最壞的情況是撞號的就是這個階段最大的 seq（之後沒有更大的回報來蓋過）：那幾筆每一筆都要等於檔案狀態，不只是先到的那筆
  test('parallel starts, stops and start-then-stop chains: what herdr shows always equals the files left, even when two hooks get the same seq', { timeout: 120_000 }, async (context) => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    const parallelCount = 8;
    const start = (agentId) => payloadWith({ agent_id: agentId, agent_type: `worker-${agentId}` });
    const stop = (agentId) => payloadWith({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: `worker-${agentId}` });
    const readDisplay = createFakeHerdrDisplay(callLogPath);
    const checkPhase = async (label, runs, expectedIds) => {
      const results = await Promise.all(runs);
      for (const result of results.flat()) {
        assert.deepEqual(result, { status: 0, output: '' }, label);
      }
      const running = listSessionSubagents(stateDirectory, startPayload.session_id);
      assert.deepEqual(running.map((entry) => entry.id).sort(), [...expectedIds].sort(), label);
      const expectedTokens = buildMetadataArguments(testPaneId, buildSidebarLine(running.length), 0).slice(7);
      const { calls, shownTokens } = readDisplay();
      const collisions = findSequenceCollisions(calls);
      const isShownCorrect = JSON.stringify(shownTokens) === JSON.stringify(expectedTokens);
      // 撞號的統計印成 TAP diagnostic（POC 連跑時收集）；先印再 assert，失敗的那一次也看得到
      for (const collision of collisions) {
        context.diagnostic(`seq collision: ${label}: ${collision.count} reports share seq ${collision.sequence}${collision.isNewest ? ' (the newest seq of the phase)' : ''}, shown ${isShownCorrect ? 'correct' : 'WRONG'}`);
      }
      assert.deepEqual(shownTokens, expectedTokens, label);
      const newestSequence = calls.reduce((best, call) => (BigInt(call[6]) > best ? BigInt(call[6]) : best), -1n);
      for (const call of calls.filter((candidate) => BigInt(candidate[6]) === newestSequence)) {
        assert.deepEqual(call.slice(7), expectedTokens, `${label}: every report with the newest seq`);
      }
    };
    for (let round = 0; round < 3; round += 1) {
      const ids = Array.from({ length: parallelCount }, (unused, index) => `r${round}a${index}`);
      await checkPhase(`round ${round}: ${parallelCount} starts at once`, ids.map((id) => runScriptAsync(environment, start(id))), ids);
      await checkPhase(`round ${round}: ${parallelCount} stops at once`, ids.map((id) => runScriptAsync(environment, stop(id))), []);
      const chainIds = Array.from({ length: parallelCount }, (unused, index) => `r${round}c${index}`);
      const chains = chainIds.map(async (id) => [await runScriptAsync(environment, start(id)), await runScriptAsync(environment, stop(id))]);
      await checkPhase(`round ${round}: ${parallelCount} start-then-stop chains`, chains, []);
      // 一半 start、一半 stop 交錯：留下的是剛 start 的那一半
      const keptIds = ids.slice(0, parallelCount / 2);
      const mixedRuns = [...keptIds.map((id) => runScriptAsync(environment, start(id))), ...chainIds.slice(0, parallelCount / 2).map((id) => runScriptAsync(environment, stop(id)))];
      await checkPhase(`round ${round}: starts mixed with stops`, mixedRuns, keptIds);
      await checkPhase(`round ${round}: cleanup`, keptIds.map((id) => runScriptAsync(environment, stop(id))), []);
    }
    assert.deepEqual(readdirSync(stateDirectory).filter((name) => /\.(tmp|lock)$/.test(name)), []);
  });
});

// 用 runHook 的注入點，把另一個 hook 整個插進這個 hook 的某一步之間，重現平行 hook 的交錯；假 herdr 跟真的一樣忽略 seq 不大於上次的回報
describe('without a lock, any interleaving of hooks ends with the newest seq showing every change', () => {
  const sessionId = startPayload.session_id;

  function createInterleavingCase() {
    const runtimeDirectory = createTemporaryDirectory();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    const environment = { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory };
    let lastAcceptedSequence = -1n;
    let shownTokens = null;
    let clockMs = 1_000_000;
    const reports = [];
    const acceptReport = (argumentList) => {
      reports.push(argumentList);
      const sequence = BigInt(argumentList[6]);
      if (sequence > lastAcceptedSequence) {
        lastAcceptedSequence = sequence;
        shownTokens = argumentList.slice(7);
      }
    };
    // pauses：[時機, 要插進來的 hook]；時機 'seq' 是取 seq 的當下（改完檔、readdir 之前），'report' 是送 herdr 的當下（readdir 之後）。
    // monotonicOverrideNs：讀時鐘時拿到指定的值，用來重現撞號
    const run = (payloadText, pauses = {}, monotonicOverrideNs = null) => {
      return runHook(payloadText, environment, {
        now: () => {
          clockMs += 1;
          return clockMs;
        },
        isExecutable: () => true,
        queryPaneAgentSession: () => null,
        countClaudeAncestors: () => 1,
        readFileTail: () => ({ isMissing: true }),
        deadlineMs: Number.POSITIVE_INFINITY,
        // 先讀時鐘再插入：插進來的 hook 取到的 seq 一定比這個 hook 大
        monotonicNs: () => {
          const valueNs = monotonicOverrideNs ?? process.hrtime.bigint();
          pauses.seq?.(valueNs);
          return valueNs;
        },
        runHerdr: (binaryPath, argumentList) => {
          pauses.report?.();
          acceptReport(argumentList);
        },
      });
    };
    const expectedTokens = () => buildMetadataArguments(testPaneId, buildSidebarLine(listSessionSubagents(stateDirectory, sessionId).length), 0).slice(7);
    const ownFileExists = (agentId) => existsSync(join(stateDirectory, subagentFileName(sessionId, agentId)));
    return { run, shown: () => shownTokens, reports, expectedTokens, ownFileExists, stateDirectory };
  }

  const start = (agentId) => payloadWith({ agent_id: agentId, agent_type: `type-${agentId}` });
  const stop = (agentId) => payloadWith({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: `type-${agentId}` });

  test('the seq is taken after the own file is written and before the folder is read', () => {
    const interleaving = createInterleavingCase();
    let isOwnFileWrittenAtSequence = null;
    interleaving.run(start('first'), {
      seq: () => {
        isOwnFileWrittenAtSequence = interleaving.ownFileExists('first');
        // 取 seq 之後才寫進來的檔：readdir 在取 seq 之後的話，這次回報一定看得到
        writeFileSync(join(interleaving.stateDirectory, subagentFileName(sessionId, 'late')), JSON.stringify({ sessionId, id: 'late', agentType: 'late', startedAtMs: 1 }));
      },
    });
    assert.equal(isOwnFileWrittenAtSequence, true);
    assert.deepEqual(interleaving.shown(), runningTokens(2));
  });

  test('the seq is taken after the own file is removed', () => {
    const interleaving = createInterleavingCase();
    interleaving.run(start('first'));
    let isOwnFileGoneAtSequence = null;
    interleaving.run(stop('first'), {
      seq: () => {
        isOwnFileGoneAtSequence = !interleaving.ownFileExists('first');
      },
    });
    assert.equal(isOwnFileGoneAtSequence, true);
  });

  // 事先只啟動要被 stop 的 sub：start 的都是新的 sub，兩邊的改動都會讓數量變，取 seq 的時機錯了（例如 readdir 之後才取、改檔之前就取）數字就會不同。
  // resume 已經在跑的 sub 不改數量，拿它當外層或插進來的 hook 時，時機錯了也是同一個數字，驗不出來
  const nestedCases = [
    { outer: ['start', start('a')], inner: ['start', start('b')], runningBefore: [], runningAfter: 2 },
    { outer: ['start', start('a')], inner: ['stop', stop('b')], runningBefore: ['b'], runningAfter: 1 },
    { outer: ['stop', stop('a')], inner: ['start', start('b')], runningBefore: ['a'], runningAfter: 1 },
    { outer: ['stop', stop('a')], inner: ['stop', stop('b')], runningBefore: ['a', 'b'], runningAfter: 0 },
  ];
  const expectedTokensFor = (runningCount) => (runningCount > 0 ? runningTokens(runningCount) : allTokensCleared);

  for (const { outer: [outerLabel, outerPayload], inner: [innerLabel, innerPayload], runningBefore, runningAfter } of nestedCases) {
    for (const pause of ['seq', 'report']) {
      test(`a ${innerLabel} running entirely inside a ${outerLabel} at its ${pause} step`, () => {
        const interleaving = createInterleavingCase();
        for (const agentId of runningBefore) {
          interleaving.run(start(agentId));
        }
        interleaving.run(outerPayload, { [pause]: () => interleaving.run(innerPayload) });
        assert.deepEqual(interleaving.expectedTokens(), expectedTokensFor(runningAfter), 'the files left');
        assert.deepEqual(interleaving.shown(), expectedTokensFor(runningAfter));
      });
    }
  }

  // 撞號：另一個 hook 在這個 hook 讀時鐘的同一個 ns 取號，拿到一樣的 seq。同一個 ns 代表另一個 hook 取號時，這個 hook 的改動已經完成、readdir 還沒開始，
  // 所以把它整個插在取 seq 的當下（插在 report 的當下就不是同一個 ns 了：readdir 至少要幾 µs）。插進來的先送到，herdr 收它、忽略這個 hook 的；
  // 兩筆都看得到兩邊的改動，所以不管收哪一筆都正確
  for (const { outer: [outerLabel, outerPayload], inner: [innerLabel, innerPayload], runningBefore, runningAfter } of nestedCases) {
    test(`a ${innerLabel} that gets the same seq inside a ${outerLabel}: either report shows every change`, () => {
      const interleaving = createInterleavingCase();
      for (const agentId of runningBefore) {
        interleaving.run(start(agentId));
      }
      const reportCountBefore = interleaving.reports.length;
      interleaving.run(outerPayload, { seq: (valueNs) => interleaving.run(innerPayload, {}, valueNs) });
      const collided = interleaving.reports.slice(reportCountBefore);
      const expectedTokens = expectedTokensFor(runningAfter);
      assert.equal(collided.length, 2);
      assert.equal(collided[0][6], collided[1][6], 'both reports carry the same seq');
      assert.deepEqual(interleaving.expectedTokens(), expectedTokens, 'the files left');
      assert.deepEqual(collided[0].slice(7), expectedTokens, 'the report herdr keeps (first to arrive)');
      assert.deepEqual(collided[1].slice(7), expectedTokens, 'the report herdr ignores');
      assert.deepEqual(interleaving.shown(), expectedTokens);
    });
  }

  // 隨機產生多層巢狀的交錯（每個 hook 在取 seq 或回報時，可能先讓另一個 hook 整個跑完）；固定種子，失敗可重現
  test('random nested interleavings of starts and stops of 6 sub agents never lose a change', () => {
    let seed = 20261011;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let trial = 0; trial < 300; trial += 1) {
      const interleaving = createInterleavingCase();
      const pending = [];
      for (let index = 0; index < 6; index += 1) {
        pending.push(random() < 0.7 ? start(`s${index}`) : stop(`s${index}`));
        if (random() < 0.5) {
          pending.push(stop(`s${index}`));
        }
      }
      const runNext = () => {
        const payloadText = pending.shift();
        if (payloadText === undefined) {
          return;
        }
        const pauses = {};
        if (random() < 0.5) {
          pauses[random() < 0.5 ? 'seq' : 'report'] = runNext;
        }
        interleaving.run(payloadText, pauses);
      };
      while (pending.length > 0) {
        runNext();
      }
      // 一次都沒回報（例如全是沒看過 start 的 stop）時側邊欄維持空的，檔案也要是空的
      assert.deepEqual(interleaving.shown() ?? allTokensCleared, interleaving.expectedTokens(), `trial ${trial}`);
    }
  });
});

describe('the ancestor scan decides; herdr\'s session is asked only when claude looks nested', () => {
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

  test('nested claude -p (two claude ancestors) whose session is not the one herdr reports is skipped without writing anything', () => {
    const harness = createHarness({
      queryPaneAgentSession: () => ({ agent: 'claude', sessionId: 'main-session' }),
      countClaudeAncestors: () => 2,
    });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.deepEqual(result, { action: 'skipped', reason: 'nested-claude' });
    assert.deepEqual(readdirSync(harness.runtimeDirectory), []);
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('with two claude ancestors, a pane whose session belongs to another agent is skipped', () => {
    const harness = createHarness({
      queryPaneAgentSession: () => ({ agent: 'codex', sessionId: startPayload.session_id }),
      countClaudeAncestors: () => 2,
    });
    assert.equal(runHook(startPayloadText, harness.environment, harness.dependencies).reason, 'nested-claude');
  });

  // review Blocker：herdr server 重啟後 w8:pV 的 agent_session 停在重啟前的 session，實際在跑的是另一個；以前會被當成別的 session，側邊欄完全不更新
  test('review Blocker (w8:pV): a stale agent_session from herdr does not stop one claude ancestor from updating the sidebar', () => {
    const paneQueries = [];
    const harness = createHarness({
      queryPaneAgentSession: (binaryPath, paneId) => {
        paneQueries.push(paneId);
        return { agent: 'claude', sessionId: 'aaab440d-0000-4000-8000-000000000000' };
      },
      countClaudeAncestors: () => 1,
    });
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(result.runningCount, 1);
    assert.equal(harness.herdrCalls.length, 1);
    assert.deepEqual(paneQueries, [], 'one claude ancestor is enough; herdr is not asked');
    const stateDirectory = join(harness.runtimeDirectory, 'subagent-watch');
    const paneMapping = JSON.parse(readFileSync(join(stateDirectory, `pane-${testPaneId}.json`), 'utf8'));
    assert.equal(paneMapping.sessionId, startPayload.session_id);
    assert.deepEqual(listSessionSubagents(stateDirectory, startPayload.session_id).map((entry) => entry.id), [startPayload.agent_id]);
  });

  test('without a session from herdr the ancestor scan decides', () => {
    const single = createHarness({ countClaudeAncestors: () => 1 });
    assert.equal(runHook(startPayloadText, single.environment, single.dependencies).action, 'reported');
    const nested = createHarness({ countClaudeAncestors: () => 2 });
    assert.equal(runHook(startPayloadText, nested.environment, nested.dependencies).reason, 'nested-claude');
  });

  test('the pane query gets the pane id and a timeout that leaves room for the report', () => {
    const harness = createHarness({ deadlineMs: 1_000_250, countClaudeAncestors: () => 2 });
    runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.deepEqual(harness.paneQueries, [{ binaryPath: '/fake/herdr', paneId: testPaneId, timeoutMs: 150 }]);

    const unbounded = createHarness({ countClaudeAncestors: () => 2 });
    runHook(startPayloadText, unbounded.environment, unbounded.dependencies);
    assert.equal(unbounded.paneQueries[0].timeoutMs, 300);

    const outOfTime = createHarness({ deadlineMs: 1_000_100, countClaudeAncestors: () => 2 });
    const result = runHook(startPayloadText, outOfTime.environment, outOfTime.dependencies);
    assert.deepEqual(outOfTime.paneQueries, [], 'no time left: the query is skipped');
    assert.equal(result.reason, 'nested-claude', 'without an answer from herdr a nested-looking event is skipped');
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

  // 側邊欄只顯示數量，agent_type 完全不會送給 herdr
  test('the review PoC agent_type never reaches herdr: only the count is reported', () => {
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
    assert.deepEqual(herdrCalls[0].slice(7), runningTokens(1));
    for (const argument of herdrCalls[0]) {
      assert.doesNotMatch(argument, /[\p{Cc}\p{Cf}]|gp|evil/u);
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
