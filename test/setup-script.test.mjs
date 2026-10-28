import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildKeyBlockLines, markerEnd, markerStart } from '../lib/setup-herdr.mjs';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const launcherPath = path.join(repositoryDirectory, 'bin', 'run.sh');
// macOS 的 os.tmpdir() 在 /var 底下，/var 是指向 /private/var 的 symlink；setup 回報 realpath，所以根目錄一開始就取 realpath
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-setup-')));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

// 舊版 setup 寫進 settings.json 的 hook command（側邊欄 hook 已經拿掉；setup／remove 只負責清掉它）
const legacyCommand = `sh "${repositoryDirectory}/bin/run.sh" "${repositoryDirectory}/hooks/sidebar-hook.mjs"`;
const legacyHook = { type: 'command', command: legacyCommand, timeout: 5 };

const originalSettings = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 10 }] }],
  },
  statusLine: { type: 'command', command: 'status.sh' },
};
const originalSettingsText = `${JSON.stringify(originalSettings, null, 2)}\n`;

// 舊版 setup 的結果：五個 event 各加一筆，使用者原本的 Stop hook 留在前面
function buildLegacySettings(eventNames = ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure']) {
  const settings = structuredClone(originalSettings);
  for (const eventName of eventNames) {
    settings.hooks[eventName] = [...(settings.hooks[eventName] ?? []), { hooks: [legacyHook] }];
  }
  return settings;
}
const legacySettingsText = `${JSON.stringify(buildLegacySettings(), null, 2)}\n`;

const originalConfigText = 'onboarding = false\n\n[ui]\nstatus_indicators = "symbols"\n\n[[keys.command]]\nkey = "prefix+y"\ntype = "popup"\ncommand = "yazi"\n';
const keyBlockText = `${buildKeyBlockLines().join('\n')}\n`;
const markerStartLine = `${markerStart} (added by subagent.watch.setup; subagent.watch.remove deletes this block)`;
const legacyRowsBlockText = `${[
  markerStartLine,
  '[ui.sidebar.agents.rows_by_agent]',
  'claude = [',
  '  ["state_icon", "machine", "workspace", "tab"],',
  '  ["agent"],',
  '  [{ token = "$sub1", bold = true, dim = false }],',
  ']',
  markerEnd,
].join('\n')}\n`;
// 舊版 setup 的結果：快捷鍵與側邊欄 rows 兩個區塊
const legacyConfigText = `${originalConfigText}${keyBlockText}${legacyRowsBlockText}`;
const configWithKeyText = `${originalConfigText}${keyBlockText}`;

// 假 herdr：記錄每次呼叫；config check 依檔案內容決定結果，模擬「改完才壞掉」與「原本就有的問題」
const fakeHerdrSource = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ args, configPath: process.env.HERDR_CONFIG_PATH ?? null }) + '\\n');
if (args[0] === 'config' && args[1] === 'check') {
  const configPath = process.env.HERDR_CONFIG_PATH;
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const problems = [];
  if (text.includes('[[[')) {
    console.log('config: issues found');
    console.log('config parse error: TOML parse error at line 1');
    process.exit(1);
  }
  if (text.includes('bogus_key')) {
    problems.push('unknown config key ui.bogus_key; ignoring key');
  }
  const failOn = process.env.FAKE_HERDR_CHECK_FAIL_ON;
  if (failOn && text.includes(failOn)) {
    problems.push('fake problem caused by ' + failOn);
  }
  if (problems.length > 0) {
    console.log('config: issues found');
    console.log(problems.join('\\n'));
    process.exit(1);
  }
  console.log('config: ok');
  process.exit(0);
}
if (args[0] === 'server' && args[1] === 'reload-config') {
  process.exit(Number(process.env.FAKE_HERDR_RELOAD_STATUS ?? 0));
}
process.exit(0);
`;

let caseCounter = 0;
function createCase({ settingsText = originalSettingsText, configText = originalConfigText } = {}) {
  caseCounter += 1;
  const caseDirectory = path.join(temporaryRoot, `case-${caseCounter}`);
  const homeDirectory = path.join(caseDirectory, 'home');
  const claudeConfigDirectory = path.join(caseDirectory, 'claude-config');
  const xdgConfigDirectory = path.join(caseDirectory, 'xdg');
  // 舊版 hook 的狀態資料夾：setup 會清 $XDG_RUNTIME_DIR／$TMPDIR 底下的 subagent-watch，兩個都指到 case 裡，絕不碰到真的
  const runtimeDirectory = path.join(caseDirectory, 'runtime');
  const temporaryDirectory = path.join(caseDirectory, 'tmp');
  for (const directory of [homeDirectory, claudeConfigDirectory, path.join(xdgConfigDirectory, 'herdr'), runtimeDirectory, temporaryDirectory]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const settingsPath = path.join(claudeConfigDirectory, 'settings.json');
  const configPath = path.join(xdgConfigDirectory, 'herdr', 'config.toml');
  if (settingsText !== null) {
    fs.writeFileSync(settingsPath, settingsText);
  }
  if (configText !== null) {
    fs.writeFileSync(configPath, configText);
  }
  const fakeHerdrPath = path.join(caseDirectory, 'herdr');
  fs.writeFileSync(fakeHerdrPath, `#!${process.execPath}\n${fakeHerdrSource}`, { mode: 0o755 });
  const logPath = path.join(caseDirectory, 'herdr-calls.jsonl');
  return {
    caseDirectory,
    homeDirectory,
    settingsPath,
    configPath,
    logPath,
    runtimeDirectory,
    temporaryDirectory,
    environment: {
      PATH: process.env.PATH,
      HOME: homeDirectory,
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      XDG_CONFIG_HOME: xdgConfigDirectory,
      XDG_RUNTIME_DIR: runtimeDirectory,
      TMPDIR: temporaryDirectory,
      HERDR_BIN_PATH: fakeHerdrPath,
      FAKE_HERDR_LOG: logPath,
      SUBAGENT_WATCH_NODE: process.execPath,
    },
  };
}

