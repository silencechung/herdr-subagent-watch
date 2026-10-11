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
  buildTreeLines,
  countClaudeAncestors,
  fallbackSequenceBaseNs,
  formatTreeLine,
  listSessionSubagents,
  maximumTokenLength,
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

  // readdir 的順序不固定：平行的 hook 讀到同一組檔要畫出一樣的樹
  test('sub agents started in the same millisecond are ordered by id, whatever order they are listed in', () => {
    const expected = ['├─ first ●', '├─ second ●', '└─ third ●'];
    assert.deepEqual(buildTreeLines([subagent('b', 7, 'second'), subagent('c', 7, 'third'), subagent('a', 7, 'first')]), expected);
    assert.deepEqual(buildTreeLines([subagent('c', 7, 'third'), subagent('a', 7, 'first'), subagent('b', 7, 'second')]), expected);
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

  // popup 的 tab 有編號，側邊欄刻意沒有：同 type 重複時也只列名稱，不帶任何數字
  test('repeated agent types stay unnumbered even though popup tabs are numbered', () => {
    const lines = buildTreeLines([
      subagent('a', 1, 'general-purpose'),
      subagent('b', 2, 'general-purpose'),
      subagent('c', 3, 'general-purpose'),
    ]);
    assert.deepEqual(lines, [
      '├─ general-purpose ●',
      '├─ general-purpose ●',
      '└─ general-purpose ●',
    ]);
    for (const line of lines) {
      assert.doesNotMatch(line, /\d|\[/);
    }
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

  test('the boot time is read from btime in /proc/stat', () => {
    const procStat = 'cpu  1 2 3\nintr 5\nctxt 6\nbtime 1791608737\nprocesses 7\n';
    assert.equal(readBootTimeSeconds(() => procStat), 1_791_608_737n);
    assert.equal(readBootTimeSeconds(() => 'cpu 1 2 3\n'), null);
    assert.equal(readBootTimeSeconds(() => 'btime 0\n'), null);
    assert.equal(readBootTimeSeconds(() => 'btime -5\n'), null);
    assert.equal(readBootTimeSeconds(() => {
      throw new Error('ENOENT');
    }), null);
    if (existsSync('/proc/stat')) {
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
    assert.deepEqual(startResult.lines, ['└─ general-purpose ●']);
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
    assert.deepEqual(stopResult.lines, []);
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
    assert.deepEqual(result.lines, ['└─ general-purpose ●']);
    assert.deepEqual(harness.readSubagents(), [subagent('a12e8c491ce2f7f4a', 1_002_000, 'general-purpose')]);
  });

  // resume 時上一輪的 stop 沒收到：啟動時間沿用舊的話，上一輪的結束訊號會被當成這一輪的，正在跑的 sub 被清掉
  test('a repeated start without stop (a resume whose stop was missed) keeps one entry with the new start time', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    harness.advanceClock(2000);
    const result = runHook(startPayloadText, harness.environment, harness.dependencies);
    assert.deepEqual(result.lines, ['└─ general-purpose ●']);
    assert.deepEqual(harness.readSubagents(), [subagent('a12e8c491ce2f7f4a', 1_002_000, 'general-purpose')]);
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
    assert.deepEqual(result.lines, ['├─ Plan ●', '├─ Explore ●', '└─ general-purpose ●']);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(existsSync(legacyLockPath), true);
    assert.deepEqual(harness.readSubagents().map((entry) => entry.id).sort(), ['a12e8c491ce2f7f4a', 'oldrunning', 'oldrunning2']);

    // 舊版的 sub 收到 SubagentStop 時照常拿掉
    harness.advanceClock(10);
    const stopped = runHook(payloadWith({ hook_event_name: 'SubagentStop', agent_id: 'oldrunning', agent_type: 'Plan' }), harness.environment, harness.dependencies);
    assert.deepEqual(stopped.lines, ['├─ Explore ●', '└─ general-purpose ●']);
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

  test('seq follows the monotonic clock, so two events in the same millisecond still get increasing seq', () => {
    const harness = createHarness();
    runHook(startPayloadText, harness.environment, harness.dependencies);
    runHook(payloadWith({ agent_id: 'second', agent_type: 'Explore' }), harness.environment, harness.dependencies);
    assert.equal(harness.herdrCalls[0].argumentList[6], String(testBootTimeNs + 1n));
    assert.equal(harness.herdrCalls[1].argumentList[6], String(testBootTimeNs + 2n));
    assert.deepEqual(harness.herdrCalls[1].argumentList.slice(7, 11), [
      '--token', 'sub1=├─ general-purpose ●',
      '--token', 'sub2=└─ Explore ●',
    ]);
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

  // herdr 的規則（實測）：seq 小於或等於上次收下的就忽略。最後畫在側邊欄上的就是 seq 最大的那一筆，跟送達的先後無關
  function readShownTokens(callLogPath, previousCallCount) {
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(previousCallCount);
    const sequences = calls.map((call) => BigInt(call[6]));
    const newest = calls.reduce((best, call) => (BigInt(call[6]) > BigInt(best[6]) ? call : best));
    return { callCount: previousCallCount + calls.length, sequences, tokens: newest.slice(7) };
  }

  // 沒有 lock 之後，平行的 hook 各自改自己的檔、各自回報：不管怎麼交錯，seq 最大的那一筆一定要等於檔案最後的狀態，一次都不能漏
  test('parallel starts, stops and start-then-stop chains: the newest seq always shows exactly the files left', { timeout: 120_000 }, async () => {
    const { runtimeDirectory, callLogPath, environment } = createScriptCase();
    const stateDirectory = join(runtimeDirectory, 'subagent-watch');
    const parallelCount = 8;
    const start = (agentId) => payloadWith({ agent_id: agentId, agent_type: `worker-${agentId}` });
    const stop = (agentId) => payloadWith({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: `worker-${agentId}` });
    const expectTokens = (lines) => buildMetadataArguments(testPaneId, lines, 0).slice(7);
    let callCount = 0;
    const checkPhase = async (label, runs, expectedIds) => {
      const results = await Promise.all(runs);
      for (const result of results.flat()) {
        assert.deepEqual(result, { status: 0, output: '' }, label);
      }
      const running = listSessionSubagents(stateDirectory, startPayload.session_id);
      assert.deepEqual(running.map((entry) => entry.id).sort(), [...expectedIds].sort(), label);
      const shown = readShownTokens(callLogPath, callCount);
      callCount = shown.callCount;
      assert.equal(new Set(shown.sequences).size, shown.sequences.length, `${label}: every seq is unique`);
      assert.deepEqual(shown.tokens, expectTokens(buildTreeLines(running)), label);
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
    const acceptReport = (argumentList) => {
      const sequence = BigInt(argumentList[6]);
      if (sequence > lastAcceptedSequence) {
        lastAcceptedSequence = sequence;
        shownTokens = argumentList.slice(7);
      }
    };
    // pauses：[時機, 要插進來的 hook]；時機 'seq' 是取 seq 的當下（改完檔、readdir 之前），'report' 是送 herdr 的當下（readdir 之後）
    const run = (payloadText, pauses = {}) => {
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
          const valueNs = process.hrtime.bigint();
          pauses.seq?.();
          return valueNs;
        },
        runHerdr: (binaryPath, argumentList) => {
          pauses.report?.();
          acceptReport(argumentList);
        },
      });
    };
    const expectedTokens = () => buildMetadataArguments(testPaneId, buildTreeLines(listSessionSubagents(stateDirectory, sessionId)), 0).slice(7);
    const ownFileExists = (agentId) => existsSync(join(stateDirectory, subagentFileName(sessionId, agentId)));
    return { run, shown: () => shownTokens, expectedTokens, ownFileExists, stateDirectory };
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
    assert.deepEqual(interleaving.shown(), ['--token', 'sub1=├─ late ●', '--token', 'sub2=└─ type-first ●', '--clear-token', 'sub3', '--clear-token', 'sub4', '--clear-token', 'sub5']);
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

  for (const [firstLabel, firstPayload] of [['start', start('a')], ['stop', stop('a')]]) {
    for (const [secondLabel, secondPayload] of [['start', start('b')], ['stop', stop('b')]]) {
      for (const pause of ['seq', 'report']) {
        test(`a ${secondLabel} running entirely inside a ${firstLabel} at its ${pause} step`, () => {
          const interleaving = createInterleavingCase();
          // stop 要有東西可停：兩個 sub 都先跑起來
          interleaving.run(start('a'));
          interleaving.run(start('b'));
          interleaving.run(firstPayload, { [pause]: () => interleaving.run(secondPayload) });
          assert.deepEqual(interleaving.shown(), interleaving.expectedTokens());
        });
      }
    }
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
    assert.deepEqual(result.lines, ['└─ general-purpose ●']);
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
