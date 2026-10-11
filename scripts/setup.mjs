// subagent.watch.setup／subagent.watch.remove：把 Claude Code hook、herdr 快捷鍵與側邊欄 rows 加進（或移出）使用者自己的設定檔。
// 用法：sh bin/run.sh scripts/setup.mjs [--remove] [--dry-run]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaudeSettingsPath } from '../lib/claude-config.mjs';
import { herdrNotFoundMessage, resolveHerdrBinPath } from '../lib/herdr.mjs';
import {
  buildHookCommand,
  findSettingsShapeProblem,
  formatSettings,
  hookEventNames,
  installSidebarHooks,
  removeSidebarHooks,
} from '../lib/setup-claude.mjs';
import {
  applyHerdrSetup,
  buildManualKeySnippet,
  buildManualRowsSnippet,
  keyBinding,
  openActionId,
  removeHerdrSetup,
  rowsTableName,
} from '../lib/setup-herdr.mjs';

export const backupSuffix = '.subagent-watch.bak';
const defaultPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usageText = 'Usage: sh bin/run.sh scripts/setup.mjs [--remove] [--dry-run]\n';
const herdrTimeoutMs = 10_000;

export function parseArguments(argv) {
  const options = { isRemove: false, isDryRun: false, error: null };
  for (const argument of argv) {
    if (argument === '--remove') {
      options.isRemove = true;
    } else if (argument === '--dry-run') {
      options.isDryRun = true;
    } else if (argument === '--help' || argument === '-h') {
      options.error = '';
    } else {
      options.error = `unknown argument: ${argument}`;
    }
  }
  return options;
}

// herdr 讀 HERDR_CONFIG_PATH，沒有才用 ${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml（兩個都實測過 `herdr config check` 會照著讀）
export function getHerdrConfigPath(environment) {
  if (typeof environment.HERDR_CONFIG_PATH === 'string' && environment.HERDR_CONFIG_PATH !== '') {
    return environment.HERDR_CONFIG_PATH;
  }
  const homeDirectory = environment.HOME || os.homedir();
  const configHome = typeof environment.XDG_CONFIG_HOME === 'string' && environment.XDG_CONFIG_HOME !== ''
    ? environment.XDG_CONFIG_HOME
    : path.join(homeDirectory, '.config');
  return path.join(configHome, 'herdr', 'config.toml');
}

function readTextFile(filePath) {
  try {
    return { text: fs.readFileSync(filePath, 'utf8'), existed: true, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { text: '', existed: false, error: null };
    }
    return { text: '', existed: false, error: `cannot read ${filePath}: ${error.message}` };
  }
}

// 設定檔可能是指向 dotfiles repo 的 symlink：直接 rename 到原路徑會把 symlink 換成一般檔案，所以寫到它指向的真實檔案。
// isSymlink 只看設定檔本身：上層資料夾是 symlink（例如 Bazzite 的 /home → /var/home）時 realpath 也會不同，但那不是使用者自己放的 symlink
function resolveWritePath(filePath) {
  try {
    const realPath = fs.realpathSync(filePath);
    return { path: realPath, isSymlink: fs.lstatSync(filePath).isSymbolicLink(), error: null };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { path: null, isSymlink: false, error: `cannot resolve ${filePath}: ${error.message}` };
    }
  }
  let isDanglingSymlink = false;
  try {
    isDanglingSymlink = fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    // 檔案不存在：照原路徑新建
  }
  if (isDanglingSymlink) {
    return { path: null, isSymlink: true, error: `${filePath} is a symlink to a file that does not exist` };
  }
  return { path: filePath, isSymlink: false, error: null };
}

function readFileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return 0o644;
  }
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // 已經不在了
  }
}

// 暫存檔放在目標旁邊（同一個檔案系統 rename 才是原子的），檔名隨機、用 wx 建立，不會跟著別人預放的 symlink 寫出去；權限照原檔（settings.json 可能是 0600）
function writeTemporaryFile(targetPath, text, mode) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, text, { mode, flag: 'wx' });
  try {
    fs.chmodSync(temporaryPath, mode);
  } catch (error) {
    removeQuietly(temporaryPath);
    throw error;
  }
  return temporaryPath;
}

function replaceFile(temporaryPath, targetPath) {
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    removeQuietly(temporaryPath);
    throw error;
  }
}

// 只備份第一次：.bak 已經在就不覆寫。每次都覆寫的話，setup → remove → setup 之後 .bak 裡已經是改過的版本，使用者原本的設定就找不回來
function backUpOnce(filePath, originalText, mode) {
  const backupPath = `${filePath}${backupSuffix}`;
  try {
    fs.writeFileSync(backupPath, originalText, { mode, flag: 'wx' });
    return `backup: ${backupPath}`;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return `backup: kept the existing ${backupPath} (from an earlier run, not overwritten)`;
    }
    throw error;
  }
}

