import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { getSubAgentStatus, staleAfterMs } from '../lib/subagent-state.mjs';
import { createSessionWatcher, getSessionPaths } from '../lib/watcher.mjs';

const fixtureProjectDirectory = fileURLToPath(new URL('./fixtures/viewer/projects/-tmp-demo-project', import.meta.url));
const fixtureSessionId = '11111111-2222-4333-8444-555555555555';
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-watcher-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

let copyCounter = 0;

function copyFixtureSession() {
  copyCounter += 1;
  const projectDirectory = path.join(temporaryRoot, `copy-${copyCounter}`, '-tmp-demo-project');
  fs.cpSync(fixtureProjectDirectory, projectDirectory, { recursive: true });
  return path.join(projectDirectory, `${fixtureSessionId}.jsonl`);
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startMs > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}

function assistantLine(agentId, timestamp, part, stopReason = null) {
  return JSON.stringify({ type: 'assistant', agentId, timestamp, message: { content: [part], stop_reason: stopReason } });
}

test('getSessionPaths points at <session-id>/subagents next to the transcript', () => {
  const paths = getSessionPaths('/x/projects/-p/abc.jsonl');
  assert.equal(paths.sessionId, 'abc');
  assert.equal(paths.subagentsDirectory, '/x/projects/-p/abc/subagents');
});

test('the fixture session loads every sub agent with meta, events and end state', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const subAgents = watcher.getSubAgents();
  assert.deepEqual(subAgents.map((subAgent) => subAgent.agentId), ['a111explore', 'b222readme', 'c333tests', 'd444fork']);

  const [explore, readme, tests, fork] = subAgents;
  assert.equal(explore.agentType, 'Explore');
  assert.equal(explore.description, 'Find key handling code');
  // 壞掉的那一行被跳過，其他事件照常讀到
  assert.deepEqual(explore.events.map((event) => event.tool), ['thinking...', 'Grep', 'Read', 'Bash']);
  assert.equal(explore.events[3].summary, 'git status --short\nls src');

  const nowMs = Date.now();
  assert.equal(getSubAgentStatus(explore, nowMs).isDone, false);
  assert.equal(getSubAgentStatus(readme, nowMs).isDone, true);
  assert.equal(getSubAgentStatus(tests, nowMs).reason, 'killed');
  assert.equal(getSubAgentStatus(fork, nowMs).reason, 'end_turn');
  assert.deepEqual(fork.events.map((event) => `${event.tool}|${event.summary}`), [
    'Agent|Nested helper',
    'mcp__docs__search|popup placement',
  ]);
});

test('appended lines are read incrementally, including a line split across writes', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const agentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-a111explore.jsonl');
  const line = assistantLine('a111explore', '2026-10-10T01:00:20.000Z', { type: 'tool_use', id: 'toolu_new', name: 'Grep', input: { pattern: 'resize' } });
  fs.appendFileSync(agentPath, line.slice(0, 30));
  watcher.refresh();
  assert.equal(watcher.getSubAgents()[0].events.length, 4);
  fs.appendFileSync(agentPath, `${line.slice(30)}\n`);
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  assert.equal(explore.events.length, 5);
  assert.equal(explore.events[4].summary, 'resize');
});

test('a new agent-*.jsonl file adds a sub agent on the next refresh', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  assert.equal(watcher.getSubAgents().length, 4);
  const subagentsDirectory = getSessionPaths(transcriptPath).subagentsDirectory;
  fs.writeFileSync(path.join(subagentsDirectory, 'agent-e555late.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan next step' }));
  fs.writeFileSync(path.join(subagentsDirectory, 'agent-e555late.jsonl'), `${assistantLine('e555late', '2026-10-10T01:10:00.000Z', { type: 'thinking', thinking: 'x' })}\n`);
  assert.equal(watcher.refresh(), true);
  const subAgents = watcher.getSubAgents();
  assert.equal(subAgents.length, 5);
  assert.equal(subAgents[4].agentType, 'Plan');
});

