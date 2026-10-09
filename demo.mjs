import readline from 'node:readline';

const isOnceMode = process.argv.includes('--once');
const useColor = Boolean(process.stdout.isTTY);

const toolColumnWidth = 10;
const closeCountdownMs = 3000;
const tickIntervalMs = 200;
const defaultWidth = 80;
const defaultHeight = 24;

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  reverse: '\x1b[7m',
  textMuted: '\x1b[38;2;168;168;168m',
  accentText: '\x1b[38;2;177;142;240m',
  cursorHome: '\x1b[H',
  eraseLine: '\x1b[2K',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  enterAlternateScreen: '\x1b[?1049h',
  leaveAlternateScreen: '\x1b[?1049l',
};

const runningGlyph = '●';
const doneGlyph = '✓';

const summariesByTool = {
  Grep: [
    '"emitKeypressEvents" in src/',
    '"subagent_type" in ~/.claude/projects/ (*.jsonl)',
    '"isSidechain" -n src/watch/',
    '"HERDR_PLUGIN_ID" in **/*.mjs',
    '"TODO\\(popup\\)" in src/tui/',
    '"agentId" in ~/.claude/projects/-var-home/',
  ],
  Glob: [
    '**/*.jsonl in ~/.claude/projects/',
    'src/**/*.test.mjs',
    '.claude/agents/*.md',
    '**/herdr-plugin.toml',
  ],
  Read: [
    'src/watch/transcript.mjs (lines 1-120)',
    'src/tui/tabs.mjs',
    'docs/plugins.mdx (lines 285-330)',
    'package.json',
    'src/agents/registry.mjs',
    'herdr-plugin.toml',
    'src/watch/tail.mjs (lines 40-96)',
  ],
  WebFetch: [
    'https://nodejs.org/api/readline.html#readlineemitkeypresseventsstream-interface',
    'https://github.com/ogulcancelik/herdr-plugin-examples',
    'https://code.claude.com/docs/en/sub-agents',
    'https://docs.example.dev/terminal/ansi-escape-codes',
    'https://nodejs.org/api/tty.html#event-resize',
  ],
  Bash: [
    'git status --short',
    'node --check src/main.mjs',
    'ls -t ~/.claude/projects/-var-home/ | head -5',
    'wc -l session.jsonl',
    'pnpm test --filter watcher',
    'tail -n 20 /tmp/watch-debug.log',
  ],
  Edit: [
    'src/tui/render.mjs (+14 -3)',
    'src/watch/tail.mjs (+6 -1)',
    'src/tui/tabs.mjs (+22 -8)',
    'README.md (+4 -0)',
  ],
  thinking: [
    'planning how to tail the transcript incrementally',
    'comparing popup vs overlay placement',
    'checking edge case: resize while rendering',
    'deciding when to auto-close the viewer',
    'summarizing findings for the parent agent',
  ],
};

const startTimeMs = Date.now();

const subAgents = [
  createSubAgent({
    name: 'Explore',
    toolPool: ['Grep', 'Grep', 'Glob', 'Read', 'Read', 'Read', 'thinking'],
    seedEventCount: 5,
    endAtMs: startTimeMs + 40_000,
  }),
  createSubAgent({
    name: 'claude-code-guide',
    toolPool: ['WebFetch', 'WebFetch', 'Read', 'Grep', 'thinking'],
    seedEventCount: 8,
    endAtMs: startTimeMs,
  }),
  createSubAgent({
    name: 'general-purpose',
    toolPool: ['Bash', 'Bash', 'Edit', 'Read', 'Grep', 'thinking'],
    seedEventCount: 3,
    endAtMs: startTimeMs + 70_000,
  }),
];

let selectedIndex = 0;
let closingAtMs = null;
let lastRenderedSecondsLeft = null;
let tickTimer = null;
let isTerminalRestored = false;

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function createRandomEvent(toolPool, timestampMs) {
  const tool = pickRandom(toolPool);
  return {
    timestampMs,
    tool,
    summary: pickRandom(summariesByTool[tool]),
    isDoneMarker: false,
  };
}