function describePlannedBackup(filePath, existed) {
  if (!existed) {
    return '';
  }
  const backupPath = `${filePath}${backupSuffix}`;
  let hasBackup = false;
  try {
    fs.lstatSync(backupPath);
    hasBackup = true;
  } catch {
    // 還沒有備份
  }
  return hasBackup ? ` (keeping the existing backup ${backupPath})` : ` and back it up to ${backupPath}`;
}

function describeSymlinkTarget(filePath, target) {
  return target.isSymlink ? [`${filePath} is a symlink; wrote ${target.path} and left the symlink in place`] : [];
}

function runHerdr(herdrBinPath, argumentList, environment) {
  const result = spawnSync(herdrBinPath, argumentList, {
    env: environment,
    encoding: 'utf8',
    timeout: herdrTimeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error ? result.error.message : null,
  };
}

// `herdr config check`（0.9.3 實測）：通過印 `config: ok`、exit 0；有問題印 `config: issues found` 加一行一個 diagnostic、exit 1
function checkHerdrConfig(herdrBinPath, configPath, environment) {
  const result = runHerdr(herdrBinPath, ['config', 'check'], { ...environment, HERDR_CONFIG_PATH: configPath });
  const lines = result.output.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    didRun: result.status !== null,
    isOk: result.status === 0,
    isParseError: result.output.includes('parse error'),
    diagnostics: lines.filter((line) => !line.startsWith('config:')),
    output: result.error ?? result.output,
  };
}

function isAcceptableCheck(before, after) {
  if (!after.didRun) {
    return false;
  }
  if (after.isOk) {
    return true;
  }
  // 原本就有的問題（例如不認得的 key）不算這次改壞；只要沒有多出新的 diagnostic
  return !before.isOk && !after.isParseError && after.diagnostics.every((line) => before.diagnostics.includes(line));
}

function setUpClaudeHooks({ environment, pluginRoot, isRemove, isDryRun }) {
  const settingsPath = getClaudeSettingsPath(environment);
  const section = { title: `Claude Code (${settingsPath})`, lines: [], errors: [], warnings: [], changed: false };
  const file = readTextFile(settingsPath);
  if (file.error !== null) {
    section.errors.push(file.error);
    return section;
  }
  let settings = {};
  if (file.existed && file.text.trim() !== '') {
    try {
      settings = JSON.parse(file.text);
    } catch (error) {
      section.errors.push(`settings.json is not valid JSON (${error.message}); not modified`);
      return section;
    }
  }
  const shapeProblem = findSettingsShapeProblem(settings);
  if (shapeProblem !== null) {
    section.errors.push(`${shapeProblem}; not modified`);
    return section;
  }

  let result;
  if (isRemove) {
    result = removeSidebarHooks(settings);
  } else {
    let command;
    try {
      command = buildHookCommand(pluginRoot);
    } catch (error) {
      section.errors.push(error.message);
      return section;
    }
    result = installSidebarHooks(settings, command);
    section.lines.push(`hook command: ${command}`);
  }
  for (const eventName of hookEventNames) {
    section.lines.push(`${eventName}: ${result.changes[eventName]}`);
  }
  const nextText = formatSettings(result.settings, file.existed ? file.text : '');
  const isUnchanged = isRemove ? result.removedCount === 0 : JSON.stringify(result.settings) === JSON.stringify(settings);
  if (isUnchanged) {
    section.lines.push(isRemove ? 'nothing to remove, file not touched' : 'already set up, file not touched');
    return section;
  }
  const target = resolveWritePath(settingsPath);
  if (target.error !== null) {
    section.errors.push(`${target.error}; not modified`);
    return section;
  }
  section.changed = true;
  if (isDryRun) {
    section.lines.push(`(dry run) would write ${target.path}${describePlannedBackup(settingsPath, file.existed)}`);
    return section;
  }
  try {
    const mode = readFileMode(target.path);
    const backupLine = file.existed ? backUpOnce(settingsPath, file.text, mode) : `created ${settingsPath}`;
    replaceFile(writeTemporaryFile(target.path, nextText, mode), target.path);
    section.lines.push(backupLine, ...describeSymlinkTarget(settingsPath, target));
  } catch (error) {
    section.errors.push(`cannot write ${settingsPath}: ${error.message}`);
  }
  return section;
}

function describeOperations(operations) {
  const lines = [];
  for (const operation of operations) {
    if (operation.kind === 'remove') {
      lines.push(`(dry run) would remove lines ${operation.startLineNumber}-${operation.startLineNumber + operation.lines.length - 1}:`);
      lines.push(...operation.lines.map((line) => `  - ${line}`));
    } else {
      lines.push(`(dry run) would ${operation.kind === 'insert' ? 'insert' : 'append'} after line ${operation.afterLineNumber}:`);
      lines.push(...operation.lines.map((line) => `  + ${line}`));
    }
  }
  return lines;
}

