import path from 'node:path';
import { getClaudeProjectsDirectory } from './lib/claude-config.mjs';
import { createDemoSource } from './lib/demo.mjs';
import { resolveHerdrBinPath } from './lib/herdr.mjs';
import { createKeyDecoder } from './lib/keys.mjs';
import { ansi, buildEventLayout, buildFrame, buildTabLabels, describeEndReason, emptySessionMessage, getBodyHeight } from './lib/render.mjs';
import { applyScrollKey, createScrollState, resolveScrollView } from './lib/scroll.mjs';
import { describeNonClaudePane, parseContextJson, resolveSession } from './lib/session.mjs';
import { getSubAgentStatus } from './lib/subagent-state.mjs';
import { createSessionWatcher, getSessionPaths } from './lib/watcher.mjs';

const defaultWidth = 80;
const defaultHeight = 24;
const statusTickMs = 1000;
const resolveRetryMs = 2000;
const unresolvedMessage = 'No Claude Code session found for this pane';
const usageText = 'Usage: viewer.mjs [--once] [--demo | --session <transcript.jsonl>]\n';

function parseArguments(argv) {
  const options = { isOnce: false, isDemo: false, sessionPath: null, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--once') {
      options.isOnce = true;
    } else if (argument === '--demo') {
      options.isDemo = true;
    } else if (argument === '--session') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        options.error = '--session needs a transcript path';
        break;
      }
      options.sessionPath = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('--session=')) {
      options.sessionPath = path.resolve(argument.slice('--session='.length));
    } else if (argument === '--help' || argument === '-h') {
      options.error = '';
    } else {
      options.error = `unknown argument: ${argument}`;
      break;
    }
  }
  if (options.isDemo && options.sessionPath !== null) {
    options.error = '--demo and --session cannot be combined';
  }
  return options;
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') ?? null;
}

function resolveFromEnvironment(environment) {
  const context = parseContextJson(environment.HERDR_PLUGIN_CONTEXT_JSON);
  // popup 沒有 HERDR_PANE_ID；open action 會把觸發時的 pane 用 env 傳進來，context 的 focused_pane_id 是第二來源
  const paneId = pickString(environment.SUBAGENT_WATCH_PANE_ID, context.focused_pane_id, environment.HERDR_PANE_ID);
  const isPluginProcess = pickString(environment.HERDR_PLUGIN_ID) !== null;
  return resolveSession({
    paneId,
    contextCwd: pickString(context.focused_pane_cwd),
    // plugin process 的 cwd 是 plugin 資料夾，拿來猜 session 一定錯
    fallbackCwd: isPluginProcess ? null : process.cwd(),
    projectsDirectory: getClaudeProjectsDirectory(environment),
    runtimeDirectory: environment.XDG_RUNTIME_DIR,
    herdrBinPath: resolveHerdrBinPath(environment),
  });
}

function getUnresolvedMessages(session) {
  if (session?.nonClaudePane) {
    return [describeNonClaudePane(session.nonClaudePane)];
  }
  return [unresolvedMessage, ...(session?.notes ?? [])];
}

function describeSession(session) {
  if (session === null || session.transcriptPath === null) {
    return 'no session';
  }
  const shortId = session.sessionId.slice(0, 8);
  if (session.isGuessed) {
    return `session ${shortId} (guessed: latest session)`;
  }
  return `session ${shortId}`;
}