test('fs.watch picks up a new sub agent without waiting for the poll interval', async () => {
  const transcriptPath = copyFixtureSession();
  let changeCount = 0;
  const watcher = createSessionWatcher({ transcriptPath, pollIntervalMs: 60_000, onChange: () => {
    changeCount += 1;
  } });
  watcher.start();
  try {
    const subagentsDirectory = getSessionPaths(transcriptPath).subagentsDirectory;
    const agentPath = path.join(subagentsDirectory, 'agent-f666watch.jsonl');
    fs.writeFileSync(agentPath, `${assistantLine('f666watch', '2026-10-10T01:11:00.000Z', { type: 'thinking', thinking: 'x' })}\n`);
    // macOS 的 fs.watch（FSEvents）剛建立時，很忙的話會漏掉緊接著的事件（整套測試一起跑時偶爾發生，單跑不會）；
    // 正式執行時由 polling 補上，這裡 polling 設成 60 秒，所以每 500 ms 再 touch 一次，測的仍然是 fs.watch
    const retouchTimer = setInterval(() => {
      const nowSeconds = Date.now() / 1000;
      fs.utimesSync(agentPath, nowSeconds, nowSeconds);
    }, 500);
    try {
      await waitFor(() => watcher.getSubAgents().length === 5);
    } finally {
      clearInterval(retouchTimer);
    }
    assert.ok(changeCount >= 1);
  } finally {
    watcher.stop();
  }
});

test('a missing session folder is not an error and fills in once it appears', () => {
  const projectDirectory = path.join(temporaryRoot, 'empty-project');
  fs.mkdirSync(projectDirectory, { recursive: true });
  const transcriptPath = path.join(projectDirectory, 'aaaa0000-0000-4000-8000-000000000000.jsonl');
  const watcher = createSessionWatcher({ transcriptPath });
  assert.equal(watcher.refresh(), false);
  assert.deepEqual(watcher.getSubAgents(), []);
  const subagentsDirectory = getSessionPaths(transcriptPath).subagentsDirectory;
  fs.mkdirSync(subagentsDirectory, { recursive: true });
  fs.writeFileSync(path.join(subagentsDirectory, 'agent-a1.jsonl'), 'garbage line\n');
  watcher.refresh();
  assert.equal(watcher.getSubAgents().length, 1);
  assert.equal(watcher.getSubAgents()[0].agentType, null);
});

test('a kill notification arriving after the sub agent was loaded marks it done', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  assert.equal(getSubAgentStatus(explore, Date.now()).isDone, false);
  const notification = {
    type: 'queue-operation',
    timestamp: '2026-10-10T01:20:00.000Z',
    content: '<task-notification>\n<task-id>a111explore</task-id>\n<status>failed</status>\n</task-notification>',
  };
  fs.appendFileSync(transcriptPath, `${JSON.stringify(notification)}\n`);
  watcher.refresh();
  assert.equal(getSubAgentStatus(explore, Date.now()).reason, 'failed');
});

function toolUseLine(agentId, offsetSeconds, toolUseId, command) {
  const timestamp = new Date(Date.parse('2026-10-10T01:00:00.000Z') + offsetSeconds * 1000).toISOString();
  return `${assistantLine(agentId, timestamp, { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } })}\n`;
}

test('a sub agent transcript that gets truncated and rewritten is read again from the start', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const agentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-a111explore.jsonl');
  assert.equal(watcher.getSubAgents()[0].events.length, 4);
  fs.writeFileSync(agentPath, toolUseLine('a111explore', 1, 'toolu_rewritten', 'echo rewritten'));
  assert.equal(watcher.refresh(), true);
  const explore = watcher.getSubAgents().find((subAgent) => subAgent.agentId === 'a111explore');
  assert.deepEqual(explore.events.map((event) => event.summary), ['echo rewritten']);
  fs.appendFileSync(agentPath, toolUseLine('a111explore', 2, 'toolu_after', 'echo after'));
  watcher.refresh();
  assert.deepEqual(explore.events.map((event) => event.summary), ['echo rewritten', 'echo after']);
});