function describeSetupAnalysis(analysis, section) {
  const { key, rows } = analysis;
  if (key.state === 'missing') {
    section.lines.push(`${keyBinding}: adding a binding to ${openActionId}`);
  } else if (key.state === 'configured') {
    section.lines.push(`${keyBinding}: already bound to ${openActionId} (line ${key.lineNumber})`);
  } else {
    section.warnings.push(`${keyBinding} is already used at line ${key.lineNumber}; left it alone. Bind ${openActionId} to another key yourself:`);
    section.warnings.push(...buildManualKeySnippet().map((line) => `    ${line}`));
  }
  if (rows.state === 'missing-table') {
    section.lines.push(`sidebar rows: adding [${rowsTableName}] with claude rows`);
  } else if (rows.state === 'missing-claude') {
    section.lines.push(`sidebar rows: adding claude rows to the existing [${rowsTableName}]`);
  } else if (rows.state === 'configured') {
    section.lines.push(`sidebar rows: claude rows already show $sub1 (line ${rows.lineNumber})`);
  } else {
    section.warnings.push(`sidebar rows: ${rows.reason} (line ${rows.lineNumber}); left them alone. Add the sub agent row yourself:`);
    section.warnings.push(...buildManualRowsSnippet().map((line) => `    ${line}`));
  }
  const isAddingRows = rows.state === 'missing-table' || rows.state === 'missing-claude';
  if (isAddingRows && analysis.customAgentRowsLineNumber !== null) {
    section.warnings.push(`your [ui.sidebar.agents] rows (line ${analysis.customAgentRowsLineNumber}) no longer apply to claude panes; edit the added claude rows if you want them back`);
  }
}

function setUpHerdrConfig({ environment, isRemove, isDryRun }) {
  const configPath = getHerdrConfigPath(environment);
  const section = { title: `herdr (${configPath})`, lines: [], errors: [], warnings: [], changed: false, reloaded: false };
  const file = readTextFile(configPath);
  if (file.error !== null) {
    section.errors.push(file.error);
    return section;
  }

  let nextText;
  let operations;
  if (isRemove) {
    const result = removeHerdrSetup(file.text);
    if (result.error !== null) {
      section.errors.push(result.error);
      return section;
    }
    nextText = result.text;
    operations = result.operations;
    section.lines.push(operations.length === 0 ? 'no subagent.watch block found' : `removing ${operations.length} subagent.watch block(s)`);
    if (result.leftoverLineNumbers.length > 0) {
      section.warnings.push(`lines ${result.leftoverLineNumbers.join(', ')} still mention ${openActionId} or $sub1 outside the subagent.watch markers (added by hand?); remove them yourself if you want`);
    }
  } else {
    const result = applyHerdrSetup(file.text);
    nextText = result.text;
    operations = result.operations;
    describeSetupAnalysis(result.analysis, section);
  }

  if (operations.length === 0) {
    return section;
  }
  const target = resolveWritePath(configPath);
  if (target.error !== null) {
    section.errors.push(`${target.error}; config.toml not modified`);
    return section;
  }
  section.changed = true;
  if (isDryRun) {
    section.lines.push(...describeOperations(operations));
    section.lines.push(`(dry run) would write ${target.path}${describePlannedBackup(configPath, file.existed)}`);
    return section;
  }

  const herdrBinPath = resolveHerdrBinPath(environment);
  if (herdrBinPath === null) {
    section.errors.push(`${herdrNotFoundMessage}; config.toml not modified because it cannot be validated`);
    return section;
  }
  const before = checkHerdrConfig(herdrBinPath, configPath, environment);
  if (!before.didRun) {
    section.errors.push(`cannot run ${herdrBinPath} config check (${before.output}); config.toml not modified`);
    return section;
  }
  if (before.isParseError) {
    section.errors.push(`herdr cannot parse ${configPath} as it is; fix it first. config.toml not modified.`);
    section.errors.push(...before.diagnostics.map((line) => `    ${line}`));
    return section;
  }

  // 新內容先寫成暫存檔、用 HERDR_CONFIG_PATH 讓 herdr 檢查，通過才 rename 過去：原檔在檢查通過前完全不動，不需要事後還原
  const mode = readFileMode(target.path);
  let temporaryPath;
  try {
    temporaryPath = writeTemporaryFile(target.path, nextText, mode);
  } catch (error) {
    section.errors.push(`cannot write a temporary file next to ${target.path}: ${error.message}; config.toml not modified`);
    return section;
  }
  const after = checkHerdrConfig(herdrBinPath, temporaryPath, environment);
  if (!isAcceptableCheck(before, after)) {
    removeQuietly(temporaryPath);
    section.errors.push(`herdr config check failed on the new config, so ${configPath} was not modified:`);
    section.errors.push(...after.output.split('\n').map((line) => `    ${line}`));
    return section;
  }
  let backupLine = null;
  try {
    if (file.existed) {
      backupLine = backUpOnce(configPath, file.text, mode);
    }
    replaceFile(temporaryPath, target.path);
  } catch (error) {
    removeQuietly(temporaryPath);
    section.errors.push(`cannot write ${configPath}: ${error.message}; config.toml not modified`);
    return section;
  }
  section.lines.push(after.isOk ? 'herdr config check: ok' : 'herdr config check: only issues that were already there');
  if (backupLine !== null) {
    section.lines.push(backupLine);
  }
  section.lines.push(...describeSymlinkTarget(configPath, target));
  const reload = runHerdr(herdrBinPath, ['server', 'reload-config'], environment);
  if (reload.status === 0) {
    section.reloaded = true;
    section.lines.push('herdr server reload-config: ok');
  } else {
    section.warnings.push(`herdr server reload-config failed (${reload.error ?? (reload.output || `exit ${reload.status}`)}); run it yourself or restart herdr`);
  }
  return section;
}