function createSubAgent({ name, toolPool, seedEventCount, endAtMs }) {
  const isDone = endAtMs <= startTimeMs;
  const events = [];
  // Seeded history sits in the past so the first frame already looks mid-run.
  let timestampMs = startTimeMs - seedEventCount * 3_000;
  for (let index = 0; index < seedEventCount; index += 1) {
    timestampMs += randomBetween(1_000, 3_000);
    events.push(createRandomEvent(toolPool, timestampMs));
  }
  if (isDone) {
    events.push({ timestampMs: timestampMs + 500, tool: '', summary: '', isDoneMarker: true });
  }
  return {
    name,
    toolPool,
    events,
    isDone,
    endAtMs,
    nextEventAtMs: startTimeMs + randomBetween(1_000, 3_000),
  };
}

function areAllSubAgentsDone() {
  return subAgents.every((subAgent) => subAgent.isDone);
}

function advanceSimulation(nowMs) {
  let hasChanged = false;
  for (const subAgent of subAgents) {
    if (subAgent.isDone) {
      continue;
    }
    if (nowMs >= subAgent.endAtMs) {
      subAgent.isDone = true;
      subAgent.events.push({ timestampMs: nowMs, tool: '', summary: '', isDoneMarker: true });
      hasChanged = true;
      continue;
    }
    if (nowMs >= subAgent.nextEventAtMs) {
      subAgent.events.push(createRandomEvent(subAgent.toolPool, nowMs));
      subAgent.nextEventAtMs = nowMs + randomBetween(1_000, 3_000);
      hasChanged = true;
    }
  }
  if (closingAtMs === null && areAllSubAgentsDone()) {
    closingAtMs = nowMs + closeCountdownMs;
    hasChanged = true;
  }
  return hasChanged;
}

