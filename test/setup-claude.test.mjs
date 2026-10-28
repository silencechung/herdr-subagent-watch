import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectJsonIndent,
  findSettingsShapeProblem,
  formatSettings,
  isSidebarHookCommand,
  removeSidebarHooks,
} from '../lib/setup-claude.mjs';

// 舊版 setup 寫進 settings.json 的 hook（側邊欄 hook 已經拿掉，setup／remove 只負責清掉它）
const command = 'sh "/plugins/subagent-watch/bin/run.sh" "/plugins/subagent-watch/hooks/sidebar-hook.mjs"';
const ours = () => ({ hooks: [{ type: 'command', command, timeout: 5 }] });

const otherHooks = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  SubagentStart: [{ matcher: 'Explore', hooks: [{ type: 'command', command: 'log-start.sh', timeout: 3 }] }],
};

function withLegacyHooks(hooks, eventNames = ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure']) {
  const next = structuredClone(hooks);
  for (const eventName of eventNames) {
    next[eventName] = [...(next[eventName] ?? []), ours()];
  }
  return next;
}

test('remove takes out only the old sidebar hooks and drops event arrays that end up empty', () => {
  const installed = { hooks: withLegacyHooks(otherHooks) };
  const { settings: next, changes, removedCount } = removeSidebarHooks(installed);
  assert.equal(removedCount, 5);
  assert.deepEqual(changes, { SubagentStart: 'removed', SubagentStop: 'removed', SessionStart: 'removed', Stop: 'removed', StopFailure: 'removed' });
  assert.deepEqual(next, { hooks: otherHooks });
  assert.deepEqual(installed.hooks, withLegacyHooks(otherHooks), 'input must not be mutated');
});

test('remove drops an empty hooks object it emptied, and is a no-op when nothing is there', () => {
  assert.deepEqual(removeSidebarHooks({ model: 'x', hooks: withLegacyHooks({}) }).settings, { model: 'x' });
  const untouched = { hooks: structuredClone(otherHooks) };
  const result = removeSidebarHooks(untouched);
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.settings, untouched);
});

test('an install from the version before SessionStart (only SubagentStart and SubagentStop) is removed too', () => {
  const userHooks = {
    SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'herdr-agent-state.sh session', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
  };
  const removed = removeSidebarHooks({ hooks: withLegacyHooks(userHooks, ['SubagentStart', 'SubagentStop']) });
  assert.equal(removed.removedCount, 2);
  assert.deepEqual(removed.settings, { hooks: userHooks });
});

test('the hand-written form from before the launcher and duplicates in one group are removed, other hooks in the group stay', () => {
  const oldCommand = '/home/someone/.local/share/fnm/aliases/default/bin/node /old/place/hooks/sidebar-hook.mjs';
  const settings = {
    hooks: {
      SubagentStart: [
        { hooks: [{ type: 'command', command: oldCommand, timeout: 5 }, { type: 'command', command: 'keep-me.sh' }] },
        { hooks: [{ type: 'command', command: oldCommand }] },
      ],
      SubagentStop: [{ hooks: [{ type: 'command', command: oldCommand, timeout: 5 }] }],
    },
  };
  const { settings: next, removedCount } = removeSidebarHooks(settings);
  assert.equal(removedCount, 3);
  assert.deepEqual(next, { hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: 'keep-me.sh' }] }] } });
});

test('the user\'s own StopFailure hook stays when ours is removed', () => {
  const userHooks = { StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: 'alert.sh' }] }] };
  const removed = removeSidebarHooks({ hooks: withLegacyHooks(userHooks) });
  assert.equal(removed.changes.StopFailure, 'removed');
  assert.deepEqual(removed.settings, { hooks: userHooks });
});

test('remove keeps empty arrays and every other hook when nothing of ours is there', () => {
  const settings = { hooks: { SubagentStart: [], SubagentStop: [{ hooks: [{ type: 'command', command: 'node /opt/other-tool/sidebar-hook.mjs' }] }] } };
  const result = removeSidebarHooks(settings);
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.settings, settings);
});

test('only the two command shapes this plugin wrote are recognised as its hook', () => {
  assert.equal(isSidebarHookCommand(command), true);
  assert.equal(isSidebarHookCommand('sh "/elsewhere/plugin/bin/run.sh" "/elsewhere/plugin/hooks/sidebar-hook.mjs"'), true, 'a moved plugin is still ours');
  assert.equal(isSidebarHookCommand('/home/someone/.local/share/fnm/aliases/default/bin/node /old/place/hooks/sidebar-hook.mjs'), true, 'the hand-written form from before the launcher');
  for (const otherCommand of [
    'node /opt/other-tool/sidebar-hook.mjs',
    'node /opt/other-tool/hooks/sidebar-hook.mjs',
    '/usr/bin/node /opt/other-tool/hooks/sidebar-hook.mjs --verbose',
    '/usr/bin/python3 /opt/other-tool/hooks/sidebar-hook.mjs',
    'sh "/opt/a/bin/run.sh" "/opt/b/hooks/sidebar-hook.mjs"',
    'sh "relative/bin/run.sh" "relative/hooks/sidebar-hook.mjs"',
    `${command} && curl example.invalid`,
    'echo sidebar-hook.mjs',
    undefined,
  ]) {
    assert.equal(isSidebarHookCommand(otherCommand), false, String(otherCommand));
  }
});

test('settings with an unexpected shape are reported instead of edited', () => {
  assert.equal(findSettingsShapeProblem({ hooks: {} }), null);
  assert.equal(findSettingsShapeProblem({}), null);
  assert.match(findSettingsShapeProblem([]), /not a JSON object/);
  assert.match(findSettingsShapeProblem({ hooks: [] }), /"hooks" in settings\.json is not an object/);
  for (const eventName of ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure']) {
    assert.match(findSettingsShapeProblem({ hooks: { [eventName]: {} } }), new RegExp(`hooks\\.${eventName}`));
  }
});

test('formatting keeps the original indent and trailing newline', () => {
  assert.equal(detectJsonIndent('{\n    "a": 1\n}\n'), '    ');
  assert.equal(detectJsonIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(formatSettings({ a: 1 }, '{\n    "a": 0\n}'), '{\n    "a": 1\n}');
  assert.equal(formatSettings({ a: 1 }, ''), '{\n  "a": 1\n}\n');
});

test('formatting keeps CRLF line endings and one-line files stay on one line', () => {
  assert.equal(formatSettings({ a: 1, b: [2] }, '{\r\n  "a": 0\r\n}\r\n'), '{\r\n  "a": 1,\r\n  "b": [\r\n    2\r\n  ]\r\n}\r\n');
  assert.equal(formatSettings({ a: 'line\nbreak' }, '{\r\n\t"a": 0\r\n}'), '{\r\n\t"a": "line\\nbreak"\r\n}');
  assert.equal(formatSettings({ a: 1, b: 2 }, '{"a":0}\n'), '{"a":1,"b":2}\n');
  assert.equal(formatSettings({ a: 1 }, '{}\n'), '{\n  "a": 1\n}\n');
});
