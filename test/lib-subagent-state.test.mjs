import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMeta,
  applyNotification,
  applyRecord,
  createSubAgentState,
  getSubAgentStatus,
  resumeGraceMs,
  staleAfterMs,
} from '../lib/subagent-state.mjs';

const baseMs = Date.parse('2026-10-10T01:00:00.000Z');

function at(offsetSeconds) {
  return new Date(baseMs + offsetSeconds * 1000).toISOString();
}

function toolUseRecord(offsetSeconds, id, name, input = {}, stopReason = null) {
  return {
    type: 'assistant',
    timestamp: at(offsetSeconds),
    message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: stopReason },
  };
}

function freshState() {
  const state = createSubAgentState({ agentId: 'a1', discoveredAtMs: baseMs });
  state.lastWriteMs = baseMs;
  return state;
}

test('a sub agent with recent tool calls and no end signal is running', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash', { command: 'ls' }));
  const status = getSubAgentStatus(state, baseMs + 5_000);
  assert.equal(status.isDone, false);
  assert.equal(state.events.length, 1);
});

test('SubagentHandback marks the sub agent done', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash'));
  applyRecord(state, toolUseRecord(2, 't2', 'SubagentHandback', { message: 'report' }));
  const status = getSubAgentStatus(state, baseMs + 3_000);
  assert.deepEqual(status, { isDone: true, isWaiting: false, reason: 'handback', atMs: baseMs + 2_000 });
});

test('a final end_turn reply marks the sub agent done', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash'));
  applyRecord(state, {
    type: 'assistant',
    timestamp: at(4),
    message: { content: [{ type: 'text', text: 'Summary' }], stop_reason: 'end_turn' },
  });
  assert.equal(getSubAgentStatus(state, baseMs + 5_000).reason, 'end_turn');
});

test('a killed notification from the main transcript marks the sub agent done', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash'));
  applyNotification(state, { agentId: 'a1', status: 'killed', timestampMs: baseMs + 60_000 });
  assert.deepEqual(getSubAgentStatus(state, baseMs + 61_000), { isDone: true, isWaiting: false, reason: 'killed', atMs: baseMs + 60_000 });
});

test('new assistant activity after an end signal flips the sub agent back to running', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(2, 't1', 'SubagentHandback'));
  applyNotification(state, { agentId: 'a1', status: 'completed', timestampMs: baseMs + 3_000 });
  assert.equal(getSubAgentStatus(state, baseMs + 4_000).isDone, true);
  applyRecord(state, toolUseRecord(30, 't2', 'Read', { file_path: '/tmp/x' }));
  assert.equal(getSubAgentStatus(state, baseMs + 31_000).isDone, false);
});

test('no writes for longer than the stale threshold counts as done', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash'));
  assert.equal(getSubAgentStatus(state, baseMs + staleAfterMs).isDone, false);
  assert.deepEqual(getSubAgentStatus(state, baseMs + staleAfterMs + 1), { isDone: true, isWaiting: false, reason: 'stale', atMs: baseMs });
});

test('duplicate tool_use ids are only shown once', () => {
  const state = freshState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash', { command: 'ls' }));
  applyRecord(state, toolUseRecord(1, 't1', 'Bash', { command: 'ls' }));
  assert.equal(state.events.length, 1);
});

test('every event is kept so the viewer can scroll back through the whole transcript', () => {
  const state = freshState();
  for (let index = 0; index < 2500; index += 1) {
    applyRecord(state, toolUseRecord(index, `t${index}`, 'Bash', { command: `step ${index}` }));
  }
  assert.equal(state.events.length, 2500);
  assert.equal(state.events[0].summary, 'step 0');
  assert.equal(state.events.at(-1).summary, 'step 2499');
});

function endTurnRecord(offsetSeconds) {
  return {
    type: 'assistant',
    timestamp: at(offsetSeconds),
    message: { content: [{ type: 'text', text: 'Report' }], stop_reason: 'end_turn' },
  };
}

