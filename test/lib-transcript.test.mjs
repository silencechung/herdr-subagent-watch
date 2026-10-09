import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectRecordEndSignal,
  extractRecordEvents,
  parseJsonLine,
  parseTaskNotifications,
  splitCompleteLines,
  summarizeToolInput,
  thinkingLabel,
} from '../lib/transcript.mjs';

function assistantRecord(parts, extra = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-10-10T01:00:00.000Z',
    message: { role: 'assistant', content: parts, stop_reason: null, ...extra },
  };
}

test('parseJsonLine skips broken, empty and non-object lines instead of throwing', () => {
  assert.equal(parseJsonLine('{"type":"assistant","message":'), null);
  assert.equal(parseJsonLine(''), null);
  assert.equal(parseJsonLine('   '), null);
  assert.equal(parseJsonLine('[1,2]'), null);
  assert.equal(parseJsonLine('"text"'), null);
  assert.equal(parseJsonLine('null'), null);
  assert.deepEqual(parseJsonLine('{"type":"user"}'), { type: 'user' });
});

test('splitCompleteLines holds back a partial last line until its newline arrives', () => {
  const first = splitCompleteLines('', '{"a":1}\n{"b":');
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.pendingText, '{"b":');
  const second = splitCompleteLines(first.pendingText, '2}\n');
  assert.deepEqual(second.lines, ['{"b":2}']);
  assert.equal(second.pendingText, '');
});

test('summarizeToolInput picks the documented field for each tool', () => {
  assert.equal(summarizeToolInput('Bash', { description: 'Check', command: 'git status\nls' }), 'git status ls');
  assert.equal(summarizeToolInput('Read', { limit: 10, file_path: '/tmp/a.mjs' }), '/tmp/a.mjs');
  assert.equal(summarizeToolInput('Edit', { old_string: 'x', file_path: '/tmp/b.mjs' }), '/tmp/b.mjs');
  assert.equal(summarizeToolInput('Write', { content: 'body', file_path: '/tmp/c.md' }), '/tmp/c.md');
  assert.equal(summarizeToolInput('Grep', { path: 'src/', pattern: 'emitKeypressEvents' }), 'emitKeypressEvents');
  assert.equal(summarizeToolInput('WebFetch', { prompt: 'summarize', url: 'https://herdr.dev' }), 'https://herdr.dev');
  assert.equal(summarizeToolInput('Agent', { prompt: 'long prompt', description: 'Nested helper' }), 'Nested helper');
});

test('summarizeToolInput falls back to the first non-empty string field', () => {
  assert.equal(summarizeToolInput('mcp__docs__search', { limit: 3, query: 'popup placement' }), 'popup placement');
  assert.equal(summarizeToolInput('Glob', { pattern: '**/*.mjs' }), '**/*.mjs');
  assert.equal(summarizeToolInput('Bash', { timeout: 5 }), '');
  assert.equal(summarizeToolInput('Read', null), '');
  assert.equal(summarizeToolInput('TodoWrite', { todos: [{ content: 'x' }] }), '');
});

test('extractRecordEvents returns tool_use and thinking from assistant records only', () => {
  const events = extractRecordEvents(assistantRecord([
    { type: 'thinking', thinking: 'hmm', signature: 's' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', text: 'not shown' },
  ]));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: 'thinking', toolUseId: null, timestampMs: Date.parse('2026-10-10T01:00:00.000Z'), tool: thinkingLabel, summary: '' });
  assert.equal(events[1].tool, 'Bash');
  assert.equal(events[1].summary, 'ls');
  assert.equal(events[1].toolUseId, 'toolu_1');

  const toolResult = {
    type: 'user',
    timestamp: '2026-10-10T01:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'secret output' }] },
  };
  assert.deepEqual(extractRecordEvents(toolResult), []);
});

test('extractRecordEvents tolerates missing or malformed fields', () => {
  assert.deepEqual(extractRecordEvents({ type: 'assistant' }), []);
  assert.deepEqual(extractRecordEvents({ type: 'assistant', message: { content: 'plain string' } }), []);
  const events = extractRecordEvents({ type: 'assistant', timestamp: 'not a date', message: { content: [null, { type: 'tool_use' }] } });
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, 'tool');
  assert.equal(events[0].timestampMs, null);
});

test('detectRecordEndSignal recognises SubagentHandback and end_turn', () => {
  assert.equal(detectRecordEndSignal(assistantRecord([{ type: 'tool_use', id: 't', name: 'SubagentHandback', input: { message: 'done' } }])), 'handback');
  assert.equal(detectRecordEndSignal(assistantRecord([{ type: 'text', text: 'Summary' }], { stop_reason: 'end_turn' })), 'end_turn');
  assert.equal(detectRecordEndSignal(assistantRecord([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], { stop_reason: 'tool_use' })), null);
  assert.equal(detectRecordEndSignal({ type: 'user', message: { stop_reason: 'end_turn' } }), null);
});

test('parseTaskNotifications reads agent id and terminal status from the main transcript', () => {
  const line = JSON.stringify({
    type: 'queue-operation',
    timestamp: '2026-10-10T01:05:00.000Z',
    content: '<task-notification>\n<task-id>a8f5a6943f9a33732</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>killed</status>\n</task-notification>',
  });
  assert.deepEqual(parseTaskNotifications(line), [
    { agentId: 'a8f5a6943f9a33732', status: 'killed', timestampMs: Date.parse('2026-10-10T01:05:00.000Z') },
  ]);
  const running = line.replace('killed', 'running');
  assert.deepEqual(parseTaskNotifications(running), []);
  assert.deepEqual(parseTaskNotifications('{"type":"user"}'), []);
});
