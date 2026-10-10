import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { herdrNotFoundMessage, resolveHerdrBinPath } from './lib/herdr.mjs';

const viewerEntrypointId = 'viewer';

function parseContext(text) {
  if (typeof text !== 'string' || text === '') {
    return {};
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') ?? null;
}

const environment = process.env;
const herdrBinPath = resolveHerdrBinPath(environment);
const pluginId = pickString(environment.HERDR_PLUGIN_ID) ?? 'subagent.watch';
const context = parseContext(environment.HERDR_PLUGIN_CONTEXT_JSON);
const paneId = pickString(context.focused_pane_id, environment.HERDR_PANE_ID);

const openArguments = ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', viewerEntrypointId];
// popup 本身拿不到 HERDR_PANE_ID，先把按下快捷鍵當下的 pane 交給 viewer，不依賴 popup 的 context 長什麼樣
if (paneId !== null) {
  openArguments.push('--env', `SUBAGENT_WATCH_PANE_ID=${paneId}`);
}

const stateDirectory = pickString(environment.HERDR_PLUGIN_STATE_DIR);
const hasDryRunFile = stateDirectory !== null && fs.existsSync(path.join(stateDirectory, 'dry-run'));
const isDryRun = hasDryRunFile || process.argv.includes('--dry-run');

if (isDryRun) {
  const entry = {
    timestamp: new Date().toISOString(),
    pluginId,
    actionId: environment.HERDR_PLUGIN_ACTION_ID ?? null,
    paneIdEnvironment: environment.HERDR_PANE_ID ?? null,
    stateDirectory,
    context,
    herdrBinPath,
    wouldRun: [herdrBinPath ?? 'herdr', ...openArguments],
  };
  const line = `${JSON.stringify(entry)}\n`;
  if (stateDirectory !== null) {
    fs.appendFileSync(path.join(stateDirectory, 'open-action.log'), line);
  }
  process.stdout.write(line);
  process.exit(0);
}

if (herdrBinPath === null) {
  process.stderr.write(`${herdrNotFoundMessage}\n`);
  process.exit(1);
}

const result = spawnSync(herdrBinPath, openArguments, { stdio: ['ignore', 'inherit', 'inherit'] });
if (result.error) {
  process.stderr.write(`failed to run ${herdrBinPath}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