test('a background sub agent is not done at end_turn; it waits for SubagentHandback', () => {
  const state = freshState();
  applyMeta(state, { agentType: 'general-purpose', requestShape: 'background', requestNonInteractive: true });
  applyRecord(state, toolUseRecord(1, 't1', 'Bash'));
  // 實際 transcript：end_turn 之後被 [handback-send-enforce] 叫回去，約 10 秒後才呼叫 SubagentHandback
  applyRecord(state, endTurnRecord(2));
  assert.equal(getSubAgentStatus(state, baseMs + 3_000).isDone, false);
  applyRecord(state, toolUseRecord(12, 't2', 'SubagentHandback', { message: 'report' }));
  assert.deepEqual(getSubAgentStatus(state, baseMs + 13_000), { isDone: true, isWaiting: false, reason: 'handback', atMs: baseMs + 12_000 });
});

test('a background sub agent that only stops at end_turn still finishes through the task notification', () => {
  const state = freshState();
  applyMeta(state, { agentType: 'general-purpose', requestShape: 'background' });
  applyRecord(state, endTurnRecord(2));
  assert.equal(getSubAgentStatus(state, baseMs + 3_000).isDone, false);
  applyNotification(state, { agentId: 'a1', status: 'completed', timestampMs: baseMs + 4_000 });
  assert.equal(getSubAgentStatus(state, baseMs + 5_000).reason, 'completed');
});

test('fork and foreground sub agents still finish at end_turn', () => {
  const fork = freshState();
  applyMeta(fork, { agentType: 'fork', isFork: true, requestShape: 'background' });
  applyRecord(fork, endTurnRecord(2));
  assert.equal(getSubAgentStatus(fork, baseMs + 3_000).reason, 'end_turn');

  const foreground = freshState();
  applyMeta(foreground, { agentType: 'general-purpose', requestShape: 'foreground' });
  applyRecord(foreground, endTurnRecord(2));
  assert.equal(getSubAgentStatus(foreground, baseMs + 3_000).reason, 'end_turn');
});

test('meta read after the transcript still decides whether end_turn counts', () => {
  const state = freshState();
  applyRecord(state, endTurnRecord(2));
  assert.equal(getSubAgentStatus(state, baseMs + 3_000).reason, 'end_turn');
  applyMeta(state, { agentType: 'general-purpose', requestShape: 'background' });
  assert.equal(getSubAgentStatus(state, baseMs + 3_000).isDone, false);
});

test('meta agentType and description are stored without escapes or control characters', () => {
  const state = freshState();
  applyMeta(state, { agentType: 'Exp\u001b]8;;https://evil.example/\u001b\\click\u001b]8;;\u001b\\', description: 'X\u001b]52;c;cHduZWQ=\u0007Y \u009b31m‮evil\nline' });
  assert.equal(state.agentType, 'Exp click');
  assert.equal(state.description, 'X Y 31mevil line');
  applyMeta(state, { agentType: '\u001b[2J' });
  assert.equal(state.agentType, null);
});

// ── sub 自己的背景工作（格式照實測：Bash run_in_background、背景 Agent、三種完成紀錄） ──

function backgroundShellLaunch(offsetSeconds, taskId) {
  return {
    type: 'user',
    timestamp: at(offsetSeconds),
    message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/claude-1/-p/s/tasks/${taskId}.output` }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
  };
}

function settledNotification(offsetSeconds, taskId) {
  return {
    type: 'user',
    timestamp: at(offsetSeconds),
    origin: { kind: 'task-notification', producer: 'session-task' },
    message: { content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` },
  };
}

function textRecord(offsetSeconds, stopReason = 'end_turn') {
  return { type: 'assistant', timestamp: at(offsetSeconds), message: { content: [{ type: 'text', text: 'waiting' }], stop_reason: stopReason } };
}

function backgroundState() {
  const state = freshState();
  applyMeta(state, { agentType: 'general-purpose', requestShape: 'background' });
  return state;
}

const unknownTaskEnd = { getTaskEndMs: () => null };

