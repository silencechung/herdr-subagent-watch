import { compareSubAgents, createSubAgentState } from './subagent-state.mjs';
import { thinkingLabel } from './transcript.mjs';

const tickIntervalMs = 200;

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
    'src/watch/transcript.mjs',
    'src/tui/tabs.mjs',
    'docs/plugins.mdx',
    'package.json',
    'src/agents/registry.mjs',
    'herdr-plugin.toml',
    'src/watch/tail.mjs',
  ],
  WebFetch: [
    'https://nodejs.org/api/readline.html#readlineemitkeypresseventsstream-interface',
    'https://github.com/ogulcancelik/herdr-plugin-examples',
    'https://code.claude.com/docs/en/sub-agents',
    'https://nodejs.org/api/tty.html#event-resize',
  ],
  Bash: [
    'git status --short',
    'node --check src/main.mjs',
    'ls -t ~/.claude/projects/-var-home/ | head -5',
    'wc -l session.jsonl',
    'node --test test/',
    'tail -n 20 /tmp/watch-debug.log',
    'node --test test/lib-render.test.mjs test/lib-scroll.test.mjs test/lib-text.test.mjs test/lib-transcript.test.mjs test/viewer.test.mjs',
    "cat <<'EOF' > /tmp/watch-notes.md\n# 折行測試\n\n- 摘要太長時折到下一行，續行對齊摘要欄\n- 多行指令保留原本的換行\nEOF",
  ],
  Edit: [
    'src/tui/render.mjs',
    'src/watch/tail.mjs',
    'src/tui/tabs.mjs',
    'README.md',
  ],
};

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function createRandomEvent(toolPool, timestampMs) {
  const tool = pickRandom(toolPool);
  if (tool === 'thinking') {
    return { kind: 'thinking', toolUseId: null, timestampMs, tool: thinkingLabel, summary: '' };
  }
  return { kind: 'tool', toolUseId: null, timestampMs, tool, summary: pickRandom(summariesByTool[tool]) };
}

function createDemoSubAgent({ agentId, agentType, description, toolPool, seedEventCount, startAtMs, endAtMs, nowMs }) {
  const state = createSubAgentState({ agentId, discoveredAtMs: startAtMs });
  state.agentType = agentType;
  state.description = description;
  state.startedAtMs = startAtMs;
  state.toolPool = toolPool;
  state.endAtMs = endAtMs;
  // 預先塞一段過去的紀錄，第一個畫面就像跑到一半；筆數比一個畫面多，才有東西可以往上捲
  let timestampMs = Math.min(startAtMs, nowMs) - seedEventCount * 3_000;
  if (startAtMs <= nowMs) {
    for (let index = 0; index < seedEventCount; index += 1) {
      timestampMs += randomBetween(1_000, 3_000);
      state.events.push(createRandomEvent(toolPool, timestampMs));
    }
  }
  state.lastActivityMs = state.events.at(-1)?.timestampMs ?? null;
  state.lastWriteMs = nowMs;
  state.nextEventAtMs = nowMs + randomBetween(1_000, 3_000);
  if (endAtMs <= nowMs) {
    state.endSignalMs = timestampMs + 500;
    state.endReason = 'handback';
  }
  return state;
}

export function createDemoSource({ onChange = () => {}, now = Date.now } = {}) {
  const startMs = now();
  const plans = [
    {
      agentId: 'demo-explore',
      agentType: 'Explore',
      description: 'Find transcript tail helpers',
      toolPool: ['Grep', 'Grep', 'Glob', 'Read', 'Read', 'Read', 'thinking'],
      seedEventCount: 40,
      startAtMs: startMs - 2,
      endAtMs: startMs + 40_000,
    },
    {
      agentId: 'demo-guide',
      agentType: 'claude-code-guide',
      description: 'Look up sub agent docs',
      toolPool: ['WebFetch', 'WebFetch', 'Read', 'Grep', 'thinking'],
      seedEventCount: 30,
      startAtMs: startMs - 1,
      endAtMs: startMs,
    },
    {
      agentId: 'demo-general-1',
      agentType: 'general-purpose',
      description: 'Implement popup viewer',
      toolPool: ['Bash', 'Bash', 'Edit', 'Read', 'Grep', 'thinking'],
      seedEventCount: 60,
      startAtMs: startMs,
      endAtMs: startMs + 70_000,
    },
    {
      // 晚幾秒才出現，示範新 sub 即時多一個 tab
      agentId: 'demo-general-2',
      agentType: 'general-purpose',
      description: 'Write README',
      toolPool: ['Read', 'Edit', 'Bash', 'thinking'],
      seedEventCount: 0,
      startAtMs: startMs + 8_000,
      endAtMs: startMs + 50_000,
    },
  ];
  const subAgents = [];
  const pendingPlans = [];
  for (const plan of plans) {
    if (plan.startAtMs <= startMs) {
      subAgents.push(createDemoSubAgent({ ...plan, nowMs: startMs }));
    } else {
      pendingPlans.push(plan);
    }
  }
  let tickTimer = null;

  function refresh() {
    const nowMs = now();
    let hasChanged = false;
    for (let index = pendingPlans.length - 1; index >= 0; index -= 1) {
      if (nowMs >= pendingPlans[index].startAtMs) {
        subAgents.push(createDemoSubAgent({ ...pendingPlans[index], nowMs }));
        pendingPlans.splice(index, 1);
        hasChanged = true;
      }
    }
    for (const subAgent of subAgents) {
      subAgent.lastWriteMs = nowMs;
      if (subAgent.endSignalMs !== null) {
        continue;
      }
      if (nowMs >= subAgent.endAtMs) {
        subAgent.events.push({ kind: 'tool', toolUseId: null, timestampMs: nowMs, tool: 'SubagentHandback', summary: 'report delivered' });
        subAgent.lastActivityMs = nowMs;
        subAgent.endSignalMs = nowMs;
        subAgent.endReason = 'handback';
        hasChanged = true;
        continue;
      }
      if (nowMs >= subAgent.nextEventAtMs) {
        subAgent.events.push(createRandomEvent(subAgent.toolPool, nowMs));
        subAgent.lastActivityMs = nowMs;
        subAgent.nextEventAtMs = nowMs + randomBetween(1_000, 3_000);
        hasChanged = true;
      }
    }
    return hasChanged;
  }

  return {
    refresh,
    start() {
      tickTimer = setInterval(() => {
        if (refresh()) {
          onChange();
        }
      }, tickIntervalMs);
    },
    stop() {
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    },
    getSubAgents() {
      return [...subAgents].sort(compareSubAgents);
    },
  };
}
