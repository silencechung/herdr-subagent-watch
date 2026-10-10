import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { resolveHerdrBinPath } from '../lib/herdr.mjs';
import {
  analyzeHerdrConfig,
  applyHerdrSetup,
  markerEnd,
  markerStart,
  parseTableHeader,
  readArrayValue,
  removeHerdrSetup,
  stripComment,
} from '../lib/setup-herdr.mjs';

const baseConfig = [
  'onboarding = false',
  '',
  '[ui]',
  'status_indicators = "symbols"',
  '',
  '[[keys.command]]',
  'key = "prefix+y"',
  'type = "popup"',
  'command = "yazi"',
  '',
].join('\n');

const tableWithoutClaude = `${baseConfig}
[ui.sidebar.agents.rows_by_agent] # per agent rows
codex = [
  ["state_icon", "workspace"],
  ["agent"],
]
`;

const ownClaudeRows = `${baseConfig}
[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "workspace"],
  # my own rows, no sub agent lines
  ["agent"],
]
`;

const alreadyConfigured = `${baseConfig}
[[keys.command]]
key = "prefix+."
type = "plugin_action"
command = "subagent.watch.open"
description = "sub agent viewer"

[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$sub1", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
]
`;

function countMarkers(text) {
  return text.split('\n').filter((line) => line.startsWith(markerStart)).length;
}

describe('line helpers', () => {
  test('comments are stripped only outside strings', () => {
    assert.equal(stripComment('key = "a#b" # note'), 'key = "a#b" ');
    assert.equal(stripComment("key = 'x#y'"), "key = 'x#y'");
    assert.equal(stripComment('key = "esc\\"#" # c'), 'key = "esc\\"#" ');
  });

  test('table headers are recognised, array rows are not', () => {
    assert.deepEqual(parseTableHeader('[ui.sidebar.agents.rows_by_agent] # x'), { name: 'ui.sidebar.agents.rows_by_agent', isArray: false });
    assert.deepEqual(parseTableHeader('[[keys.command]]'), { name: 'keys.command', isArray: true });
    assert.equal(parseTableHeader('  ["agent"],'), null);
    assert.equal(parseTableHeader('[[keys.command]'), null);
  });

  test('array values are read across lines with brackets inside strings and comments ignored', () => {
    const lines = ['claude = [', '  ["a]"], # ]', '  [{ token = "$sub1" }],', ']', 'other = ["$sub2"]'];
    const value = readArrayValue(lines, 0);
    assert.ok(value.includes('$sub1'));
    assert.ok(!value.includes('$sub2'));
  });
});