function runSetup(testCase, args = [], extraEnvironment = {}) {
  return spawnSync('sh', [launcherPath, 'scripts/setup.mjs', ...args], {
    cwd: testCase.caseDirectory,
    env: { ...testCase.environment, ...extraEnvironment },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function readHerdrCalls(testCase) {
  if (!fs.existsSync(testCase.logPath)) {
    return [];
  }
  return fs.readFileSync(testCase.logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeStateFiles(directory, names) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  for (const name of names) {
    fs.writeFileSync(path.join(directory, name), '{}');
  }
}

test('a fresh setup adds only the key, leaves settings.json alone and backs config.toml up', () => {
  const testCase = createCase();
  const settingsBefore = fs.statSync(testCase.settingsPath);
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.statSync(testCase.settingsPath).mtimeMs, settingsBefore.mtimeMs, 'settings.json is not rewritten');
  assert.ok(!fs.existsSync(`${testCase.settingsPath}.subagent-watch.bak`));
  assert.match(result.stdout, /no subagent\.watch hooks from an older version, file not touched/);

  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), configWithKeyText);
  assert.doesNotMatch(fs.readFileSync(testCase.configPath, 'utf8'), /\$sub|rows_by_agent/);
  assert.equal(fs.readFileSync(`${testCase.configPath}.subagent-watch.bak`, 'utf8'), originalConfigText);

  const calls = readHerdrCalls(testCase);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2).join(' ')), ['config check', 'config check', 'server reload-config', 'notification show']);
  assert.equal(calls[0].configPath, testCase.configPath);
  assert.equal(calls[3].args[2], 'subagent.watch: set up');
  assert.match(result.stdout, /herdr config check: ok/);
  assert.doesNotMatch(result.stdout, /sidebar rows/);
  assert.match(result.stdout, /nothing left by the old sidebar hook/);
});

test('setup over an older install removes its hooks and sidebar rows, keeps the key and every other setting', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), configWithKeyText);
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), legacySettingsText);
  assert.equal(fs.readFileSync(`${testCase.configPath}.subagent-watch.bak`, 'utf8'), legacyConfigText);
  for (const eventName of ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure']) {
    assert.match(result.stdout, new RegExp(`${eventName}: removed the subagent\\.watch hook left by an older version`), eventName);
  }
  assert.match(result.stdout, /sidebar rows: removing the block added by an older version/);
  assert.match(result.stdout, /prefix\+\.: already bound to subagent\.watch\.open/);
});