function createController({ options, environment, onChange }) {
  let session = null;
  let source = null;
  let selectedAgentId = null;
  let lastResolveAttemptMs = 0;
  const scrollStatesByAgentId = new Map();

  function attachSource(nextSession) {
    const previousPath = session?.transcriptPath ?? null;
    session = nextSession;
    if (session.transcriptPath === previousPath && source !== null) {
      return;
    }
    source?.stop();
    source = null;
    selectedAgentId = null;
    scrollStatesByAgentId.clear();
    if (session.transcriptPath !== null) {
      source = createSessionWatcher({ transcriptPath: session.transcriptPath, onChange });
    }
  }

  function resolveNow() {
    lastResolveAttemptMs = Date.now();
    if (options.sessionPath !== null) {
      const { sessionId } = getSessionPaths(options.sessionPath);
      attachSource({ transcriptPath: options.sessionPath, sessionId, source: 'manual', isGuessed: false, isTranscriptMissing: false, notes: [] });
      return;
    }
    attachSource(resolveFromEnvironment(environment));
  }

  if (options.isDemo) {
    session = { transcriptPath: 'demo', sessionId: 'demo', source: 'demo', isGuessed: false, isTranscriptMissing: false, notes: [] };
    source = createDemoSource({ onChange });
  } else {
    resolveNow();
  }

  function getSessionLabel() {
    if (options.isDemo) {
      return 'demo data';
    }
    return describeSession(session);
  }

  function getTabs(nowMs) {
    const subAgents = source?.getSubAgents() ?? [];
    const labels = buildTabLabels(subAgents);
    return subAgents.map((subAgent, index) => {
      const status = getSubAgentStatus(subAgent, nowMs);
      const events = status.isDone
        ? [...subAgent.events, { kind: 'end', timestampMs: status.atMs, tool: '', summary: describeEndReason(status.reason) }]
        : subAgent.events;
      return { agentId: subAgent.agentId, label: labels[index], isDone: status.isDone, events };
    });
  }

  // 第一次有 tab 時選最新一個跑中的（沒有就選最新的）；之後跟著 agentId 走，新 tab 插進來不會換掉目前看的
  function getSelectedIndex(tabs) {
    if (tabs.length === 0) {
      selectedAgentId = null;
      return 0;
    }
    let index = tabs.findIndex((tab) => tab.agentId === selectedAgentId);
    if (index === -1) {
      index = tabs.findLastIndex((tab) => !tab.isDone);
      if (index === -1) {
        index = tabs.length - 1;
      }
      selectedAgentId = tabs[index].agentId;
    }
    return index;
  }

  function getScrollState(agentId) {
    let scrollState = scrollStatesByAgentId.get(agentId);
    if (scrollState === undefined) {
      scrollState = createScrollState();
      scrollStatesByAgentId.set(agentId, scrollState);
    }
    return scrollState;
  }

  return {
    start() {
      source?.start();
    },
    stop() {
      source?.stop();
    },
    refresh() {
      source?.refresh();
    },
    tick() {
      const needsResolve = !options.isDemo && (session === null || session.isTranscriptMissing);
      if (needsResolve && Date.now() - lastResolveAttemptMs >= resolveRetryMs) {
        const previousPath = session?.transcriptPath ?? null;
        resolveNow();
        if (source !== null && session.transcriptPath !== previousPath) {
          source.start();
        }
      }
    },
    moveSelection(step) {
      const tabs = getTabs(Date.now());
      if (tabs.length < 2) {
        return false;
      }
      const index = getSelectedIndex(tabs);
      selectedAgentId = tabs[(index + step + tabs.length) % tabs.length].agentId;
      return true;
    },
    // 回傳 key 是不是捲動鍵；只動目前選取的 tab，其他 tab 的位置各自留著
    // width 要和畫面用的一樣：捲動以折行後的畫面行為單位
    scroll(key, width, height) {
      const tabs = getTabs(Date.now());
      if (tabs.length === 0) {
        return false;
      }
      const tab = tabs[getSelectedIndex(tabs)];
      return applyScrollKey(getScrollState(tab.agentId), key, buildEventLayout(tab.events, width), getBodyHeight(height));
    },
    buildLines(width, height, useColor) {
      const nowMs = Date.now();
      const tabs = getTabs(nowMs);
      const selectedIndex = getSelectedIndex(tabs);
      const hasSession = options.isDemo || (session !== null && session.transcriptPath !== null);
      const messages = hasSession ? [emptySessionMessage] : getUnresolvedMessages(session);
      let scrollView = null;
      let layout = null;
      if (tabs.length > 0) {
        const tab = tabs[selectedIndex];
        layout = buildEventLayout(tab.events, width);
        scrollView = resolveScrollView(getScrollState(tab.agentId), layout, getBodyHeight(height));
      }
      return buildFrame({ tabs, selectedIndex, width, height, useColor, sessionLabel: getSessionLabel(), messages, scrollView, layout });
    },
  };
}

