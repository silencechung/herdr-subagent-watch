import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMeta,
  applyNotification,
  applyRecord,
  createSubAgentState,
  getSubAgentStatus,
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
  assert.deepEqual(status, { isDone: true, reason: 'handback', atMs: baseMs + 2_000 });
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
  assert.deepEqual(getSubAgentStatus(state, baseMs + 61_000), { isDone: true, reason: 'killed', atMs: baseMs + 60_000 });
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
  assert.deepEqual(getSubAgentStatus(state, baseMs + staleAfterMs + 1), { isDone: true, reason: 'stale', atMs: baseMs });
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
  assert.deepEqual(getSubAgentStatus(state, baseMs + 13_000), { isDone: true, reason: 'handback', atMs: baseMs + 12_000 });
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
  assert.equal(state.description, 'X Y evil line');
  applyMeta(state, { agentType: '\u001b[2J' });
  assert.equal(state.agentType, null);
});
