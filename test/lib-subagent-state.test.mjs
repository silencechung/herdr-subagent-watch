import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
