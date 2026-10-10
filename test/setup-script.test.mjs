import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const launcherPath = path.join(repositoryDirectory, 'bin', 'run.sh');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-setup-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const expectedCommand = `sh "${repositoryDirectory}/bin/run.sh" "${repositoryDirectory}/hooks/sidebar-hook.mjs"`;

const originalSettingsText = `${JSON.stringify({
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 10 }] }],
  },
  statusLine: { type: 'command', command: 'status.sh' },
}, null, 2)}\n`;

const originalConfigText = 'onboarding = false\n\n[ui]\nstatus_indicators = "symbols"\n\n[[keys.command]]\nkey = "prefix+y"\ntype = "popup"\ncommand = "yazi"\n';

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
  fs.mkdirSync(homeDirectory, { recursive: true });
  fs.mkdirSync(claudeConfigDirectory, { recursive: true });
  fs.mkdirSync(path.join(xdgConfigDirectory, 'herdr'), { recursive: true });
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
    environment: {
      PATH: process.env.PATH,
      HOME: homeDirectory,
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      XDG_CONFIG_HOME: xdgConfigDirectory,
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

test('setup adds the hooks and the herdr config, keeps every other hook and backs both files up', () => {
  const testCase = createCase();
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const settings = readJson(testCase.settingsPath);
  const original = JSON.parse(originalSettingsText);
  assert.deepEqual(settings.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(settings.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(settings.statusLine, original.statusLine);
  for (const eventName of ['SubagentStart', 'SubagentStop']) {
    assert.deepEqual(settings.hooks[eventName], [{ hooks: [{ type: 'command', command: expectedCommand, timeout: 5 }] }]);
  }
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), originalSettingsText);

  const config = fs.readFileSync(testCase.configPath, 'utf8');
  assert.ok(config.startsWith(originalConfigText));
  assert.match(config, /command = "subagent\.watch\.open"/);
  assert.match(config, /\[ui\.sidebar\.agents\.rows_by_agent\]/);
  assert.equal(fs.readFileSync(`${testCase.configPath}.subagent-watch.bak`, 'utf8'), originalConfigText);

  const calls = readHerdrCalls(testCase);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2).join(' ')), ['config check', 'config check', 'server reload-config', 'notification show']);
  assert.equal(calls[0].configPath, testCase.configPath);
  assert.equal(calls[3].args[2], 'subagent.watch: set up');
  assert.match(result.stdout, /SubagentStart: added/);
  assert.match(result.stdout, /herdr config check: ok/);
});

test('running setup twice leaves the files exactly as after the first run and does not rewrite them', () => {
  const testCase = createCase();
  assert.equal(runSetup(testCase).status, 0);
  const settingsAfterFirst = fs.readFileSync(testCase.settingsPath, 'utf8');
  const configAfterFirst = fs.readFileSync(testCase.configPath, 'utf8');
  fs.rmSync(testCase.logPath);

  const second = runSetup(testCase);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), settingsAfterFirst);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), configAfterFirst);
  assert.equal(fs.readFileSync(`${testCase.settingsPath}.subagent-watch.bak`, 'utf8'), originalSettingsText, 'second run must not overwrite the backup');
  assert.deepEqual(readHerdrCalls(testCase).map((call) => call.args[0]), ['notification']);
  assert.match(second.stdout, /already set up, file not touched/);
  assert.equal(readHerdrCalls(testCase)[0].args[2], 'subagent.watch: already set up');
});