test('a truncated main transcript is read again and its notifications still apply', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  const notification = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-10-10T01:20:00.000Z',
    content: '<task-notification>\n<task-id>a111explore</task-id>\n<status>killed</status>\n</task-notification>',
  });
  fs.writeFileSync(transcriptPath, `${notification}\n`);
  watcher.refresh();
  assert.equal(getSubAgentStatus(explore, Date.now()).reason, 'killed');
});

test('reading in small chunks keeps lines and multi-byte characters that span chunk boundaries', () => {
  const transcriptPath = copyFixtureSession();
  const agentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-a111explore.jsonl');
  fs.appendFileSync(agentPath, toolUseLine('a111explore', 30, 'toolu_cjk', '刪除暫存檔 ✅ 🚀 完成'));
  const watcher = createSessionWatcher({ transcriptPath, readChunkBytes: 7 });
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  assert.deepEqual(explore.events.map((event) => event.tool), ['thinking...', 'Grep', 'Read', 'Bash', 'Bash']);
  assert.equal(explore.events.at(-1).summary, '刪除暫存檔 ✅ 🚀 完成');
});

test('a line longer than the limit is skipped without breaking the lines after it', () => {
  const transcriptPath = copyFixtureSession();
  const agentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-a111explore.jsonl');
  fs.appendFileSync(agentPath, toolUseLine('a111explore', 30, 'toolu_huge', 'x'.repeat(5000)));
  fs.appendFileSync(agentPath, toolUseLine('a111explore', 31, 'toolu_next', 'echo next'));
  const watcher = createSessionWatcher({ transcriptPath, readChunkBytes: 256, maximumLineLength: 1024 });
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  assert.deepEqual(explore.events.map((event) => event.summary).slice(-2), ['git status --short\nls src', 'echo next']);
});

test('main transcript lines that only quote a task notification do not end a sub agent', () => {
  const transcriptPath = copyFixtureSession();
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const explore = watcher.getSubAgents()[0];
  const quoted = '<task-notification>\n<task-id>a111explore</task-id>\n<status>killed</status>\n</task-notification>';
  fs.appendFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', timestamp: '2026-10-10T01:20:00.000Z', message: { content: quoted } }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-10T01:20:01.000Z', content: `Look at this:\n${quoted}` }),
    '',
  ].join('\n'));
  watcher.refresh();
  assert.equal(getSubAgentStatus(explore, Date.now()).isDone, false);
});

// ── sub 自己的背景工作：watcher 讀輸出檔結尾、巢狀 Agent 看它自己的狀態 ──

function createBackgroundSession() {
  copyCounter += 1;
  const projectDirectory = path.join(temporaryRoot, `background-${copyCounter}`, '-tmp-demo-project');
  const sessionId = 'bbbb0000-0000-4000-8000-000000000000';
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  const subagentsDirectory = path.join(projectDirectory, sessionId, 'subagents');
  const tasksDirectory = path.join(temporaryRoot, `background-${copyCounter}`, 'tmp', sessionId, 'tasks');
  fs.mkdirSync(subagentsDirectory, { recursive: true });
  fs.mkdirSync(tasksDirectory, { recursive: true });
  fs.writeFileSync(transcriptPath, '');
  const writeSubAgent = (agentId, records) => {
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: agentId, requestShape: 'background' }));
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${agentId}.jsonl`), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  };
  return { transcriptPath, tasksDirectory, writeSubAgent };
}

function shellLaunch(timestamp, taskId, outputPath) {
  return {
    type: 'user',
    timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}` }] },
    toolUseResult: { stdout: '', stderr: '', backgroundTaskId: taskId },
  };
}

const waitingText = (timestamp) => assistantLine('x', timestamp, { type: 'text', text: 'waiting for the background task' }, 'end_turn');

