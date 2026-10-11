import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 用 namespace import：新加的 export 在舊版不存在時，只有用到它的測試失敗，不會整個檔案載入失敗
import * as hook from '../hooks/sidebar-hook.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const hookScriptPath = join(testDirectory, '..', 'hooks', 'sidebar-hook.mjs');
const fixtureDirectory = join(testDirectory, 'fixtures', 'sidebar');
const readFixture = (name) => readFileSync(join(fixtureDirectory, name), 'utf8');
const startupPayload = JSON.parse(readFixture('session-start-startup.json'));
const resumePayload = JSON.parse(readFixture('session-start-resume.json'));
const stopPayload = JSON.parse(readFixture('stop.json'));
const subagentStartPayload = JSON.parse(readFixture('subagent-start.json'));
const apiErrorTailText = readFixture('subagent-tail-api-error.jsonl');
const interruptedTailText = readFixture('subagent-tail-interrupted.jsonl');
const testPaneId = 'w1:pSession';
const minuteMs = 60 * 1000;
const allTokensCleared = [
  '--clear-token', 'sub1',
  '--clear-token', 'sub2',
  '--clear-token', 'sub3',
  '--clear-token', 'sub4',
  '--clear-token', 'sub5',
];

const temporaryDirectories = [];
function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-session-events-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function parseRecords(text) {
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function assistantToolUse(timestamp, name, input = {}) {
  return { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: `toolu_${timestamp}`, name, input }], stop_reason: 'tool_use' } };
}

function assistantEndTurn(timestamp) {
  return { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: 'Summary' }], stop_reason: 'end_turn' } };
}

function userToolResult(timestamp) {
  return { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } };
}

function notificationLine(agentId, status, timestamp, operation = 'enqueue') {
  const content = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  return JSON.stringify({ type: 'queue-operation', operation, timestamp, sessionId: 's', content });
}