test('--remove after setup gives back both files byte for byte', () => {
  const testCase = createCase();
  assert.equal(runSetup(testCase).status, 0);
  const result = runSetup(testCase, ['--remove']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  assert.match(result.stdout, /SubagentStart: removed/);
});

test('an older hook pointing at sidebar-hook.mjs is rewritten in place, and --remove drops it', () => {
  const oldCommand = '/home/someone/.local/share/fnm/aliases/default/bin/node /old/place/hooks/sidebar-hook.mjs';
  const settingsText = `${JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'herdr-agent-state.sh session', timeout: 10 }] }],
      SubagentStart: [{ hooks: [{ type: 'command', command: oldCommand, timeout: 5 }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: oldCommand, timeout: 5 }] }],
    },
  }, null, 2)}\n`;
  const testCase = createCase({ settingsText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SubagentStart: updated/);
  const settings = readJson(testCase.settingsPath);
  assert.deepEqual(settings.hooks.SubagentStart, [{ hooks: [{ type: 'command', command: expectedCommand, timeout: 5 }] }]);
  assert.deepEqual(settings.hooks.SessionStart, JSON.parse(settingsText).hooks.SessionStart);

  assert.equal(runSetup(testCase, ['--remove']).status, 0);
  assert.deepEqual(readJson(testCase.settingsPath), { hooks: { SessionStart: JSON.parse(settingsText).hooks.SessionStart } });
});

test('when prefix+. is taken, the key is skipped with the snippet to paste and everything else still happens', () => {
  const configText = originalConfigText.replace('key = "prefix+y"', 'key = "prefix+."');
  const testCase = createCase({ configText });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /prefix\+\. is already used at line 7; left it alone/);
  assert.match(result.stdout, /command = "subagent\.watch\.open"/);
  const config = fs.readFileSync(testCase.configPath, 'utf8');
  assert.ok(!config.includes('subagent.watch.open'));
  assert.match(config, /\[ui\.sidebar\.agents\.rows_by_agent\]/);
  assert.equal(readHerdrCalls(testCase).at(-1).args[2], 'subagent.watch: setup needs a manual step');
});

test('when herdr config check fails after the change, config.toml is restored and nothing is reloaded', () => {
  const testCase = createCase();
  const result = runSetup(testCase, [], { FAKE_HERDR_CHECK_FAIL_ON: 'rows_by_agent' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /herdr config check failed after the change, so .+ was restored/);
  assert.match(result.stdout, /fake problem caused by rows_by_agent/);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  const calls = readHerdrCalls(testCase);
  assert.ok(!calls.some((call) => call.args[0] === 'server'));
  assert.equal(calls.at(-1).args[2], 'subagent.watch: setup failed');
  assert.equal(readJson(testCase.settingsPath).hooks.SubagentStart.length, 1, 'the Claude Code part is independent of the herdr part');
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

test('--dry-run prints the planned change and writes nothing, not even through herdr', () => {
  const testCase = createCase();
  const result = runSetup(testCase, ['--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /dry run, nothing is written/);
  assert.match(result.stdout, /\(dry run\) would write .+settings\.json/);
  assert.match(result.stdout, / {4}\+ key = "prefix\+\."/);
  assert.equal(fs.readFileSync(testCase.settingsPath, 'utf8'), originalSettingsText);
  assert.equal(fs.readFileSync(testCase.configPath, 'utf8'), originalConfigText);
  assert.deepEqual(readHerdrCalls(testCase), []);
  assert.ok(!fs.existsSync(`${testCase.settingsPath}.subagent-watch.bak`));
});

test('CLAUDE_CONFIG_DIR decides where settings.json is; without it $HOME/.claude is used', () => {
  const testCase = createCase();
  assert.equal(runSetup(testCase).status, 0);
  assert.ok(!fs.existsSync(path.join(testCase.homeDirectory, '.claude', 'settings.json')));

  const homeCase = createCase();
  const result = runSetup(homeCase, [], { CLAUDE_CONFIG_DIR: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const homeSettingsPath = path.join(homeCase.homeDirectory, '.claude', 'settings.json');
  assert.deepEqual(readJson(homeSettingsPath).hooks.SubagentStop, [{ hooks: [{ type: 'command', command: expectedCommand, timeout: 5 }] }]);
  assert.equal(fs.readFileSync(homeCase.settingsPath, 'utf8'), originalSettingsText);
});

test('missing settings.json and config.toml are created; remove leaves them without our entries', () => {
  const testCase = createCase({ settingsText: null, configText: null });
  const result = runSetup(testCase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Array.isArray(readJson(testCase.settingsPath).hooks.SubagentStart));
  assert.ok(!fs.existsSync(`${testCase.settingsPath}.subagent-watch.bak`));
  assert.match(fs.readFileSync(testCase.configPath, 'utf8'), /subagent\.watch\.open/);
  assert.equal(runSetup(testCase, ['--remove']).status, 0);
  assert.deepEqual(readJson(testCase.settingsPath), {});
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