test('a sub agent waiting on its own background shell is waiting, even after the interim completed notification', () => {
  const state = backgroundState();
  applyRecord(state, toolUseRecord(1, 't1', 'Bash', { command: 'sleep 30', run_in_background: true }));
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, textRecord(3));
  applyNotification(state, { agentId: 'a1', status: 'completed', timestampMs: baseMs + 5_000 });
  assert.deepEqual(getSubAgentStatus(state, baseMs + 10_000, unknownTaskEnd), { isDone: false, isWaiting: true, reason: null, atMs: baseMs + 5_000 });
  // sleep 結束 → sub 被叫醒 → handback
  applyRecord(state, settledNotification(33, 'b1'));
  assert.equal(getSubAgentStatus(state, baseMs + 34_000, unknownTaskEnd).isWaiting, true, 'not resumed yet, still within the grace period');
  applyRecord(state, toolUseRecord(35, 't2', 'SubagentHandback'));
  assert.deepEqual(getSubAgentStatus(state, baseMs + 36_000, unknownTaskEnd), { isDone: true, isWaiting: false, reason: 'handback', atMs: baseMs + 35_000 });
});

test('a SubagentHandback sent before waiting on background work does not end the sub agent', () => {
  const state = backgroundState();
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, toolUseRecord(4, 't1', 'SubagentHandback'));
  assert.equal(getSubAgentStatus(state, baseMs + 10_000, unknownTaskEnd).isWaiting, true);
  // 背景工作結束後 sub 回來，這一輪只以 end_turn 結束，再由 main transcript 的通知收尾
  applyRecord(state, settledNotification(27, 'b1'));
  applyRecord(state, textRecord(29));
  assert.equal(getSubAgentStatus(state, baseMs + 29_500, unknownTaskEnd).isDone, false);
  applyNotification(state, { agentId: 'a1', status: 'completed', timestampMs: baseMs + 30_000 });
  assert.deepEqual(getSubAgentStatus(state, baseMs + 31_000, unknownTaskEnd), { isDone: true, isWaiting: false, reason: 'completed', atMs: baseMs + 30_000 });
});

test('a sub agent whose background work ended but which never came back is done after the grace period', () => {
  const state = backgroundState();
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, textRecord(3));
  // 等待中被停掉：沒有任何結束紀錄，只有輸出檔結尾寫上 [killed]
  const killedAt = { getTaskEndMs: (task) => (task.taskId === 'b1' ? baseMs + 20_000 : null) };
  assert.equal(getSubAgentStatus(state, baseMs + 20_000 + resumeGraceMs - 1, killedAt).isWaiting, true);
  assert.deepEqual(getSubAgentStatus(state, baseMs + 20_000 + resumeGraceMs, killedAt), { isDone: true, isWaiting: false, reason: 'not_resumed', atMs: baseMs + 20_000 });
});

test('a killed notification ends a sub agent even while it waits on background work', () => {
  const state = backgroundState();
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, textRecord(3));
  applyNotification(state, { agentId: 'a1', status: 'killed', timestampMs: baseMs + 8_000 });
  assert.deepEqual(getSubAgentStatus(state, baseMs + 9_000, unknownTaskEnd), { isDone: true, isWaiting: false, reason: 'killed', atMs: baseMs + 8_000 });
});

test('background work whose end cannot be read keeps the sub agent waiting, not done, past the stale threshold', () => {
  const state = backgroundState();
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, textRecord(3));
  assert.equal(getSubAgentStatus(state, baseMs + staleAfterMs * 3, unknownTaskEnd).isWaiting, true);
});

test('a background sub agent whose own background work already ended keeps the old end_turn rule', () => {
  const state = backgroundState();
  applyRecord(state, backgroundShellLaunch(2, 'b1'));
  applyRecord(state, settledNotification(5, 'b1'));
  applyRecord(state, toolUseRecord(6, 't1', 'Read', { file_path: '/x' }));
  // 中途 end_turn（之後會被叫回去補 handback）：不能閃一下 ✓
  applyRecord(state, textRecord(8));
  assert.deepEqual(getSubAgentStatus(state, baseMs + 9_000, unknownTaskEnd), { isDone: false, isWaiting: false, reason: null, atMs: null });
});

test('a background Agent counts as the sub agent own background work', () => {
  const state = backgroundState();
  applyRecord(state, {
    type: 'user',
    timestamp: at(2),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_n', content: 'Async agent launched successfully.' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'nested1', description: 'nested probe' },
  });
  applyRecord(state, textRecord(3));
  assert.equal(getSubAgentStatus(state, baseMs + 4_000, unknownTaskEnd).isWaiting, true);
  assert.deepEqual([...state.ownTasks.values()].map((task) => `${task.kind}:${task.taskId}`), ['agent:nested1']);
});