test('running setup twice leaves the files exactly as after the first run and does not rewrite them', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  assert.equal(runSetup(testCase).status, 0);
  const settingsAfterFirst = fs.readFileSync(testCase.settingsPath, 'utf8');
  const configAfterFirst = fs.readFileSync(testCase.configPath, 'utf8');
  fs.rmSync(testCase.logPath);

  const second = runSetup(testCase);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), settingsAfterFirst);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), configAfterFirst);
  assert.deepEqual(readHerdrCalls(testCase).map((call) => call.args[0]), ['notification']);
  assert.equal(readHerdrCalls(testCase)[0].args[2], 'subagent.watch: already set up');
});

test('--remove after setup gives back config.toml byte for byte', () => {
  const testCase = createCase();
  assert.equal(runSetup(testCase).status, 0);
  const result = runSetup(testCase, ['--remove']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.match(result.stdout, /removing 1 subagent\.watch block/);
});

test('--remove over an older install takes out its hooks and both config blocks', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  const result = runSetup(testCase, ['--remove']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  assert.match(result.stdout, /removing 2 subagent\.watch block/);
});

test('the hand-written hook from before the launcher and the version before SessionStart are removed too', () => {
  const oldCommand = '/home/someone/.local/share/fnm/aliases/default/bin/node /old/place/hooks/sidebar-hook.mjs';
  const userSessionStart = [{ matcher: '*', hooks: [{ type: 'command', command: 'herdr-agent-state.sh session', timeout: 10 }] }];
  const settingsText = `${JSON.stringify({
    hooks: {
      SessionStart: userSessionStart,
      SubagentStart: [{ hooks: [{ type: 'command', command: oldCommand, timeout: 5 }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: legacyCommand, timeout: 5 }] }],
    },
  }, null, 2)}\n`;
  const testCase = createCase({ settingsText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readJson(testCase.settingsPath), { hooks: { SessionStart: userSessionStart } });
});

test('another tool\'s hook that merely mentions sidebar-hook.mjs is not removed', () => {
  const otherCommands = [
    'node /opt/other-tool/sidebar-hook.mjs',
    'node /opt/other-tool/hooks/sidebar-hook.mjs --verbose',
    'sh "/opt/a/bin/run.sh" "/opt/b/hooks/sidebar-hook.mjs"',
    'python3 /opt/other-tool/hooks/sidebar-hook.mjs',
  ];
  const otherGroups = otherCommands.map((command) => ({ hooks: [{ type: 'command', command }] }));
  const settingsText = `${JSON.stringify({ hooks: { SubagentStart: otherGroups, SubagentStop: otherGroups } }, null, 2)}\n`;
  const testCase = createCase({ settingsText });
  for (const args of [[], ['--remove']]) {
    assert.equal(runSetup(testCase, args).status, 0);
    assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), settingsText);
  }
});

test('setup removes the files the old sidebar hook left behind, then the empty folder', () => {
  const testCase = createCase();
  const stateDirectory = path.join(testCase.runtimeDirectory, 'subagent-watch');
  writeStateFiles(stateDirectory, ['pane-w1:p1.json', 'sub-s1-a1.json', 'session-s1.json', 'session-s1.json.lock', 'session-s1.json.lock.break-42', 'pane-w1:p2.json.0123456789abcdef.tmp']);
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(stateDirectory));
  assert.match(result.stdout, /removed 6 file\(s\) left by the old sidebar hook/);
  assert.match(result.stdout, /removed the empty folder/);
});

