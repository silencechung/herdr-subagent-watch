import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHookCommand,
  detectJsonIndent,
  findSettingsShapeProblem,
  formatSettings,
  installSidebarHooks,
  isSidebarHookCommand,
  removeSidebarHooks,
} from '../lib/setup-claude.mjs';

const pluginRoot = '/plugins/subagent-watch';
const command = buildHookCommand(pluginRoot);

const otherHooks = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  SubagentStart: [{ matcher: 'Explore', hooks: [{ type: 'command', command: 'log-start.sh', timeout: 3 }] }],
};

test('the hook command runs the launcher with absolute paths derived from the plugin root', () => {
  assert.equal(command, 'sh "/plugins/subagent-watch/bin/run.sh" "/plugins/subagent-watch/hooks/sidebar-hook.mjs"');
});

test('a plugin path that would break the shell command is refused', () => {
  for (const unsafeRoot of ['/tmp/a"b', '/tmp/$HOME', '/tmp/a`b`', '/tmp/a\\b']) {
    assert.throws(() => buildHookCommand(unsafeRoot), /breaks a shell command/);
  }
});

test('install adds one hook per event and leaves every other hook alone', () => {
  const settings = { model: 'opus', hooks: structuredClone(otherHooks) };
  const { settings: next, changes } = installSidebarHooks(settings, command);
  assert.deepEqual(changes, { SubagentStart: 'added', SubagentStop: 'added' });
  assert.deepEqual(next.hooks.PreToolUse, otherHooks.PreToolUse);
  assert.deepEqual(next.hooks.SubagentStart, [
    otherHooks.SubagentStart[0],
    { hooks: [{ type: 'command', command, timeout: 5 }] },
  ]);
  assert.deepEqual(next.hooks.SubagentStop, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]);
  assert.equal(next.model, 'opus');
  assert.deepEqual(settings.hooks, otherHooks, 'input must not be mutated');
});

test('install is idempotent', () => {
  const once = installSidebarHooks({ hooks: structuredClone(otherHooks) }, command).settings;
  const twice = installSidebarHooks(once, command);
  assert.deepEqual(twice.settings, once);
  assert.deepEqual(twice.changes, { SubagentStart: 'unchanged', SubagentStop: 'unchanged' });
});

test('an older sidebar-hook command is updated in place and duplicates are dropped', () => {
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
  const { settings: next, changes } = installSidebarHooks(settings, command);
  assert.deepEqual(changes, { SubagentStart: 'updated', SubagentStop: 'updated' });
  assert.deepEqual(next.hooks.SubagentStart, [
    { hooks: [{ type: 'command', command, timeout: 5 }, { type: 'command', command: 'keep-me.sh' }] },
  ]);
  assert.deepEqual(next.hooks.SubagentStop, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]);
});

test('remove takes out only the sidebar hooks and drops event arrays that end up empty', () => {
  const installed = installSidebarHooks({ hooks: structuredClone(otherHooks) }, command).settings;
  const { settings: next, changes, removedCount } = removeSidebarHooks(installed);
  assert.equal(removedCount, 2);
  assert.deepEqual(changes, { SubagentStart: 'removed', SubagentStop: 'removed' });
  assert.deepEqual(next, { hooks: otherHooks });
});

test('remove drops an empty hooks object it emptied, and is a no-op when nothing is there', () => {
  const installed = installSidebarHooks({ model: 'x' }, command).settings;
  assert.deepEqual(removeSidebarHooks(installed).settings, { model: 'x' });
  const untouched = { hooks: structuredClone(otherHooks) };
  const result = removeSidebarHooks(untouched);
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.settings, untouched);
});

test('settings with an unexpected shape are reported instead of edited', () => {
  assert.equal(findSettingsShapeProblem({ hooks: {} }), null);
  assert.equal(findSettingsShapeProblem({}), null);
  assert.match(findSettingsShapeProblem([]), /not a JSON object/);
  assert.match(findSettingsShapeProblem({ hooks: [] }), /"hooks" in settings\.json is not an object/);
  assert.match(findSettingsShapeProblem({ hooks: { SubagentStop: {} } }), /hooks\.SubagentStop/);
});

test('formatting keeps the original indent and trailing newline', () => {
  assert.equal(detectJsonIndent('{\n    "a": 1\n}\n'), '    ');
  assert.equal(detectJsonIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(formatSettings({ a: 1 }, '{\n    "a": 0\n}'), '{\n    "a": 1\n}');
  assert.equal(formatSettings({ a: 1 }, ''), '{\n  "a": 1\n}\n');
});

test('only the two command shapes this plugin writes are recognised as its hook', () => {
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

test('remove keeps empty arrays and every other hook when nothing of ours is there', () => {
  const settings = { hooks: { SubagentStart: [], SubagentStop: [{ hooks: [{ type: 'command', command: 'node /opt/other-tool/sidebar-hook.mjs' }] }] } };
  const result = removeSidebarHooks(settings);
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.settings, settings);
});

test('formatting keeps CRLF line endings and one-line files stay on one line', () => {
  assert.equal(formatSettings({ a: 1, b: [2] }, '{\r\n  "a": 0\r\n}\r\n'), '{\r\n  "a": 1,\r\n  "b": [\r\n    2\r\n  ]\r\n}\r\n');
  assert.equal(formatSettings({ a: 'line\nbreak' }, '{\r\n\t"a": 0\r\n}'), '{\r\n\t"a": "line\\nbreak"\r\n}');
  assert.equal(formatSettings({ a: 1, b: 2 }, '{"a":0}\n'), '{"a":1,"b":2}\n');
  assert.equal(formatSettings({ a: 1 }, '{}\n'), '{\n  "a": 1\n}\n');
});