function userToolResultFor(timestamp, toolUseTimestamp) {
  return { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${toolUseTimestamp}`, content: 'ok' }] } };
}

function userPrompt(timestamp, text) {
  return { type: 'user', timestamp, message: { content: text } };
}

function toJsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

// Claude Code 每寫一筆紀錄 mtime 就跟著變：測試寫的 transcript 預設把 mtime 設成最後一筆紀錄的時間（清除要看最後一次寫入過了多久）
function findLatestRecordMs(text) {
  let latestMs = null;
  for (const line of text.split('\n')) {
    const timestampMs = line.trim() === '' ? NaN : Date.parse(JSON.parse(line).timestamp);
    if (Number.isFinite(timestampMs) && (latestMs === null || timestampMs > latestMs)) {
      latestMs = timestampMs;
    }
  }
  return latestMs;
}

// Claude Code 的 transcript 版面：<projects>/<project>/<session>.jsonl，sub 在 <session>/subagents/agent-<id>.jsonl
function createSessionFiles(sessionId = 'aaaa0000-0000-4000-8000-0000000000aa') {
  const projectDirectory = join(createTemporaryDirectory(), 'projects', '-srv-work');
  const subagentsDirectory = join(projectDirectory, sessionId, 'subagents');
  mkdirSync(subagentsDirectory, { recursive: true });
  const transcriptPath = join(projectDirectory, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, toJsonLines([{ type: 'user', timestamp: '2026-10-10T09:00:00.000Z', message: { content: 'go' } }]));
  return {
    sessionId,
    transcriptPath,
    subagentsDirectory,
    writeSubagent(agentId, text, { meta = { agentType: 'general-purpose', requestShape: 'background' }, modifiedMs = null } = {}) {
      const filePath = join(subagentsDirectory, `agent-${agentId}.jsonl`);
      writeFileSync(filePath, text);
      if (meta !== null) {
        writeFileSync(join(subagentsDirectory, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      }
      const effectiveModifiedMs = modifiedMs ?? findLatestRecordMs(text);
      if (effectiveModifiedMs !== null) {
        const modifiedDate = new Date(effectiveModifiedMs);
        utimesSync(filePath, modifiedDate, modifiedDate);
      }
      return filePath;
    },
    appendMain(line) {
      writeFileSync(transcriptPath, `${readFileSync(transcriptPath, 'utf8')}${line}\n`);
    },
  };
}

describe('SessionStart and Stop payloads', () => {
  test('the real SessionStart payloads (startup, resume) are read without an agent', () => {
    assert.deepEqual(hook.parseHookPayload(JSON.stringify(startupPayload)), {
      eventName: 'SessionStart',
      sessionId: startupPayload.session_id,
      agentId: null,
      agentType: null,
      transcriptPath: startupPayload.transcript_path,
      cwd: startupPayload.cwd,
      source: 'startup',
    });
    assert.equal(hook.parseHookPayload(JSON.stringify(resumePayload)).source, 'resume');
  });

  test('the real Stop payload is read without an agent', () => {
    const event = hook.parseHookPayload(JSON.stringify(stopPayload));
    assert.equal(event.eventName, 'Stop');
    assert.equal(event.sessionId, stopPayload.session_id);
    assert.equal(event.agentId, null);
    assert.equal(event.transcriptPath, stopPayload.transcript_path);
  });

  test('a SessionStart with an unknown or odd source still counts, and agent_type from `claude --agent` is not a sub agent', () => {
    for (const source of [undefined, '', 'Weird Value', 42, 'x'.repeat(40)]) {
      assert.equal(hook.parseHookPayload(JSON.stringify({ ...startupPayload, source })).source, 'unknown', String(source));
    }
    const withAgent = hook.parseHookPayload(JSON.stringify({ ...startupPayload, agent_type: 'reviewer' }));
    assert.equal(withAgent.agentId, null);
    assert.equal(withAgent.agentType, null);
    assert.equal(hook.parseHookPayload(JSON.stringify({ ...stopPayload, session_id: '../escape' })), null);
  });
});

function createHarness({ clockMs = Date.parse('2026-10-10T10:00:00.000Z'), ...overrides } = {}) {
  const runtimeDirectory = createTemporaryDirectory();
  const herdrCalls = [];
  let currentMs = clockMs;
  const dependencies = {
    now: () => currentMs,
    runHerdr: (binaryPath, argumentList) => {
      herdrCalls.push(argumentList);
    },
    isExecutable: () => true,
    queryPaneAgentSession: () => null,
    countClaudeAncestors: () => 1,
    deadlineMs: Number.POSITIVE_INFINITY,
    ...overrides,
  };
  const environment = { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr', XDG_RUNTIME_DIR: runtimeDirectory };
  const stateDirectory = join(runtimeDirectory, 'subagent-watch');
  const paneMapPath = join(stateDirectory, `pane-${testPaneId}.json`);
  return {
    runtimeDirectory,
    stateDirectory,
    paneMapPath,
    herdrCalls,
    run: (payload) => hook.runHook(JSON.stringify(payload), environment, dependencies),
    readPaneMap: () => JSON.parse(readFileSync(paneMapPath, 'utf8')),
    readState: (sessionId) => JSON.parse(readFileSync(join(stateDirectory, `session-${sessionId}.json`), 'utf8')),
    writeState: (sessionId, subagents) => {
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateDirectory, `session-${sessionId}.json`), JSON.stringify({ sessionId, lastSequence: 0, subagents }));
    },
    advanceClock: (durationMs) => {
      currentMs += durationMs;
    },
    nowMs: () => currentMs,
  };
}

function sessionPayload(base, files, overrides = {}) {
  return { ...base, session_id: files.sessionId, transcript_path: files.transcriptPath, ...overrides };
}

describe('SessionStart writes the pane map and redraws the sidebar for the new session', () => {
  test('the pane map carries the SessionStart mark and the tokens are cleared for a session without sub agents', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    const result = harness.run(sessionPayload(startupPayload, files));
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.lines, []);
    assert.deepEqual(harness.herdrCalls[0].slice(7), allTokensCleared);
    assert.deepEqual(harness.readPaneMap(), {
      sessionId: files.sessionId,
      transcriptPath: files.transcriptPath,
      cwd: startupPayload.cwd,
      updatedAtMs: harness.nowMs(),
      sessionStartSource: 'startup',
    });
    // 沒有 sub 的 session 不留空的狀態檔：每個 session 都會觸發 SessionStart
    assert.deepEqual(readdirSync(harness.stateDirectory).filter((name) => name.startsWith('session-')), []);
  });

  test('switching to another session replaces the old tree right away instead of waiting for the next sub agent event', () => {
    const harness = createHarness();
    const oldFiles = createSessionFiles('aaaa0000-0000-4000-8000-000000000001');
    const newFiles = createSessionFiles('aaaa0000-0000-4000-8000-000000000002');
    harness.run({ ...subagentStartPayload, session_id: oldFiles.sessionId, transcript_path: oldFiles.transcriptPath, agent_id: 'oldrunning1', agent_type: 'Explore' });
    assert.ok(harness.herdrCalls[0].includes('sub1=└─ Explore ●'));
    harness.advanceClock(1000);
    const result = harness.run(sessionPayload(startupPayload, newFiles, { source: 'clear' }));
    assert.deepEqual(result.lines, []);
    assert.deepEqual(harness.herdrCalls[1].slice(7), allTokensCleared);
    assert.equal(harness.readPaneMap().sessionId, newFiles.sessionId);
    assert.equal(harness.readPaneMap().sessionStartSource, 'clear');
  });

  test('resuming a session that still has running sub agents draws that session\'s tree', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'stillrunning1', agentType: 'Plan', startedAtMs: harness.nowMs() - 1000 }]);
    files.writeSubagent('stillrunning1', toJsonLines([assistantToolUse('2026-10-10T09:59:59.000Z', 'Bash', { command: 'ls' })]));
    const result = harness.run(sessionPayload(resumePayload, files));
    assert.deepEqual(result.lines, ['└─ Plan ●']);
    assert.equal(harness.readPaneMap().sessionStartSource, 'resume');
  });

  test('sub agent events of the same session keep the mark; an event of another session does not inherit it', () => {
    const harness = createHarness();
    const files = createSessionFiles('aaaa0000-0000-4000-8000-000000000003');
    harness.run(sessionPayload(startupPayload, files));
    const subagentStart = { ...subagentStartPayload, session_id: files.sessionId, transcript_path: files.transcriptPath, agent_id: 'keepmark1' };
    harness.advanceClock(10);
    harness.run(subagentStart);
    assert.equal(harness.readPaneMap().sessionStartSource, 'startup');
    assert.equal(harness.readPaneMap().updatedAtMs, harness.nowMs());
    harness.advanceClock(10);
    harness.run({ ...subagentStart, hook_event_name: 'SubagentStop' });
    assert.equal(harness.readPaneMap().sessionStartSource, 'startup');

    const otherFiles = createSessionFiles('aaaa0000-0000-4000-8000-000000000004');
    harness.run({ ...subagentStart, session_id: otherFiles.sessionId, transcript_path: otherFiles.transcriptPath });
    const paneMap = harness.readPaneMap();
    assert.equal(paneMap.sessionId, otherFiles.sessionId);
    assert.equal('sessionStartSource' in paneMap, false);
  });

  test('a nested-looking SessionStart that herdr does not confirm writes nothing', () => {
    const harness = createHarness({ countClaudeAncestors: () => 2, queryPaneAgentSession: () => ({ agent: 'claude', sessionId: 'main-session' }) });
    const result = harness.run(sessionPayload(startupPayload, createSessionFiles()));
    assert.deepEqual(result, { action: 'skipped', reason: 'nested-claude' });
    assert.deepEqual(readdirSync(harness.runtimeDirectory), []);
    assert.equal(harness.herdrCalls.length, 0);
  });
});

describe('Stop only prunes and redraws', () => {
  test('Stop never writes the pane map', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.run(sessionPayload(stopPayload, files));
    assert.equal(existsSync(harness.paneMapPath), false);
    harness.run(sessionPayload(startupPayload, files));
    const written = readFileSync(harness.paneMapPath, 'utf8');
    harness.advanceClock(5000);
    harness.run(sessionPayload(stopPayload, files));
    assert.equal(readFileSync(harness.paneMapPath, 'utf8'), written);
  });

  test('Stop with nothing to prune does not call herdr', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'running1', agentType: 'Explore', startedAtMs: harness.nowMs() - 1000 }]);
    files.writeSubagent('running1', toJsonLines([assistantToolUse('2026-10-10T09:59:59.500Z', 'Bash')]));
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
    assert.equal(harness.herdrCalls.length, 0);
  });

  test('review 23:19 (w8:pV): a sub agent stopped by an API error is removed on the next Stop and the tree is redrawn', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [
      { id: 'aapierror0000001', agentType: 'general-purpose', startedAtMs: Date.parse('2026-10-10T09:28:00.000Z') },
      { id: 'running2', agentType: 'Explore', startedAtMs: Date.parse('2026-10-10T09:50:00.000Z') },
    ]);
    files.writeSubagent('aapierror0000001', apiErrorTailText);
    files.writeSubagent('running2', toJsonLines([assistantToolUse('2026-10-10T09:59:00.000Z', 'Grep', { pattern: 'x' })]));
    const result = harness.run(sessionPayload(stopPayload, files));
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.removed, [{ id: 'aapierror0000001', reason: 'api_error' }]);
    assert.deepEqual(result.lines, ['└─ Explore ●']);
    assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), ['running2']);
  });

  test('pruning also runs on SubagentStart and SubagentStop, but never judges the sub agent that is just starting', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [
      { id: 'finished1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-10T09:40:00.000Z') },
    ]);
    files.writeSubagent('finished1', toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback', { message: 'done' })]));
    // resume：transcript 尾端還是上一輪的 SubagentHandback
    files.writeSubagent('resumed1', toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback', { message: 'old' })]));
    const result = harness.run({ ...subagentStartPayload, session_id: files.sessionId, transcript_path: files.transcriptPath, agent_id: 'resumed1', agent_type: 'Explore' });
    assert.deepEqual(result.removed, [{ id: 'finished1', reason: 'handback' }]);
    assert.deepEqual(result.lines, ['└─ Explore ●']);
    // 下一個事件：resume 後的 sub 還沒寫新紀錄，舊的 handback 早於它的 SubagentStart，不算
    harness.advanceClock(3000);
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
  });

  test('without the main transcript nothing is pruned (the sub agent paths cannot be trusted)', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'nofile1', agentType: 'Plan', startedAtMs: harness.nowMs() - 3 * 60 * minuteMs }]);
    const missingMain = join(dirname(files.transcriptPath), 'bbbb0000-0000-4000-8000-0000000000bb.jsonl');
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files, { transcript_path: missingMain })), { action: 'unchanged' });
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files, { transcript_path: 'relative/x.jsonl' })), { action: 'unchanged' });
  });

  test('pruning stops when the time budget runs out and keeps the rest', () => {
    const files = createSessionFiles();
    const state = { sessionId: files.sessionId, lastSequence: 0, subagents: [
      { id: 'done1', agentType: 'Plan', startedAtMs: 0 },
      { id: 'done2', agentType: 'Plan', startedAtMs: 0 },
    ] };
    for (const agentId of ['done1', 'done2']) {
      files.writeSubagent(agentId, toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback')]));
    }
    const event = hook.parseHookPayload(JSON.stringify(sessionPayload(stopPayload, files)));
    let checks = 0;
    const result = hook.pruneEndedSubagents(state, event, { nowMs: Date.parse('2026-10-10T10:00:00.000Z'), hasTimeLeft: () => {
      checks += 1;
      return checks === 1;
    } });
    assert.deepEqual(result.removed, [{ id: 'done1', reason: 'handback' }]);
    assert.deepEqual(result.state.subagents.map((subagent) => subagent.id), ['done2']);
  });
});

// 官方 hooks 文件（https://code.claude.com/docs/en/hooks#stopfailure）的範例 payload：回合因 API 錯誤結束時不觸發 Stop、改觸發 StopFailure。
// 本機沒有實際觸發過（要真的遇到 API 錯誤），欄位照文件
const stopFailurePayload = {
  session_id: 'abc123',
  transcript_path: '/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/...',
  hook_event_name: 'StopFailure',
  error: 'rate_limit',
  error_details: '429 Too Many Requests',
  last_assistant_message: 'API Error: Rate limit reached',
};

describe('StopFailure (a turn ended by an API error) prunes like Stop', () => {
  test('the documented StopFailure payload is read as a session event, whatever the error type', () => {
    assert.deepEqual(hook.parseHookPayload(JSON.stringify(stopFailurePayload)), {
      eventName: 'StopFailure',
      sessionId: 'abc123',
      agentId: null,
      agentType: null,
      transcriptPath: stopFailurePayload.transcript_path,
      cwd: '/Users/...',
      source: null,
    });
    for (const error of ['overloaded', 'server_error', 'unknown', 'something_new', undefined]) {
      assert.equal(hook.parseHookPayload(JSON.stringify({ ...stopFailurePayload, error })).eventName, 'StopFailure', String(error));
    }
    assert.equal(hook.parseHookPayload(JSON.stringify({ ...stopFailurePayload, session_id: '../escape' })), null);
  });

  test('a sub agent stopped by the same API error is removed on StopFailure and the tree is redrawn', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [
      { id: 'aapierror0000001', agentType: 'general-purpose', startedAtMs: Date.parse('2026-10-10T09:28:00.000Z') },
      { id: 'running2', agentType: 'Explore', startedAtMs: Date.parse('2026-10-10T09:50:00.000Z') },
    ]);
    files.writeSubagent('aapierror0000001', apiErrorTailText);
    files.writeSubagent('running2', toJsonLines([assistantToolUse('2026-10-10T09:59:00.000Z', 'Grep', { pattern: 'x' })]));
    const result = harness.run(sessionPayload(stopFailurePayload, files));
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.removed, [{ id: 'aapierror0000001', reason: 'api_error' }]);
    assert.deepEqual(result.lines, ['└─ Explore ●']);
    assert.equal(harness.herdrCalls.length, 1);
    assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), ['running2']);
  });

  test('StopFailure never writes the pane map and calls herdr only when something was removed', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'running1', agentType: 'Explore', startedAtMs: harness.nowMs() - 1000 }]);
    files.writeSubagent('running1', toJsonLines([assistantToolUse('2026-10-10T09:59:59.500Z', 'Bash')]));
    assert.deepEqual(harness.run(sessionPayload(stopFailurePayload, files)), { action: 'unchanged' });
    assert.equal(existsSync(harness.paneMapPath), false);
    assert.equal(harness.herdrCalls.length, 0);

    harness.run(sessionPayload(startupPayload, files));
    const written = readFileSync(harness.paneMapPath, 'utf8');
    harness.advanceClock(5000);
    assert.deepEqual(harness.run(sessionPayload(stopFailurePayload, files)), { action: 'unchanged' });
    assert.equal(readFileSync(harness.paneMapPath, 'utf8'), written);
  });

  test('the nested claude check applies to StopFailure as well', () => {
    const files = createSessionFiles();
    const nested = createHarness({ countClaudeAncestors: () => 2, queryPaneAgentSession: () => ({ agent: 'claude', sessionId: 'main-session' }) });
    assert.deepEqual(nested.run(sessionPayload(stopFailurePayload, files)), { action: 'skipped', reason: 'nested-claude' });
    assert.deepEqual(readdirSync(nested.runtimeDirectory), []);
    const confirmed = createHarness({ countClaudeAncestors: () => 2, queryPaneAgentSession: () => ({ agent: 'claude', sessionId: files.sessionId }) });
    assert.deepEqual(confirmed.run(sessionPayload(stopFailurePayload, files)), { action: 'unchanged' });
  });
});

describe('when a sub agent counts as ended', () => {
  const nowMs = Date.parse('2026-10-10T10:00:00.000Z');
  const startedAtMs = Date.parse('2026-10-10T09:00:00.000Z');
  const judge = (records, overrides = {}) => hook.detectSubagentEnd({ startedAtMs, records, nowMs, ...overrides });

  test('the real API error tail (usage limit) counts as ended', () => {
    assert.equal(judge(parseRecords(apiErrorTailText)), 'api_error');
  });

  test('the real interrupted tail counts as ended', () => {
    assert.equal(judge(parseRecords(interruptedTailText), { startedAtMs: Date.parse('2026-10-09T06:00:00.000Z') }), 'interrupted');
  });

  test('an API error or interruption followed by a new prompt (the sub agent was resumed) does not count', () => {
    const resumed = [...parseRecords(apiErrorTailText), { type: 'user', timestamp: '2026-10-10T09:40:00.000Z', message: { content: 'continue' } }];
    assert.equal(judge(resumed), null);
    const interruptedThenResumed = [...parseRecords(interruptedTailText), { type: 'user', timestamp: '2026-10-09T06:31:00.000Z', message: { content: 'go on' } }];
    assert.equal(judge(interruptedThenResumed, { startedAtMs: Date.parse('2026-10-09T06:00:00.000Z') }), null);
  });

  test('the viewer rules are reused: SubagentHandback, end_turn only for non-background sub agents, and task notifications', () => {
    assert.equal(judge([assistantToolUse('2026-10-10T09:30:00.000Z', 'SubagentHandback')]), 'handback');
    const endTurn = [assistantToolUse('2026-10-10T09:30:00.000Z', 'Bash'), assistantEndTurn('2026-10-10T09:31:00.000Z')];
    assert.equal(judge(endTurn, { meta: { requestShape: 'background' } }), null);
    assert.equal(judge(endTurn, { meta: { requestShape: 'background', isFork: true } }), 'end_turn');
    const notification = { agentId: 'x', status: 'killed', timestampMs: Date.parse('2026-10-10T09:32:00.000Z') };
    assert.equal(judge([assistantToolUse('2026-10-10T09:30:00.000Z', 'Bash')], { notification }), 'killed');
  });

  // 舊版有「60 分鐘沒寫入就清」：本機 2 個 sub 在同一輪內 7 小時、23 小時沒寫入之後繼續跑，會被誤刪
  test('a sub agent without an end signal is kept however long its transcript has not been written', () => {
    const running = [assistantToolUse('2026-10-10T09:01:00.000Z', 'Bash', { command: 'make' }), userToolResult('2026-10-10T09:01:30.000Z')];
    assert.equal(judge(running), null);
    const earlyStartMs = Date.parse('2026-10-09T08:00:00.000Z');
    for (const silentMs of [59 * minuteMs, 61 * minuteMs, 7 * 60 * minuteMs, 23 * 60 * minuteMs]) {
      assert.equal(judge(running, { startedAtMs: earlyStartMs, lastWriteMs: nowMs - silentMs, nowMs }), null, `${silentMs / minuteMs} minutes`);
    }
    const waitingOnTool = [assistantToolUse('2026-10-09T09:00:00.000Z', 'Bash', { command: 'sleep' })];
    assert.equal(judge(waitingOnTool, { startedAtMs: earlyStartMs }), null);
  });

  test('only the last message counts: a hand back followed by more work is not an end, its own tool result is', () => {
    const handbackAt = '2026-10-10T09:30:00.000Z';
    const handback = assistantToolUse(handbackAt, 'SubagentHandback', { message: 'done' });
    assert.equal(judge([handback, userToolResultFor('2026-10-10T09:30:00.200Z', handbackAt)]), 'handback');
    // 排隊的訊息讓 sub 在 SubagentHandback 之後繼續跑
    const continued = [handback, userToolResultFor('2026-10-10T09:30:00.200Z', handbackAt), userPrompt('2026-10-10T09:30:00.500Z', 'one more thing'), assistantToolUse('2026-10-10T09:30:05.000Z', 'Bash')];
    assert.equal(judge(continued), null);
    assert.equal(judge([handback, userPrompt('2026-10-10T09:31:00.000Z', 'resume with this')]), null);
  });

  test('an end signal counts only after 2 minutes without any record or write', () => {
    assert.equal(hook.quietAfterEndSignalMs, 2 * minuteMs);
    const signalMs = Date.parse('2026-10-10T09:30:00.000Z');
    const handback = [assistantToolUse('2026-10-10T09:30:00.000Z', 'SubagentHandback')];
    assert.equal(judge(handback, { nowMs: signalMs + hook.quietAfterEndSignalMs - 1, lastWriteMs: signalMs }), null);
    assert.equal(judge(handback, { nowMs: signalMs + hook.quietAfterEndSignalMs, lastWriteMs: signalMs }), 'handback');
    // transcript 之後還有寫入（mtime 較晚）：從那次寫入重新算
    const laterWriteMs = signalMs + minuteMs;
    assert.equal(judge(handback, { nowMs: signalMs + hook.quietAfterEndSignalMs, lastWriteMs: laterWriteMs }), null);
    assert.equal(judge(handback, { nowMs: laterWriteMs + hook.quietAfterEndSignalMs, lastWriteMs: laterWriteMs }), 'handback');
    // 結束訊號之後的 attachment 不改變結束判斷，但也算一次寫入
    const withAttachment = [...handback, { type: 'attachment', timestamp: '2026-10-10T09:30:30.000Z' }];
    assert.equal(judge(withAttachment, { nowMs: signalMs + hook.quietAfterEndSignalMs }), null);
    assert.equal(judge(withAttachment, { nowMs: signalMs + 30 * 1000 + hook.quietAfterEndSignalMs }), 'handback');
  });

  // 本機 a1581f8f：額度用完停在 API 錯誤那一筆，沒收到 SubagentStop；main transcript 不久後記了 failed 的通知
  test('a sub agent stopped by an API error without a SubagentStop is removed 2 minutes after its last record', () => {
    const records = parseRecords(apiErrorTailText);
    const lastRecordMs = Date.parse('2026-10-10T09:33:03.829Z');
    const options = { startedAtMs: Date.parse('2026-10-10T09:28:10.847Z'), lastWriteMs: lastRecordMs };
    assert.equal(judge(records, { ...options, nowMs: lastRecordMs + hook.quietAfterEndSignalMs - 1 }), null);
    assert.equal(judge(records, { ...options, nowMs: lastRecordMs + hook.quietAfterEndSignalMs }), 'api_error');
    const notification = { agentId: 'a1581f8ff64effcfe', status: 'failed', timestampMs: Date.parse('2026-10-10T09:33:04.386Z') };
    assert.equal(judge(records, { ...options, notification, nowMs: notification.timestampMs + hook.quietAfterEndSignalMs - 1 }), null);
    assert.equal(judge(records, { ...options, notification, nowMs: notification.timestampMs + hook.quietAfterEndSignalMs }), 'failed');
  });

  test('end signals from before this run\'s SubagentStart (an earlier run) do not count, with no tolerance', () => {
    const handback = [assistantToolUse('2026-10-10T09:30:00.000Z', 'SubagentHandback')];
    assert.equal(judge(handback, { startedAtMs: Date.parse('2026-10-10T09:35:00.000Z') }), null);
    assert.equal(judge(handback, { startedAtMs: Date.parse('2026-10-10T09:30:00.001Z') }), null);
    assert.equal(judge(handback, { startedAtMs: Date.parse('2026-10-10T09:30:00.000Z') }), 'handback');
    assert.equal(judge(parseRecords(apiErrorTailText), { startedAtMs: Date.parse('2026-10-10T09:40:00.000Z') }), null);
    assert.equal(judge(parseRecords(apiErrorTailText), { startedAtMs: Date.parse('2026-10-10T09:33:04.500Z') }), null);
  });

  test('a task notification counts only when it is not older than the last message and that message is not a new prompt', () => {
    const killed = (timestamp) => ({ agentId: 'x', status: 'killed', timestampMs: Date.parse(timestamp) });
    const waitingOnTool = [assistantToolUse('2026-10-10T09:30:00.000Z', 'Bash'), userToolResultFor('2026-10-10T09:30:10.000Z', '2026-10-10T09:30:00.000Z')];
    assert.equal(judge(waitingOnTool, { notification: killed('2026-10-10T09:31:00.000Z') }), 'killed');
    assert.equal(judge(waitingOnTool, { notification: killed('2026-10-10T09:30:05.000Z') }), null);
    // resume 送進來的指令之後 sub 會繼續跑：比它晚的通知也不信
    const resumed = [assistantToolUse('2026-10-10T09:30:00.000Z', 'SubagentHandback'), userPrompt('2026-10-10T09:31:00.000Z', 'resume with this')];
    assert.equal(judge(resumed, { startedAtMs: Date.parse('2026-10-10T09:30:59.000Z'), notification: killed('2026-10-10T09:31:30.000Z') }), null);
  });
});

describe('reading only the end of a transcript', () => {
  test('a large transcript is judged from its last 64 KB', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    const filler = toJsonLines(Array.from({ length: 4000 }, (unused, index) => assistantToolUse(`2026-10-10T09:10:${String(index % 60).padStart(2, '0')}.000Z`, 'Bash', { command: 'x'.repeat(200) })));
    assert.ok(filler.length > 10 * hook.transcriptTailBytes);
    harness.writeState(files.sessionId, [
      { id: 'bigdone1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-10T09:00:00.000Z') },
      { id: 'bigold1', agentType: 'Explore', startedAtMs: Date.parse('2026-10-10T09:00:00.000Z') },
    ]);
    files.writeSubagent('bigdone1', filler + toJsonLines([assistantToolUse('2026-10-10T09:50:00.000Z', 'SubagentHandback')]));
    // 結束訊號在尾端 64 KB 之前：讀不到，當成還在跑（docs/sidebar.md 已知限制）
    files.writeSubagent('bigold1', toJsonLines([assistantToolUse('2026-10-10T09:05:00.000Z', 'SubagentHandback')]) + filler);
    const result = harness.run(sessionPayload(stopPayload, files));
    assert.deepEqual(result.removed, [{ id: 'bigdone1', reason: 'handback' }]);
  });

  test('a task notification in the tail of the main transcript ends a killed sub agent', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'killed1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-10T09:00:00.000Z') }]);
    files.writeSubagent('killed1', toJsonLines([assistantToolUse('2026-10-10T09:10:00.000Z', 'Bash')]));
    files.appendMain(notificationLine('killed1', 'killed', '2026-10-10T09:11:00.000Z'));
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)).removed, [{ id: 'killed1', reason: 'killed' }]);
  });

  test('a transcript that is not there yet is kept for 2 minutes, then removed', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'nofileyet1', agentType: 'Plan', startedAtMs: harness.nowMs() }]);
    harness.advanceClock(hook.missingTranscriptGraceMs - 1000);
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
    harness.advanceClock(2000);
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)).removed, [{ id: 'nofileyet1', reason: 'missing-transcript' }]);
  });

  test('a FIFO planted where a transcript should be is not waited on', () => {
    const files = createSessionFiles();
    const fifoPath = join(files.subagentsDirectory, 'agent-fifo1.jsonl');
    const made = spawnSync('mkfifo', [fifoPath]);
    if (made.status !== 0) {
      return;
    }
    const startedAtMs = Date.now();
    assert.equal(hook.readFileTail(fifoPath, hook.transcriptTailBytes), null);
    assert.ok(Date.now() - startedAtMs < 500);
  });
});

// 清除只當 SubagentStop 漏掉時的安全網：resume、排隊訊息、長時間沒寫入的 sub 都不能被誤刪
describe('the safety net never removes a sub agent that is still running', () => {
  // review 的 E2E（claude -p，foreground sub，SendMessage resume）實際的 hook 與紀錄時間
  const agentId = 'a480a48b30c999a29';
  const firstStartMs = Date.parse('2026-10-10T18:22:59.589Z');
  const firstStopMs = Date.parse('2026-10-10T18:23:00.595Z');
  const resumeStartMs = Date.parse('2026-10-10T18:23:02.526Z');
  const firstRun = [
    userPrompt('2026-10-10T18:22:59.558Z', 'Reply with the single word ALPHA. Do not use any tools.'),
    assistantEndTurn('2026-10-10T18:23:00.541Z'),
    { type: 'attachment', timestamp: '2026-10-10T18:23:00.565Z' },
  ];
  const resumePrompt = userPrompt('2026-10-10T18:23:02.494Z', 'The coordinator sent a message while you were working:\nReply with the single word BETA.');
  const foregroundMeta = { agentType: 'general-purpose', requestShape: 'foreground' };

  function startResumeCase({ isFirstStopRecorded }) {
    const harness = createHarness({ clockMs: firstStartMs });
    const files = createSessionFiles();
    const subagentEvent = (eventName) => ({ ...subagentStartPayload, hook_event_name: eventName, session_id: files.sessionId, transcript_path: files.transcriptPath, agent_id: agentId, agent_type: 'general-purpose' });
    files.writeSubagent(agentId, toJsonLines(firstRun.slice(0, 1)), { meta: foregroundMeta });
    harness.run(subagentEvent('SubagentStart'));
    files.writeSubagent(agentId, toJsonLines(firstRun), { meta: foregroundMeta });
    harness.advanceClock(firstStopMs - firstStartMs);
    if (isFirstStopRecorded) {
      harness.run(subagentEvent('SubagentStop'));
    }
    harness.advanceClock(resumeStartMs - firstStopMs);
    harness.run(subagentEvent('SubagentStart'));
    return { harness, files };
  }

  for (const isFirstStopRecorded of [true, false]) {
    test(`a sub agent resumed 2 seconds after its previous end is kept until its new run ends (first SubagentStop ${isFirstStopRecorded ? 'recorded' : 'missed'})`, () => {
      const { harness, files } = startResumeCase({ isFirstStopRecorded });
      assert.deepEqual(harness.readState(files.sessionId).subagents, [{ id: agentId, agentType: 'general-purpose', startedAtMs: resumeStartMs }]);
      // 新一輪還沒寫任何紀錄：尾端還是上一輪的 end_turn
      harness.advanceClock(500);
      assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
      // 新一輪的指令寫進來了，sub 還沒回應
      files.writeSubagent(agentId, toJsonLines([...firstRun, resumePrompt]), { meta: foregroundMeta, modifiedMs: harness.nowMs() });
      harness.advanceClock(hook.quietAfterEndSignalMs);
      assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
      assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), [agentId]);
    });
  }

  test('when the new run ends and its SubagentStop is missed, it is removed on the first hook 2 minutes after its last record', () => {
    const { harness, files } = startResumeCase({ isFirstStopRecorded: true });
    const secondEndMs = Date.parse('2026-10-10T18:23:03.434Z');
    files.writeSubagent(agentId, toJsonLines([...firstRun, resumePrompt, assistantEndTurn('2026-10-10T18:23:03.434Z')]), { meta: foregroundMeta });
    harness.advanceClock(Date.parse('2026-10-10T18:23:04.298Z') - resumeStartMs);
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
    harness.advanceClock(secondEndMs + hook.quietAfterEndSignalMs - harness.nowMs());
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)).removed, [{ id: agentId, reason: 'end_turn' }]);
  });

  test('a sub agent that has written nothing for hours without an end signal is kept', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'sleeping1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-09T08:00:00.000Z') }]);
    files.writeSubagent('sleeping1', toJsonLines([assistantToolUse('2026-10-09T11:00:00.000Z', 'Bash', { command: 'make' })]));
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
  });

  // 本機 a5b8bfbe：SubagentHandback 之後因排隊訊息繼續跑 Bash；那則通知的 remove（出列）時間比當時最後一筆紀錄晚
  test('a task notification counts by its enqueue time, not by when the main session took it off the queue', () => {
    const harness = createHarness();
    const files = createSessionFiles();
    harness.writeState(files.sessionId, [{ id: 'queued1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-10T09:30:00.000Z') }]);
    const handbackAt = '2026-10-10T09:40:00.000Z';
    files.writeSubagent('queued1', toJsonLines([
      assistantToolUse(handbackAt, 'SubagentHandback', { message: 'done' }),
      userToolResultFor('2026-10-10T09:40:00.200Z', handbackAt),
      userPrompt('2026-10-10T09:40:00.500Z', 'The coordinator sent a message while you were working:\nAlso run the tests.'),
      assistantToolUse('2026-10-10T09:40:05.000Z', 'Bash', { command: 'npm test' }),
    ]));
    files.appendMain(notificationLine('queued1', 'completed', '2026-10-10T09:40:00.300Z', 'enqueue'));
    files.appendMain(notificationLine('queued1', 'completed', '2026-10-10T09:40:06.000Z', 'remove'));
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
  });
});

// 讀 transcript 判斷 sub 是否結束放在 lock 裡的話，同一個 session 平行觸發的 hook 每個都要多等前面每一個讀完，
// 排在後面的等不到 lock 就放棄（SubagentStart 放棄了，那個 sub 就永遠不會出現在側邊欄）
describe('transcripts are read before the session lock is taken', () => {
  const lockPathOf = (harness, sessionId) => join(harness.stateDirectory, `session-${sessionId}.json.lock`);

  test('every transcript and meta read happens while the lock does not exist; herdr is called while it does', () => {
    const files = createSessionFiles();
    const reads = [];
    let lockPath = null;
    let isLockHeldDuringHerdr = null;
    const harness = createHarness({
      readFileTail: (filePath, maximumBytes) => {
        reads.push({ name: basename(filePath), isLockHeld: existsSync(lockPath) });
        return hook.readFileTail(filePath, maximumBytes);
      },
      // 對照組：lock 內一定看得到 lock 檔，確認上面的檢查不是永遠 false
      runHerdr: () => {
        isLockHeldDuringHerdr = existsSync(lockPath);
      },
    });
    lockPath = lockPathOf(harness, files.sessionId);
    harness.writeState(files.sessionId, [
      { id: 'finished1', agentType: 'Plan', startedAtMs: Date.parse('2026-10-10T09:40:00.000Z') },
      { id: 'running2', agentType: 'Explore', startedAtMs: Date.parse('2026-10-10T09:50:00.000Z') },
    ]);
    files.writeSubagent('finished1', toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback')]));
    files.writeSubagent('running2', toJsonLines([assistantToolUse('2026-10-10T09:59:00.000Z', 'Grep', { pattern: 'x' })]));
    const result = harness.run({ ...subagentStartPayload, session_id: files.sessionId, transcript_path: files.transcriptPath, agent_id: 'new3', agent_type: 'Explore' });
    assert.deepEqual(reads.filter((read) => read.isLockHeld), []);
    assert.equal(isLockHeldDuringHerdr, true);
    assert.deepEqual(result.removed, [{ id: 'finished1', reason: 'handback' }]);
    assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), ['running2', 'new3']);
    assert.deepEqual(reads.map((read) => read.name).sort(), [
      `${files.sessionId}.jsonl`,
      'agent-finished1.jsonl',
      'agent-finished1.meta.json',
      'agent-running2.jsonl',
      'agent-running2.meta.json',
    ]);
    assert.equal(existsSync(lockPath), false);
  });

  test('only sub agents still in the state, with the same start, are removed: another hook may have changed it in between', () => {
    const files = createSessionFiles();
    const judgedStartMs = Date.parse('2026-10-10T09:40:00.000Z');
    let isStateChangedByOtherHook = false;
    const harness = createHarness({
      readFileTail: (filePath, maximumBytes) => {
        // 這裡已經讀完 lock 外的狀態檔、正在讀 transcript：模擬別的 hook 在這段時間拿到 lock 改了狀態檔
        if (!isStateChangedByOtherHook) {
          isStateChangedByOtherHook = true;
          harness.writeState(files.sessionId, [
            // 被拿掉後又 SubagentStart（resume）的新一輪：判斷的是上一輪，不能拿掉
            { id: 'resumed1', agentType: 'Plan', startedAtMs: harness.nowMs() },
            { id: 'finished2', agentType: 'Plan', startedAtMs: judgedStartMs },
            { id: 'added3', agentType: 'Explore', startedAtMs: harness.nowMs() },
          ]);
        }
        return hook.readFileTail(filePath, maximumBytes);
      },
    });
    harness.writeState(files.sessionId, [
      { id: 'resumed1', agentType: 'Plan', startedAtMs: judgedStartMs },
      { id: 'finished2', agentType: 'Plan', startedAtMs: judgedStartMs },
      { id: 'gone4', agentType: 'Plan', startedAtMs: judgedStartMs },
    ]);
    for (const agentId of ['resumed1', 'finished2', 'gone4']) {
      files.writeSubagent(agentId, toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback')]));
    }
    const result = harness.run(sessionPayload(stopPayload, files));
    assert.equal(result.action, 'reported');
    assert.deepEqual(result.removed, [{ id: 'finished2', reason: 'handback' }]);
    assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), ['resumed1', 'added3']);
  });

  test('judging stops at its own time budget and the event itself is still recorded', () => {
    const files = createSessionFiles();
    const harness = createHarness({
      readFileTail: (filePath, maximumBytes) => {
        harness.advanceClock(hook.maximumPruneMs / 2);
        return hook.readFileTail(filePath, maximumBytes);
      },
    });
    const startedAtMs = Date.parse('2026-10-10T09:40:00.000Z');
    harness.writeState(files.sessionId, ['done1', 'done2', 'done3'].map((id) => ({ id, agentType: 'Plan', startedAtMs })));
    for (const agentId of ['done1', 'done2', 'done3']) {
      files.writeSubagent(agentId, toJsonLines([assistantToolUse('2026-10-10T09:45:00.000Z', 'SubagentHandback')]));
    }
    const result = harness.run({ ...subagentStartPayload, session_id: files.sessionId, transcript_path: files.transcriptPath, agent_id: 'new4', agent_type: 'Explore' });
    // 讀 main transcript 用掉一半預算、done1 的 transcript 用掉另一半：done1 判斷完就停，done2、done3 留到下一次事件
    assert.deepEqual(result.removed, [{ id: 'done1', reason: 'handback' }]);
    assert.deepEqual(harness.readState(files.sessionId).subagents.map((subagent) => subagent.id), ['done2', 'done3', 'new4']);
  });

  test('a Stop with nothing to remove does not wait for the lock', () => {
    const files = createSessionFiles();
    const harness = createHarness({ now: () => Date.now(), deadlineMs: Date.now() + 300 });
    harness.writeState(files.sessionId, [{ id: 'running1', agentType: 'Explore', startedAtMs: Date.now() - 1000 }]);
    files.writeSubagent('running1', toJsonLines([assistantToolUse(new Date().toISOString(), 'Bash')]));
    // 活著的 process（自己）持有的 lock：要搶的話只會等到預算用完、回報 lock-timeout
    const lockPath = lockPathOf(harness, files.sessionId);
    const ownLock = JSON.stringify({ pid: process.pid, startTime: hook.readProcessInfo(process.pid).startTime, createdAtMs: Date.now() });
    writeFileSync(lockPath, ownLock);
    assert.deepEqual(harness.run(sessionPayload(stopPayload, files)), { action: 'unchanged' });
    assert.equal(readFileSync(lockPath, 'utf8'), ownLock);
    assert.equal(harness.herdrCalls.length, 0);
  });
});

describe('hook script with SessionStart and Stop, as Claude Code runs it', () => {
  function createScriptCase() {
    const workDirectory = createTemporaryDirectory();
    const runtimeDirectory = join(workDirectory, 'runtime');
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    const callLogPath = join(workDirectory, 'herdr-calls.jsonl');
    const fakeHerdrPath = join(workDirectory, 'herdr');
    writeFileSync(fakeHerdrPath, [
      `#!${process.execPath}`,
      `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      '',
    ].join('\n'), { mode: 0o755 });
    return {
      runtimeDirectory,
      callLogPath,
      environment: { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtimeDirectory, HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: fakeHerdrPath },
    };
  }

  function runScript(environment, payload) {
    const startedAtMs = Date.now();
    const result = spawnSync(process.execPath, [hookScriptPath], { input: JSON.stringify(payload), env: environment, encoding: 'utf8', timeout: 5000 });
    return { ...result, elapsedMs: Date.now() - startedAtMs };
  }

  const readCalls = (callLogPath) => readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  test('SessionStart: exit 0, no output, pane map marked, tokens cleared, under 1 second', () => {
    const scriptCase = createScriptCase();
    const files = createSessionFiles();
    const result = runScript(scriptCase.environment, sessionPayload(startupPayload, files));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
    const paneMap = JSON.parse(readFileSync(join(scriptCase.runtimeDirectory, 'subagent-watch', `pane-${testPaneId}.json`), 'utf8'));
    assert.equal(paneMap.sessionStartSource, 'startup');
    assert.equal(paneMap.sessionId, files.sessionId);
    assert.deepEqual(readCalls(scriptCase.callLogPath).map((call) => call.slice(7)), [allTokensCleared]);
  });

  test('Stop: a stuck sub agent among five with large transcripts is removed within the time budget', () => {
    const scriptCase = createScriptCase();
    const files = createSessionFiles();
    const filler = toJsonLines(Array.from({ length: 2000 }, (unused, index) => assistantToolUse(`2026-10-10T09:20:${String(index % 60).padStart(2, '0')}.000Z`, 'Read', { file_path: '/x'.repeat(100) })));
    const subagents = [];
    for (let index = 0; index < 5; index += 1) {
      const agentId = `bigrun${index}`;
      subagents.push({ id: agentId, agentType: `worker${index}`, startedAtMs: Date.parse('2026-10-10T09:00:00.000Z') + index });
      files.writeSubagent(agentId, filler);
    }
    files.writeSubagent('bigrun2', filler + apiErrorTailText);
    mkdirSync(join(scriptCase.runtimeDirectory, 'subagent-watch'), { mode: 0o700 });
    writeFileSync(join(scriptCase.runtimeDirectory, 'subagent-watch', `session-${files.sessionId}.json`), JSON.stringify({ sessionId: files.sessionId, lastSequence: 0, subagents }));
    const result = runScript(scriptCase.environment, sessionPayload(stopPayload, files));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
    const calls = readCalls(scriptCase.callLogPath);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filter((argument) => /^sub\d/.test(argument)), [
      'sub1=├─ worker0 ●',
      'sub2=├─ worker1 ●',
      'sub3=├─ worker3 ●',
      'sub4=└─ worker4 ●',
      'sub5',
    ]);
  });

  test('StopFailure: exit 0, no output, the sub agent stopped by the API error is removed, no pane map written', () => {
    const scriptCase = createScriptCase();
    const files = createSessionFiles();
    const stateDirectory = join(scriptCase.runtimeDirectory, 'subagent-watch');
    mkdirSync(stateDirectory, { mode: 0o700 });
    writeFileSync(join(stateDirectory, `session-${files.sessionId}.json`), JSON.stringify({ sessionId: files.sessionId, lastSequence: 0, subagents: [
      { id: 'aapierror0000001', agentType: 'general-purpose', startedAtMs: Date.parse('2026-10-10T09:28:00.000Z') },
    ] }));
    files.writeSubagent('aapierror0000001', apiErrorTailText);
    const result = runScript(scriptCase.environment, sessionPayload(stopFailurePayload, files));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
    assert.deepEqual(readCalls(scriptCase.callLogPath).map((call) => call.slice(7)), [allTokensCleared]);
    assert.equal(existsSync(join(stateDirectory, `pane-${testPaneId}.json`)), false);
  });
});