test('files the setup does not know are kept, and so is their folder', () => {
  const testCase = createCase();
  const stateDirectory = path.join(testCase.temporaryDirectory, 'subagent-watch');
  writeStateFiles(stateDirectory, ['pane-w1:p1.json', 'notes.txt']);
  const result = runSetup(testCase, [], { XDG_RUNTIME_DIR: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  if (process.platform === 'darwin') {
    assert.deepEqual(fs.readdirSync(stateDirectory), ['notes.txt']);
    assert.match(result.stdout, /also holds files this setup does not know \(notes\.txt\); kept them and the folder/);
  } else {
    // Linux 的舊版 hook 只用 XDG_RUNTIME_DIR，不看 $TMPDIR
    assert.deepEqual(fs.readdirSync(stateDirectory).sort(), ['notes.txt', 'pane-w1:p1.json']);
  }
});

test('a state folder that is a symlink is left alone', () => {
  const testCase = createCase();
  const elsewhere = path.join(testCase.caseDirectory, 'elsewhere');
  writeStateFiles(elsewhere, ['pane-w1:p1.json']);
  fs.symlinkSync(elsewhere, path.join(testCase.runtimeDirectory, 'subagent-watch'));
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(elsewhere), ['pane-w1:p1.json']);
  assert.match(result.stdout, /is not a folder of yours \(or is a symlink\); left it alone/);
});

test('when prefix+. is taken, the key is skipped with the snippet to paste and the old rows still go', () => {
  const configText = `${originalConfigText.replace('key = "prefix+y"', 'key = "prefix+."')}${legacyRowsBlockText}`;
  const testCase = createCase({ configText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /prefix\+\. is already used at line 7; left it alone/);
  assert.match(result.stdout, /command = "subagent\.watch\.open"/);
  const config = fs.readFileSync(testCase.configPath, 'utf8');
  assert.ok(!config.includes('subagent.watch.open'));
  assert.doesNotMatch(config, /\$sub1/);
  assert.equal(readHerdrCalls(testCase).at(-1).args[2], 'subagent.watch: setup needs a manual step');
});

test('$sub1 rows added by hand are kept and reported', () => {
  const configText = `${originalConfigText}\n[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"], [{ token = "$sub1" }]]\n`;
  const testCase = createCase({ configText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.readFileSync(testCase.configPath, 'utf8').startsWith(configText));
  assert.match(result.stdout, /lines 12 still mention \$sub1 outside the subagent\.watch markers/);
});

test('when herdr config check fails on the new config, config.toml is never touched and nothing is reloaded', () => {
  const testCase = createCase({ settingsText: legacySettingsText });
  const inodeBefore = fs.statSync(testCase.configPath).ino;
  const result = runSetup(testCase, [], { FAKE_HERDR_CHECK_FAIL_ON: 'subagent.watch.open' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /herdr config check failed on the new config, so .+ was not modified/);
  assert.match(result.stdout, /fake problem caused by subagent\.watch\.open/);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  assert.equal(fs.statSync(testCase.configPath).ino, inodeBefore, 'the original file is not rewritten, not even to restore it');
  assert.ok(!fs.existsSync(`${testCase.configPath}.subagent-watch.bak`));
  assert.deepEqual(fs.readdirSync(path.dirname(testCase.configPath)), ['config.toml'], 'the temporary file is cleaned up');
  const calls = readHerdrCalls(testCase);
  assert.equal(calls[0].configPath, testCase.configPath);
  assert.notEqual(calls[1].configPath, testCase.configPath);
  assert.equal(path.dirname(calls[1].configPath), path.dirname(testCase.configPath), 'the new config is checked as a temporary file next to the real one');
  assert.ok(!calls.some((call) => call.args[0] === 'server'));
  assert.equal(calls.at(-1).args[2], 'subagent.watch: setup failed');
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText, 'the Claude Code part is independent of the herdr part');
});

test('problems that were already in config.toml do not block setup', () => {
  const configText = `${originalConfigText}\n[ui.extra]\nbogus_key = 1\n`;
  const testCase = createCase({ configText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /only issues that were already there/);
  assert.match(fs.readFileSync(testCase.configPath, 'utf8'), /subagent\.watch\.open/);
});

test('a config.toml herdr cannot parse is not touched', () => {
  const configText = 'this is not toml [[[\n';
  const testCase = createCase({ configText });
  const result = runSetup(testCase);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /herdr cannot parse .+ as it is; fix it first/);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), configText);
  assert.ok(!fs.existsSync(`${testCase.configPath}.subagent-watch.bak`));
});

test('a failing reload-config is only a warning', () => {
  const testCase = createCase();
  const result = runSetup(testCase, [], { FAKE_HERDR_RELOAD_STATUS: '3' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /herdr server reload-config failed .+run it yourself or restart herdr/);
});

test('--dry-run prints the planned change and writes or deletes nothing, not even through herdr', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  const stateDirectory = path.join(testCase.runtimeDirectory, 'subagent-watch');
  writeStateFiles(stateDirectory, ['pane-w1:p1.json']);
  const result = runSetup(testCase, ['--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /dry run, nothing is written/);
  assert.match(result.stdout, /\(dry run\) would write .+settings\.json/);
  assert.match(result.stdout, / {4}- {3}\[\{ token = "\$sub1", bold = true, dim = false \}\],/);
  assert.match(result.stdout, /\(dry run\) would remove 1 file\(s\) left by the old sidebar hook/);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), legacySettingsText);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), legacyConfigText);
  assert.deepEqual(fs.readdirSync(stateDirectory), ['pane-w1:p1.json']);
  assert.deepEqual(readHerdrCalls(testCase), []);
  assert.ok(!fs.existsSync(`${testCase.settingsPath}.subagent-watch.bak`));
});

