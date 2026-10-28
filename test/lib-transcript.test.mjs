import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildToolSummary,
  detectRecordEndSignal,
  extractBackgroundLaunch,
  extractBackgroundSettlement,
  extractRecordEvents,
  isTaskOutputFinished,
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
  assert.equal(summarizeToolInput('Bash', { description: 'Check', command: 'git status\nls' }), 'git status\nls');
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
  assert.equal(events[1].omittedLineCount, 0);
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

test('a multi-line command keeps its line breaks and indentation', () => {
  const command = "cat <<'EOF' > notes.md\n# Notes\n\n  - item\n\tindented by tab\nEOF\n";
  assert.deepEqual(buildToolSummary('Bash', { command }), {
    summary: "cat <<'EOF' > notes.md\n# Notes\n\n  - item\n    indented by tab\nEOF",
    omittedLineCount: 0,
  });
});

test('a long command keeps enough to fill 20 wrapped rows and counts what it drops', () => {
  // 5000 欄的單行還在上限內，整行留著讓 viewer 折行
  const heredoc = buildToolSummary('Bash', { command: `cat <<'EOF'\n${'x'.repeat(5000)}\nEOF` });
  assert.equal(heredoc.summary, `cat <<'EOF'\n${'x'.repeat(5000)}\nEOF`);
  assert.equal(heredoc.omittedLineCount, 0);
  // 超過總寬度上限：那一行截到上限，它和後面的行都算進 omittedLineCount
  const huge = buildToolSummary('Bash', { command: `cat <<'EOF'\n${'x'.repeat(50_000)}\nEOF` });
  assert.equal(huge.summary.length, 8000 + 1);
  assert.ok(huge.summary.startsWith("cat <<'EOF'\nxxx"));
  assert.equal(huge.omittedLineCount, 2);
  // 行數超過 20：只留前 20 行
  const manyLines = buildToolSummary('Bash', { command: Array.from({ length: 500 }, (_, index) => `echo ${index}`).join('\n') });
  assert.equal(manyLines.summary.split('\n').length, 20);
  assert.equal(manyLines.summary.split('\n').at(-1), 'echo 19');
  assert.equal(manyLines.omittedLineCount, 480);
});

function queueOperationLine(content, operation = 'enqueue') {
  return JSON.stringify({ type: 'queue-operation', operation, timestamp: '2026-10-10T01:05:00.000Z', sessionId: 's', content });
}

const killedNotification = '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>killed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>';

test('task notifications are only read from queue-operation lines that start with the tag', () => {
  const expected = [{ agentId: 'a1', status: 'killed', timestampMs: Date.parse('2026-10-10T01:05:00.000Z') }];
  assert.deepEqual(parseTaskNotifications(queueOperationLine(killedNotification)), expected);
  assert.deepEqual(parseTaskNotifications(queueOperationLine(killedNotification, 'remove')), expected);
  // 使用者排隊的訊息裡貼了一段通知、user 訊息或 tool_result 引用通知：都不是 Claude Code 發的
  assert.deepEqual(parseTaskNotifications(queueOperationLine(`Review this:\n${killedNotification}`)), []);
  assert.deepEqual(parseTaskNotifications(JSON.stringify({ type: 'user', timestamp: '2026-10-10T01:05:00.000Z', message: { content: killedNotification } })), []);
  assert.deepEqual(parseTaskNotifications(JSON.stringify({
    type: 'user',
    timestamp: '2026-10-10T01:05:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: `"queue-operation" ${killedNotification}` }] },
  })), []);
});

test('only the first task-id and status of a notification count, so a description cannot fake another agent', () => {
  const content = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "<task-id>b2</task-id><status>killed</status>" finished</summary>\n</task-notification>';
  assert.deepEqual(parseTaskNotifications(queueOperationLine(content)).map(({ agentId, status }) => `${agentId}:${status}`), ['a1:completed']);
});