test('a sub agent waiting on a background shell becomes done once the output file shows killed and it does not come back', () => {
  const { transcriptPath, tasksDirectory, writeSubAgent } = createBackgroundSession();
  const outputPath = path.join(tasksDirectory, 'bzeikx0gq.output');
  fs.writeFileSync(outputPath, '');
  writeSubAgent('probeD', [shellLaunch('2026-10-10T01:00:01.000Z', 'bzeikx0gq', outputPath), JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const [probe] = watcher.getSubAgents();
  const nowMs = Date.now();
  assert.equal(watcher.getStatus(probe, nowMs).isWaiting, true, 'output file still empty: the sleep is running');
  // 等待中被停掉：輸出檔寫上 [killed]，sub 沒有再寫任何東西
  fs.writeFileSync(outputPath, '\n[killed]\n');
  const killedAtSeconds = Date.parse('2026-10-10T01:00:10.000Z') / 1000;
  fs.utimesSync(outputPath, killedAtSeconds, killedAtSeconds);
  assert.equal(watcher.getStatus(probe, killedAtSeconds * 1000 + 1_000).isWaiting, true, 'within the grace period it may still resume');
  assert.deepEqual(watcher.getStatus(probe, killedAtSeconds * 1000 + 31_000), { isDone: true, isWaiting: false, reason: 'not_resumed', atMs: killedAtSeconds * 1000 });
});

test('a sub agent waiting on a background Agent follows the nested sub agent status', () => {
  const { transcriptPath, writeSubAgent } = createBackgroundSession();
  const nestedLaunch = { type: 'user', timestamp: '2026-10-10T01:00:01.000Z', message: { content: [] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'nested1' } };
  writeSubAgent('parent1', [nestedLaunch, JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  writeSubAgent('nested1', [JSON.parse(assistantLine('nested1', '2026-10-10T01:00:03.000Z', { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'echo nested' } }))]);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const byId = new Map(watcher.getSubAgents().map((subAgent) => [subAgent.agentId, subAgent]));
  const nowMs = Date.parse('2026-10-10T01:00:05.000Z');
  assert.equal(watcher.getStatus(byId.get('parent1'), nowMs).isWaiting, true);
  assert.equal(watcher.getStatus(byId.get('nested1'), nowMs).isDone, false);
  // 巢狀 sub 回報結束後，parent 在寬限時間內被叫醒、回報
  const nestedPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-nested1.jsonl');
  fs.appendFileSync(nestedPath, `${assistantLine('nested1', '2026-10-10T01:00:06.000Z', { type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: {} })}\n`);
  watcher.refresh();
  assert.equal(watcher.getStatus(byId.get('parent1'), Date.parse('2026-10-10T01:00:07.000Z')).isWaiting, true);
  const parentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-parent1.jsonl');
  fs.appendFileSync(parentPath, `${assistantLine('parent1', '2026-10-10T01:00:08.000Z', { type: 'tool_use', id: 'toolu_p', name: 'SubagentHandback', input: {} })}\n`);
  watcher.refresh();
  assert.deepEqual(watcher.getStatus(byId.get('parent1'), Date.parse('2026-10-10T01:00:09.000Z')), { isDone: true, isWaiting: false, reason: 'handback', atMs: Date.parse('2026-10-10T01:00:08.000Z') });
});

test('an output path that is a FIFO does not block the viewer and keeps the sub agent waiting', { skip: process.platform === 'win32' }, () => {
  const { transcriptPath, tasksDirectory, writeSubAgent } = createBackgroundSession();
  const outputPath = path.join(tasksDirectory, 'bfifo0001.output');
  const made = spawnSync('mkfifo', [outputPath]);
  assert.equal(made.status, 0, 'mkfifo');
  writeSubAgent('fifo1', [shellLaunch('2026-10-10T01:00:01.000Z', 'bfifo0001', outputPath), JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const [fifo] = watcher.getSubAgents();
  const startMs = Date.now();
  assert.equal(watcher.getStatus(fifo, Date.now()).isWaiting, true);
  // FIFO 不是一般檔案，修改時間不算：只看 sub 自己，超過 stale 上限就結束
  assert.equal(watcher.getStatus(fifo, Date.now() + 3_600_000).reason, 'waiting_stale');
  assert.ok(Date.now() - startMs < 1000);
});

function setModifiedMs(filePath, modifiedMs) {
  fs.utimesSync(filePath, modifiedMs / 1000, modifiedMs / 1000);
}

test('a background shell killed without an end marker stops showing waiting once nothing changes for the stale threshold', () => {
  const { transcriptPath, tasksDirectory, writeSubAgent } = createBackgroundSession();
  const outputPath = path.join(tasksDirectory, 'bnomark01.output');
  // 實測：關掉 Claude Code 時被殺的背景 shell，輸出檔停在最後一行 log，沒有 [exited with code N]／[killed]
  fs.writeFileSync(outputPath, 'listening on :5173\n');
  writeSubAgent('nomark1', [shellLaunch('2026-10-10T01:00:01.000Z', 'bnomark01', outputPath), JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  const subAgentPath = path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-nomark1.jsonl');
  const lastChangeMs = Date.parse('2026-10-10T01:00:02.000Z');
  setModifiedMs(subAgentPath, lastChangeMs);
  const outputWrittenMs = Date.parse('2026-10-10T01:05:00.000Z');
  setModifiedMs(outputPath, outputWrittenMs);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const [probe] = watcher.getSubAgents();
  assert.equal(watcher.getStatus(probe, outputWrittenMs + staleAfterMs).isWaiting, true, 'the output file was written within the threshold');
  assert.deepEqual(watcher.getStatus(probe, outputWrittenMs + staleAfterMs + 1), { isDone: true, isWaiting: false, reason: 'waiting_stale', atMs: outputWrittenMs });
});

test('a background shell whose output file is missing stops showing waiting once the sub agent is unchanged for the stale threshold', () => {
  const { transcriptPath, tasksDirectory, writeSubAgent } = createBackgroundSession();
  const outputPath = path.join(tasksDirectory, 'bmissing1.output');
  writeSubAgent('missing1', [shellLaunch('2026-10-10T01:00:01.000Z', 'bmissing1', outputPath), JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  const lastChangeMs = Date.parse('2026-10-10T01:00:02.000Z');
  setModifiedMs(path.join(getSessionPaths(transcriptPath).subagentsDirectory, 'agent-missing1.jsonl'), lastChangeMs);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const [probe] = watcher.getSubAgents();
  assert.equal(watcher.getStatus(probe, lastChangeMs + staleAfterMs).isWaiting, true);
  assert.deepEqual(watcher.getStatus(probe, lastChangeMs + staleAfterMs + 1), { isDone: true, isWaiting: false, reason: 'waiting_stale', atMs: lastChangeMs });
});

test('a sub agent waiting on a background Agent stays waiting past the stale threshold while the nested sub agent is not done', () => {
  const { transcriptPath, writeSubAgent } = createBackgroundSession();
  const nestedLaunch = { type: 'user', timestamp: '2026-10-10T01:00:01.000Z', message: { content: [] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'nested2' } };
  writeSubAgent('parent2', [nestedLaunch, JSON.parse(waitingText('2026-10-10T01:00:02.000Z'))]);
  writeSubAgent('nested2', [JSON.parse(assistantLine('nested2', '2026-10-10T01:20:00.000Z', { type: 'tool_use', id: 'toolu_n2', name: 'Bash', input: { command: 'echo nested' } }))]);
  const { subagentsDirectory } = getSessionPaths(transcriptPath);
  setModifiedMs(path.join(subagentsDirectory, 'agent-parent2.jsonl'), Date.parse('2026-10-10T01:00:02.000Z'));
  const nestedWrittenMs = Date.parse('2026-10-10T01:20:00.000Z');
  setModifiedMs(path.join(subagentsDirectory, 'agent-nested2.jsonl'), nestedWrittenMs);
  const watcher = createSessionWatcher({ transcriptPath });
  watcher.refresh();
  const byId = new Map(watcher.getSubAgents().map((subAgent) => [subAgent.agentId, subAgent]));
  assert.equal(watcher.getStatus(byId.get('parent2'), nestedWrittenMs + 60_000).isWaiting, true);
  // 巢狀 sub 自己 10 分鐘沒寫入 → 它結束 → parent 走原本的寬限時間
  const nestedStaleMs = nestedWrittenMs + staleAfterMs + 1;
  assert.equal(watcher.getStatus(byId.get('nested2'), nestedStaleMs).reason, 'stale');
  assert.equal(watcher.getStatus(byId.get('parent2'), nestedStaleMs).reason, 'not_resumed');
});