test('CLAUDE_CONFIG_DIR decides where settings.json is; without it $HOME/.claude is used', () => {
  const testCase = createCase({ settingsText: legacySettingsText });
  const homeSettingsPath = path.join(testCase.homeDirectory, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(homeSettingsPath), { recursive: true });
  fs.writeFileSync(homeSettingsPath, legacySettingsText);
  assert.equal(runSetup(testCase).status, 0);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(homeSettingsPath, 'utf8'), legacySettingsText);

  const result = runSetup(testCase, [], { CLAUDE_CONFIG_DIR: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(homeSettingsPath, 'utf8'), originalSettingsText);
});

test('a missing settings.json is not created; a missing config.toml gets the key; remove empties it again', () => {
  const testCase = createCase({ settingsText: null, configText: null });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(testCase.settingsPath));
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), keyBlockText);
  assert.equal(runSetup(testCase, ['--remove']).status, 0);
  assert.ok(!fs.existsSync(testCase.settingsPath));
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), '');
});

test('invalid settings.json is reported and left alone while herdr setup still runs', () => {
  const testCase = createCase({ settingsText: '{ "hooks": ' });
  const result = runSetup(testCase);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /settings\.json is not valid JSON .+not modified/);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), '{ "hooks": ');
  assert.match(fs.readFileSync(testCase.configPath, 'utf8'), /subagent\.watch\.open/);
});

test('HERDR_CONFIG_PATH wins over XDG_CONFIG_HOME, the same way herdr reads it', () => {
  const testCase = createCase();
  const customConfigPath = path.join(testCase.caseDirectory, 'custom-herdr.toml');
  fs.writeFileSync(customConfigPath, originalConfigText);
  const result = runSetup(testCase, [], { HERDR_CONFIG_PATH: customConfigPath });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(customConfigPath, 'utf8'), /subagent\.watch\.open/);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
});

test('unknown arguments exit 2 with usage', () => {
  const testCase = createCase();
  const result = runSetup(testCase, ['--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown argument: --bogus/);
  assert.deepEqual(readHerdrCalls(testCase), []);
});

test('the first backup is kept: setup, remove and setup again never overwrite the .bak', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  assert.equal(runSetup(testCase).status, 0);
  const settingsBackupPath = `${testCase.settingsPath}.subagent-watch.bak`;
  const configBackupPath = `${testCase.configPath}.subagent-watch.bak`;
  // 使用者在 setup 之後自己又改了設定、又裝回舊版的 hook；之後的 setup／remove 都不能拿這些版本蓋掉原始備份
  const editedSettings = buildLegacySettings();
  editedSettings.model = 'sonnet';
  fs.writeFileSync(testCase.settingsPath, `${JSON.stringify(editedSettings, null, 2)}\n`);
  fs.appendFileSync(testCase.configPath, '\n[ui.extra_section]\n');

  const removed = runSetup(testCase, ['--remove']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /backup: kept the existing .+settings\.json\.subagent-watch\.bak/);
  assert.match(removed.stdout, /backup: kept the existing .+config\.toml\.subagent-watch\.bak/);
  assert.equal(runSetup(testCase).status, 0);
  assert.equal(fs.readFileSync(settingsBackupPath, 'utf8'), legacySettingsText);
  assert.equal(fs.readFileSync(configBackupPath, 'utf8'), legacyConfigText);
});

test('--dry-run says an existing backup is kept', () => {
  const testCase = createCase({ settingsText: legacySettingsText });
  fs.writeFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'older backup');
  const result = runSetup(testCase, ['--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\(dry run\) would write .+settings\.json \(keeping the existing backup .+settings\.json\.subagent-watch\.bak\)/);
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), 'older backup');
});