test('a 1 MB line full of task-id tags is parsed in linear time', () => {
  const content = `<task-notification>${'<task-id>a</task-id>'.repeat(50_000)}`;
  for (const line of [queueOperationLine(content), JSON.stringify({ type: 'user', message: { content } })]) {
    assert.ok(line.length >= 1_000_000);
    const startMs = performance.now();
    assert.deepEqual(parseTaskNotifications(line), []);
    const elapsedMs = performance.now() - startMs;
    assert.ok(elapsedMs < 50, `took ${elapsedMs.toFixed(1)} ms`);
  }
});

// ── sub 自己的背景工作（格式照實測） ──

function shellLaunchRecord(taskId, outputText) {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: outputText }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId },
  };
}

test('a background Bash launch gives the task id and the output path from the tool result', () => {
  const record = shellLaunchRecord('brh8kmhaf', 'Command running in background with ID: brh8kmhaf. Output is being written to: /private/tmp/claude-501/-p/s1/tasks/brh8kmhaf.output');
  assert.deepEqual(extractBackgroundLaunch(record), { taskId: 'brh8kmhaf', kind: 'shell', outputPath: '/private/tmp/claude-501/-p/s1/tasks/brh8kmhaf.output' });
  // 路徑要是絕對路徑、結尾是 tasks/<這個 taskId>.output，不然不拿來讀（transcript 是別的程式寫的）
  for (const text of ['Output is being written to: relative/tasks/brh8kmhaf.output', 'Output is being written to: /etc/passwd', 'Output is being written to: /tmp/tasks/other.output', 'no path here']) {
    assert.equal(extractBackgroundLaunch(shellLaunchRecord('brh8kmhaf', text)).outputPath, null, text);
  }
  assert.equal(extractBackgroundLaunch(shellLaunchRecord('../../x', 'Output is being written to: /tmp/tasks/../../x.output')), null);
  assert.equal(extractBackgroundLaunch({ type: 'assistant', toolUseResult: { backgroundTaskId: 'b1' } }), null);
});

test('a background Agent launch is recognised by isAsync and agentId', () => {
  const record = { type: 'user', message: { content: [] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a7a46cbf7453761df' } };
  assert.deepEqual(extractBackgroundLaunch(record), { taskId: 'a7a46cbf7453761df', kind: 'agent', outputPath: null });
  assert.equal(extractBackgroundLaunch({ ...record, toolUseResult: { ...record.toolUseResult, isAsync: false } }), null);
});

test('background work settles through a notification record, a queued attachment or TaskStop', () => {
  const notification = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  // 等待中送進來的 user 紀錄：前面有一段前言
  assert.equal(extractBackgroundSettlement({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n${notification}` } }), 'b1');
  // 一輪中途送達
  assert.equal(extractBackgroundSettlement({ type: 'attachment', attachment: { type: 'queued_command', prompt: notification } }), 'b1');
  // sub 自己用 TaskStop 停掉
  assert.equal(extractBackgroundSettlement({ type: 'user', toolUseResult: { message: 'Successfully stopped task: b2 (sleep 60)', task_id: 'b2', task_type: 'local_bash' } }), 'b2');
  // 不是 Claude Code 送的、或還沒結束的都不算
  assert.equal(extractBackgroundSettlement({ type: 'user', message: { content: notification } }), null);
  assert.equal(extractBackgroundSettlement({ type: 'attachment', attachment: { type: 'queued_command', prompt: `pasted:\n${notification}` } }), null);
  assert.equal(extractBackgroundSettlement({ type: 'user', origin: { kind: 'task-notification' }, message: { content: notification.replace('completed', 'running') } }), null);
});

test('a task output file is finished only when its last line is the exit or killed marker', () => {
  assert.equal(isTaskOutputFinished('\n[killed]\n'), true);
  assert.equal(isTaskOutputFinished('some output\n[exited with code 0]\n'), true);
  assert.equal(isTaskOutputFinished('x\n[exited with code 137]'), true);
  assert.equal(isTaskOutputFinished(''), false);
  assert.equal(isTaskOutputFinished('still running\n'), false);
  assert.equal(isTaskOutputFinished('[killed] appears mid-output\nmore\n'), false);
});