function formatReport({ pluginRoot, isRemove, isDryRun, sections }) {
  const lines = [`subagent.watch ${isRemove ? 'remove' : 'setup'}${isDryRun ? ' (dry run, nothing is written)' : ''}`, `plugin: ${pluginRoot}`];
  for (const section of sections) {
    lines.push('', section.title);
    lines.push(...section.lines.map((line) => `  ${line}`));
    lines.push(...section.warnings.map((line) => `  ! ${line}`));
    lines.push(...section.errors.map((line) => `  ERROR ${line}`));
  }
  const hasErrors = sections.some((section) => section.errors.length > 0);
  if (!isRemove && !isDryRun && !hasErrors) {
    lines.push('', `Next: press ${keyBinding} in a pane running Claude Code. Sub agents started from now on show up in the sidebar.`);
  }
  if (isRemove && !isDryRun && !hasErrors) {
    lines.push('', 'Sidebar rows already shown stay until the pane reports again or herdr restarts.');
  }
  return `${lines.join('\n')}\n`;
}

function buildNotification({ isRemove, sections, isAction }) {
  const errorCount = sections.reduce((count, section) => count + section.errors.length, 0);
  const hasWarnings = sections.some((section) => section.warnings.length > 0);
  const detailsHint = isAction ? 'Details: herdr plugin log list --plugin subagent.watch' : 'Details in the terminal output.';
  const verb = isRemove ? 'remove' : 'setup';
  if (errorCount > 0) {
    return { title: `subagent.watch: ${verb} failed`, body: detailsHint };
  }
  if (hasWarnings) {
    return { title: `subagent.watch: ${verb} needs a manual step`, body: detailsHint };
  }
  const isChanged = sections.some((section) => section.changed);
  if (!isChanged) {
    return { title: `subagent.watch: ${isRemove ? 'nothing to remove' : 'already set up'}`, body: detailsHint };
  }
  return { title: `subagent.watch: ${isRemove ? 'removed' : 'set up'}`, body: isRemove ? detailsHint : `Press ${keyBinding} in a Claude Code pane.` };
}

export function runSetup({ argv, environment, pluginRoot = defaultPluginRoot, write = (text) => process.stdout.write(text) }) {
  const options = parseArguments(argv);
  if (options.error !== null) {
    write(`${options.error === '' ? '' : `${options.error}\n`}${usageText}`);
    return options.error === '' ? 0 : 2;
  }
  const context = { environment, pluginRoot, isRemove: options.isRemove, isDryRun: options.isDryRun };
  const sections = [setUpClaudeHooks(context), setUpHerdrConfig(context)];
  write(formatReport({ ...context, sections }));
  if (!options.isDryRun) {
    const herdrBinPath = resolveHerdrBinPath(environment);
    if (herdrBinPath !== null) {
      const isAction = typeof environment.HERDR_PLUGIN_ACTION_ID === 'string' && environment.HERDR_PLUGIN_ACTION_ID !== '';
      const notification = buildNotification({ isRemove: options.isRemove, sections, isAction });
      // 通知只是方便：herdr server 沒在跑（例如在別的終端機跑 CLI）時失敗也無所謂，結果已經印在 stdout
      runHerdr(herdrBinPath, ['notification', 'show', notification.title, '--body', notification.body], environment);
    }
  }
  return sections.some((section) => section.errors.length > 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSetup({ argv: process.argv.slice(2), environment: process.env });
}