test('review PoC: settings.json and config.toml symlinked from a dotfiles folder stay symlinks', () => {
  const testCase = createCase({ settingsText: legacySettingsText, configText: legacyConfigText });
  const dotfilesDirectory = path.join(testCase.caseDirectory, 'dotfiles');
  fs.mkdirSync(dotfilesDirectory);
  const realSettingsPath = path.join(dotfilesDirectory, 'settings.json');
  const realConfigPath = path.join(dotfilesDirectory, 'config.toml');
  fs.renameSync(testCase.settingsPath, realSettingsPath);
  fs.renameSync(testCase.configPath, realConfigPath);
  fs.chmodSync(realSettingsPath, 0o600);
  fs.symlinkSync(realSettingsPath, testCase.settingsPath);
  fs.symlinkSync(path.relative(path.dirname(testCase.configPath), realConfigPath), testCase.configPath);

  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.lstatSync(testCase.settingsPath).isSymbolicLink());
  assert.ok(fs.lstatSync(testCase.configPath).isSymbolicLink());
  assert.equal(fs.readFileSync(realSettingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(realConfigPath, 'utf8'), configWithKeyText);
  assert.equal(fs.statSync(realSettingsPath).mode & 0o777, 0o600);
  assert.match(result.stdout, /settings\.json is a symlink; wrote .+dotfiles\/settings\.json and left the symlink in place/);
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), legacySettingsText);
  const calls = readHerdrCalls(testCase);
  assert.equal(path.dirname(calls[1].configPath), dotfilesDirectory, 'the temporary config is written next to the real file');
  assert.deepEqual(fs.readdirSync(dotfilesDirectory).sort(), ['config.toml', 'settings.json']);

  assert.equal(runSetup(testCase, ['--remove']).status, 0);
  assert.ok(fs.lstatSync(testCase.configPath).isSymbolicLink());
  assert.equal(fs.readFileSync(realConfigPath, 'utf8'), originalConfigText);
});

// Bazzite 的 /home 是指向 /var/home 的 symlink：設定檔本身是一般檔案，只是路徑上有 symlink 的資料夾，不該說它是 symlink
test('a symlinked parent folder (like /home -> /var/home) is not reported as a symlinked config file', () => {
  const testCase = createCase({ settingsText: legacySettingsText });
  for (const linkedDirectory of [path.dirname(testCase.settingsPath), path.dirname(path.dirname(testCase.configPath))]) {
    fs.renameSync(linkedDirectory, `${linkedDirectory}-real`);
    fs.symlinkSync(`${linkedDirectory}-real`, linkedDirectory);
  }
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /is a symlink/);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.match(fs.readFileSync(testCase.configPath, 'utf8'), /subagent\.watch\.open/);
  assert.ok(!fs.lstatSync(testCase.settingsPath).isSymbolicLink());
  assert.ok(!fs.lstatSync(testCase.configPath).isSymbolicLink());
  assert.ok(fs.lstatSync(path.dirname(testCase.settingsPath)).isSymbolicLink(), 'the symlinked folder stays a symlink');
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), legacySettingsText);
});

test('a folder setup cannot write into gives a clear error instead of a crash, and the original stays', { skip: process.getuid() === 0 && 'root ignores folder permissions' }, () => {
  const testCase = createCase();
  const configDirectory = path.dirname(testCase.configPath);
  fs.chmodSync(configDirectory, 0o555);
  try {
    const result = runSetup(testCase);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /ERROR cannot write a temporary file next to .+config\.toml: .+; config\.toml not modified/);
    assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  } finally {
    fs.chmodSync(configDirectory, 0o755);
  }
});

test('nothing of ours in settings.json leaves it untouched, empty arrays included', () => {
  const settingsText = '{\n  "hooks": {\n    "SubagentStart": [],\n    "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }]\n  }\n}\n';
  const testCase = createCase({ settingsText });
  const before = fs.statSync(testCase.settingsPath);
  for (const args of [[], ['--remove']]) {
    const result = runSetup(testCase, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no subagent\.watch hooks from an older version, file not touched/);
  }
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), settingsText);
  assert.equal(fs.statSync(testCase.settingsPath).ino, before.ino);
  assert.equal(fs.statSync(testCase.settingsPath).mtimeMs, before.mtimeMs);
  assert.ok(!fs.existsSync(`${testCase.settingsPath}.subagent-watch.bak`));
});

test('a CRLF settings.json with 4-space indent keeps CRLF and its indent when the old hooks are removed', () => {
  const settingsText = `${JSON.stringify(buildLegacySettings(['SubagentStart', 'SubagentStop']), null, 4)}\n`.replace(/\n/g, '\r\n');
  const testCase = createCase({ settingsText });
  assert.equal(runSetup(testCase).status, 0);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), `${JSON.stringify(originalSettings, null, 4)}\n`.replace(/\n/g, '\r\n'));
});