describe('setup', () => {
  test('no rows table: appends the key and a full rows table, each inside markers', () => {
    const { text, analysis } = applyHerdrSetup(baseConfig);
    assert.equal(analysis.key.state, 'missing');
    assert.equal(analysis.rows.state, 'missing-table');
    assert.ok(text.startsWith(baseConfig));
    assert.equal(countMarkers(text), 2);
    assert.match(text, /\[\[keys\.command\]\]\nkey = "prefix\+\."\ntype = "plugin_action"\ncommand = "subagent\.watch\.open"/);
    assert.match(text, /\[ui\.sidebar\.agents\.rows_by_agent\]\nclaude = \[\n {2}\["state_icon", "machine", "workspace", "tab"\],\n {2}\["agent"\],/);
    for (let index = 1; index <= 5; index += 1) {
      assert.ok(text.includes(`[{ token = "$sub${index}", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],`));
    }
    assert.doesNotMatch(text, /\bfg\s*=/);
  });

  test('rows table without claude: claude rows go right under the table header', () => {
    const { text, analysis } = applyHerdrSetup(tableWithoutClaude);
    assert.equal(analysis.rows.state, 'missing-claude');
    const lines = text.split('\n');
    const headerIndex = lines.indexOf('[ui.sidebar.agents.rows_by_agent] # per agent rows');
    assert.ok(lines[headerIndex + 1].startsWith(markerStart));
    assert.equal(lines[headerIndex + 2], 'claude = [');
    assert.ok(lines.indexOf('codex = [') > headerIndex + 2);
    assert.equal(text.split('[ui.sidebar.agents.rows_by_agent]').length, 2, 'must not add a second table header');
  });

  test('own claude rows without $sub1 are left alone', () => {
    const { text, analysis } = applyHerdrSetup(ownClaudeRows);
    assert.equal(analysis.rows.state, 'custom');
    assert.match(analysis.rows.reason, /own claude rows/);
    assert.ok(!text.slice(baseConfig.length).includes('$sub1'));
  });

  test('claude rows that already show $sub1 and the existing key binding count as configured', () => {
    const { text, analysis, operations } = applyHerdrSetup(alreadyConfigured);
    assert.equal(analysis.key.state, 'configured');
    assert.equal(analysis.rows.state, 'configured');
    assert.deepEqual(operations, []);
    assert.equal(text, alreadyConfigured);
  });

  test('prefix+. bound to something else is reported and not touched', () => {
    const occupied = baseConfig.replace('key = "prefix+y"', 'key = "prefix+."');
    const { text, analysis } = applyHerdrSetup(occupied);
    assert.equal(analysis.key.state, 'occupied');
    assert.equal(analysis.key.lineNumber, 7);
    assert.ok(!text.includes('subagent.watch.open'));
    assert.equal(analysis.rows.state, 'missing-table');
  });

  test('prefix+. used by a built-in action in [keys] also counts as taken', () => {
    const { analysis } = applyHerdrSetup(`[keys]\nrename_tab = "prefix+."\n`);
    assert.equal(analysis.key.state, 'occupied');
  });

  test('rows_by_agent written in another form is left alone', () => {
    const { analysis } = applyHerdrSetup('[ui.sidebar.agents]\nrows_by_agent = { claude = [["agent"]] }\n');
    assert.equal(analysis.rows.state, 'custom');
  });

  test('custom [ui.sidebar.agents] rows produce a warning flag', () => {
    const analysis = analyzeHerdrConfig('[ui.sidebar.agents]\nrows = [["agent"]]\n');
    assert.equal(analysis.customAgentRowsLineNumber, 2);
  });

  test('setup twice gives the same text', () => {
    for (const original of [baseConfig, tableWithoutClaude, ownClaudeRows, '']) {
      const once = applyHerdrSetup(original).text;
      assert.equal(applyHerdrSetup(once).text, once);
    }
  });
});

describe('remove', () => {
  test('setup then remove gives back the original text byte for byte', () => {
    for (const original of [baseConfig, tableWithoutClaude, ownClaudeRows, alreadyConfigured, '', 'a = 1\r\n[ui]\r\nb = 2\r\n']) {
      const installed = applyHerdrSetup(original).text;
      const removed = removeHerdrSetup(installed);
      assert.equal(removed.error, null);
      assert.equal(removed.text, original);
    }
  });

  test('settings added by hand (no markers) are not removed but are reported', () => {
    const result = removeHerdrSetup(alreadyConfigured);
    assert.equal(result.text, alreadyConfigured);
    assert.deepEqual(result.operations, []);
    assert.ok(result.leftoverLineNumbers.length >= 2);
  });

  test('an unterminated marker block removes nothing', () => {
    const broken = `${baseConfig}${markerStart}\n[[keys.command]]\nkey = "prefix+."\n`;
    const result = removeHerdrSetup(broken);
    assert.equal(result.text, broken);
    assert.match(result.error, /never ends/);
    assert.ok(result.error.includes(markerEnd));
  });
});

const herdrBinPath = resolveHerdrBinPath(process.env);
const canRunHerdr = herdrBinPath !== null && spawnSync(herdrBinPath, ['--version'], { encoding: 'utf8' }).status === 0;

describe('generated config passes the real `herdr config check`', { skip: !canRunHerdr && 'herdr is not available' }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-herdr-check-'));
  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function checkConfig(name, text) {
    const configPath = path.join(temporaryRoot, `${name}.toml`);
    fs.writeFileSync(configPath, text);
    // config check 只讀檔案、不連 server；仍拿掉 socket 變數，確保碰不到正在跑的 herdr
    const environment = { ...process.env, HERDR_CONFIG_PATH: configPath };
    delete environment.HERDR_SOCKET_PATH;
    return spawnSync(herdrBinPath, ['config', 'check'], { env: environment, encoding: 'utf8' });
  }

  for (const [name, original] of [['no-table', baseConfig], ['table-without-claude', tableWithoutClaude], ['empty', '']]) {
    test(name, () => {
      const result = checkConfig(name, applyHerdrSetup(original).text);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /config: ok/);
    });
  }
});
