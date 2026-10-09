import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { getSubAgentStatus } from '../lib/subagent-state.mjs';
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
  assert.equal(explore.events[3].summary, 'git status --short ls src');

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
    fs.writeFileSync(path.join(subagentsDirectory, 'agent-f666watch.jsonl'), `${assistantLine('f666watch', '2026-10-10T01:11:00.000Z', { type: 'thinking', thinking: 'x' })}\n`);
    await waitFor(() => watcher.getSubAgents().length === 5);
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