function runOnce(controller) {
  controller.refresh();
  const width = process.stdout.columns || defaultWidth;
  const height = process.stdout.rows || defaultHeight;
  const lines = controller.buildLines(width, height, Boolean(process.stdout.isTTY));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function runInteractive(controller, setOnChange) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('viewer.mjs needs a TTY for interactive mode; use --once to print a single frame.\n');
    process.exit(1);
  }
  let lastOutput = '';
  let isTerminalRestored = false;
  let scheduledRender = null;
  let tickTimer = null;

  function render(isForced = false) {
    const width = process.stdout.columns || defaultWidth;
    const height = process.stdout.rows || defaultHeight;
    const lines = controller.buildLines(width, height, true);
    // 先清行再畫，不要畫完再清：滿版的行會讓游標停在 pending-wrap 狀態，這時往後清會吃掉最後一個字
    const output = lines.map((line) => ansi.eraseLine + line).join('\r\n');
    if (!isForced && output === lastOutput) {
      return;
    }
    lastOutput = output;
    process.stdout.write((isForced ? ansi.eraseScreen : '') + ansi.cursorHome + output);
  }

  function scheduleRender() {
    if (scheduledRender !== null) {
      return;
    }
    scheduledRender = setTimeout(() => {
      scheduledRender = null;
      render();
    }, 16);
  }

  function restoreTerminal() {
    if (isTerminalRestored) {
      return;
    }
    isTerminalRestored = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    // mouse reporting 沒關的話，離開後 shell 會收到一堆滾輪／點擊的 escape sequence
    process.stdout.write(ansi.disableMouse + ansi.reset + ansi.showCursor + ansi.leaveAlternateScreen);
  }

  function shutdown(exitCode) {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
    }
    controller.stop();
    restoreTerminal();
    process.exit(exitCode);
  }

  const keyDecoder = createKeyDecoder((key) => {
    if (key === 'q' || key === 'escape' || key === 'ctrl-c') {
      shutdown(0);
      return;
    }
    if (key === 'left' && controller.moveSelection(-1)) {
      render();
      return;
    }
    if (key === 'right' && controller.moveSelection(1)) {
      render();
      return;
    }
    if (controller.scroll(key, process.stdout.columns || defaultWidth, process.stdout.rows || defaultHeight)) {
      render();
    }
  });

  setOnChange(scheduleRender);
  process.on('exit', restoreTerminal);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    process.on(signal, () => {
      shutdown(0);
    });
  }
  process.on('uncaughtException', (error) => {
    restoreTerminal();
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });

  process.stdout.write(ansi.enterAlternateScreen + ansi.hideCursor + ansi.enableMouse);
  process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk) => {
    keyDecoder.feed(chunk);
  });
  process.stdin.resume();
  process.stdout.on('resize', () => {
    render(true);
  });

  controller.start();
  render(true);
  tickTimer = setInterval(() => {
    controller.tick();
    render();
  }, statusTickMs);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.error !== null) {
    if (options.error !== '') {
      process.stderr.write(`${options.error}\n`);
    }
    process.stderr.write(usageText);
    process.exit(options.error === '' ? 0 : 2);
  }
  let notifyChange = () => {};
  const controller = createController({
    options,
    environment: process.env,
    onChange: () => {
      notifyChange();
    },
  });
  if (options.isOnce) {
    runOnce(controller);
    return;
  }
  runInteractive(controller, (callback) => {
    notifyChange = callback;
  });
}

main();