function formatClock(timestampMs) {
  const date = new Date(timestampMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function segment(text, ...codes) {
  return { text, codes };
}

// Truncates by code point so ANSI codes never get cut in half; every glyph used here is single-width.
function composeLine(segments, width) {
  let output = '';
  let usedWidth = 0;
  for (const { text, codes } of segments) {
    if (usedWidth >= width) {
      break;
    }
    const characters = [...text].slice(0, width - usedWidth);
    usedWidth += characters.length;
    const visibleText = characters.join('');
    if (useColor && codes.length > 0) {
      output += codes.join('') + visibleText + ansi.reset;
    } else {
      output += visibleText;
    }
  }
  return output;
}

function buildTabBar(width) {
  const segments = [segment('◀ ', ansi.textMuted)];
  subAgents.forEach((subAgent, index) => {
    const glyph = subAgent.isDone ? doneGlyph : runningGlyph;
    if (index > 0) {
      segments.push(segment(' '));
    }
    if (index === selectedIndex) {
      segments.push(segment(`[${index + 1} ${subAgent.name} ${glyph}]`, ansi.reverse, ansi.bold));
    } else {
      segments.push(segment(`[${index + 1} ${subAgent.name} `));
      segments.push(segment(glyph, subAgent.isDone ? ansi.textMuted : ansi.accentText));
      segments.push(segment(']'));
    }
  });
  segments.push(segment(' ▶', ansi.textMuted));
  return composeLine(segments, width);
}

function buildSeparator(width) {
  return composeLine([segment('─'.repeat(width), ansi.textMuted)], width);
}

function buildEventLine(event, width) {
  const clockSegment = segment(`${formatClock(event.timestampMs)}  `, ansi.textMuted);
  if (event.isDoneMarker) {
    return composeLine([clockSegment, segment('── done ──', ansi.textMuted)], width);
  }
  const toolSegment = segment(`${event.tool.padEnd(toolColumnWidth)}  `, ansi.bold);
  const summarySegment = event.tool === 'thinking'
    ? segment(event.summary, ansi.textMuted, ansi.italic)
    : segment(event.summary);
  return composeLine([clockSegment, toolSegment, summarySegment], width);
}

function buildBody(width, bodyHeight, nowMs) {
  const selectedSubAgent = subAgents[selectedIndex];
  const statusLineCount = closingAtMs === null ? 0 : 1;
  const eventLineCount = Math.max(0, bodyHeight - statusLineCount);
  const visibleEvents = eventLineCount > 0 ? selectedSubAgent.events.slice(-eventLineCount) : [];
  const lines = visibleEvents.map((event) => buildEventLine(event, width));
  while (lines.length < eventLineCount) {
    lines.push('');
  }
  if (closingAtMs !== null) {
    const secondsLeft = Math.max(0, Math.ceil((closingAtMs - nowMs) / 1000));
    lines.push(composeLine([
      segment(`All sub agents done — closing in ${secondsLeft}s`, ansi.accentText, ansi.bold),
    ], width));
  }
  return lines;
}

function buildFooter(width) {
  return composeLine([
    segment('<-/->', ansi.bold),
    segment(' switch   ', ansi.textMuted),
    segment('1-9', ansi.bold),
    segment(' jump   ', ansi.textMuted),
    segment('q/Esc', ansi.bold),
    segment(' close    ', ansi.textMuted),
    segment(runningGlyph, ansi.accentText),
    segment(' running  ', ansi.textMuted),
    segment(doneGlyph),
    segment(' done', ansi.textMuted),
  ], width);
}

function buildFrame(width, height, nowMs) {
  const bodyHeight = Math.max(1, height - 4);
  const lines = [
    buildTabBar(width),
    buildSeparator(width),
    ...buildBody(width, bodyHeight, nowMs),
    buildSeparator(width),
    buildFooter(width),
  ];
  return lines.slice(0, Math.max(1, height));
}

function render() {
  const width = process.stdout.columns || defaultWidth;
  const height = process.stdout.rows || defaultHeight;
  const lines = buildFrame(width, height, Date.now());
  // Erase each line before drawing instead of erasing after it: a full-width line leaves the
  // cursor in pending-wrap state, where a trailing erase would wipe the last visible character.
  const output = lines.map((line) => ansi.eraseLine + line).join('\r\n');
  process.stdout.write(ansi.cursorHome + output);
}

function restoreTerminal() {
  if (isTerminalRestored) {
    return;
  }
  isTerminalRestored = true;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdout.write(ansi.reset + ansi.showCursor + ansi.leaveAlternateScreen);
}

function shutdown(exitCode) {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  restoreTerminal();
  process.exit(exitCode);
}

function selectSubAgent(index) {
  if (index < 0 || index >= subAgents.length || index === selectedIndex) {
    return;
  }
  selectedIndex = index;
  render();
}

function handleKeypress(text, key) {
  const keyName = key?.name;
  if ((key?.ctrl && keyName === 'c') || keyName === 'q' || keyName === 'escape') {
    shutdown(0);
    return;
  }
  if (keyName === 'left') {
    selectSubAgent((selectedIndex - 1 + subAgents.length) % subAgents.length);
    return;
  }
  if (keyName === 'right') {
    selectSubAgent((selectedIndex + 1) % subAgents.length);
    return;
  }
  if (typeof text === 'string' && /^[1-9]$/.test(text)) {
    selectSubAgent(Number(text) - 1);
  }
}

function tick() {
  const nowMs = Date.now();
  if (closingAtMs !== null && nowMs >= closingAtMs) {
    shutdown(0);
    return;
  }
  let shouldRender = advanceSimulation(nowMs);
  if (closingAtMs !== null) {
    const secondsLeft = Math.ceil((closingAtMs - nowMs) / 1000);
    if (secondsLeft !== lastRenderedSecondsLeft) {
      lastRenderedSecondsLeft = secondsLeft;
      shouldRender = true;
    }
  }
  if (shouldRender) {
    render();
  }
}

function startInteractive() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('demo.mjs needs a TTY for interactive mode; use --once to print a single frame.\n');
    process.exit(1);
  }
  process.on('exit', restoreTerminal);
  process.on('SIGTERM', () => {
    shutdown(0);
  });
  process.on('SIGHUP', () => {
    shutdown(0);
  });

  process.stdout.write(ansi.enterAlternateScreen + ansi.hideCursor);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', handleKeypress);
  process.stdin.resume();
  process.stdout.on('resize', render);

  render();
  tickTimer = setInterval(tick, tickIntervalMs);
}

if (isOnceMode) {
  const width = process.stdout.columns || defaultWidth;
  const height = process.stdout.rows || defaultHeight;
  process.stdout.write(`${buildFrame(width, height, Date.now()).join('\n')}\n`);
} else {
  startInteractive();
}
