# Sidebar sub agent tree

English | [繁體中文](sidebar.zh-TW.md)

Under the claude row of the herdr sidebar, up to 5 lines show the sub agents of that session that are **still running**:

```
<state_icon> <workspace> · <tab>
claude
├─ Explore ●
├─ general-purpose ●
└─ Plan ●
```

- Only running sub agents (`●`) are listed, without numbers. When a sub agent ends (`SubagentStop`), its line is removed, the rest move up, and `├─` / `└─` are recomputed every time.
- With no running sub agent, the sidebar shows only the claude row.
- The sidebar keeps no history: finished sub agents and what they did are in the popup viewer (`prefix+.`), see the [README](../README.md).

## How it works

1. When Claude Code starts or ends a sub agent, it fires the `SubagentStart` / `SubagentStop` hook. `bin/run.sh` finds node and runs `hooks/sidebar-hook.mjs`; the payload arrives on stdin.
2. The hook updates its state file, then calls `herdr pane report-metadata` to write the tree lines into pane tokens `sub1`…`sub5`.
3. `rows_by_agent.claude` in `config.toml` has five extra lines, `$sub1`…`$sub5`. The herdr docs state that a token that has not been reported makes its whole line disappear, so normally no empty lines show.

### Hook input (tested 2026-10-10 with `claude -p` 2.1.296)

| Field | SubagentStart | SubagentStop |
| --- | --- | --- |
| `hook_event_name` | ✓ | ✓ |
| `session_id`, `transcript_path`, `cwd`, `prompt_id` | ✓ | ✓ |
| `agent_id` (e.g. `a12e8c491ce2f7f4a`, no `agent-` prefix) | ✓ | ✓ |
| `agent_type` (e.g. `general-purpose`) | ✓ | ✓ |
| `permission_mode`, `effort`, `stop_hook_active`, `agent_transcript_path`, `background_tasks`, `session_crons` | | ✓ |

The official docs say `SubagentStop` has `last_assistant_message`; it was not there in that test. This hook does not use it.

The hook process inherits Claude Code's environment variables: `HERDR_PANE_ID` (e.g. `w8:pV`), `HERDR_BIN_PATH` and `XDG_RUNTIME_DIR` were all present in testing. Sample payloads are in `test/fixtures/sidebar/`.

### Files written (`$XDG_RUNTIME_DIR/subagent-watch/`, tmpfs, cleared on reboot)

- `session-<sessionId>.json`: `{ sessionId, lastSequence, subagents: [{ id, agentType, startedAtMs }] }`, where `subagents` holds only running sub agents. `SubagentStop` removes the entry, so the file size depends only on how many sub agents run at the same time and does not keep growing.
  - Entries left by an older version with `status` `"done"` are dropped the next time an event reads the file.
  - A `SubagentStart` for a sub agent that is still in the list keeps a single entry (with its original start order); a `SubagentStart` for one that has already been removed (resume) adds it again at the end.
- `pane-<HERDR_PANE_ID>.json`: the mapping file the popup viewer reads. **The contract is fixed**: `{"sessionId","transcriptPath","cwd","updatedAtMs"}`.

Both are written to a temporary file and then `rename`d, so the viewer never reads half-written JSON. Read-modify-write for one session is serialized with `session-<id>.json.lock` (`open` with the `wx` flag), so starting several sub agents in parallel loses no data; a lock held for more than 2 seconds is treated as stale.

### Reporting to herdr

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token sub1=├─ Explore ● --token sub2=└─ Plan ● \
  --clear-token sub3 --clear-token sub4 --clear-token sub5
```

When the last running sub agent ends, all five tokens are cleared with `--clear-token`.

- Only one source, `subagent.watch`, is used: herdr allows at most 32 sequenced sources per pane for its whole lifetime, and clearing one does not give it back.
- `--seq` is `Date.now()`; for several events in the same millisecond it uses "previous + 1", so it always increases (herdr ignores an older seq).
- Order: by start time. With more than 5 running, the fifth line becomes `└─ +N more`, where N counts only running sub agents that are not listed.
- herdr limits a token to 80 characters and strips control characters: an `agent_type` that is too long is truncated with `…`, so `●` always stays at the end of the line.
- herdr is called through `HERDR_BIN_PATH`; only when that is missing is `herdr` looked up on `PATH`.

### Designed not to disturb Claude sessions

The hook is global and applies to every Claude session:

- It always exits 0 and prints nothing to stdout (herdr's output is sent to `ignore` too), with an overall budget of 800 ms (herdr is killed with `SIGKILL` on timeout); the 5-second timeout in `settings.json` is a safety net.
- No `HERDR_PANE_ID`, no `XDG_RUNTIME_DIR`, or no herdr executable → it writes nothing and exits.
- When `bin/run.sh` cannot find Node.js 22+, it always exits 0 silently for this hook (the other entry points print an error).
- Events with an empty `agent_type` are skipped: Claude Code's internal agents (prompt suggestion, `/btw`) also fire `SubagentStop`.
- A `SubagentStop` without a matching `SubagentStart` seen earlier is skipped.
- Two or more `claude` processes among the ancestors (for example the claude in the pane running `claude -p` through Bash) → skipped. Child processes inherit the same `HERDR_PANE_ID`; without this check they would overwrite the main session's tree and mapping file.

### Known limitations

- If a session ends or switches to another session while sub agents are still running, the old tree lines stay until the next sub agent event in that pane overwrites them (only `SubagentStart` / `SubagentStop` are hooked, not `SessionStart` / `SessionEnd`).
- If a sub agent's `SubagentStop` is missed (for example the hook gives up on the event after waiting too long for the lock), its line does not go away by itself within the same session (it is removed only when that sub agent gets another `SubagentStop`); after switching sessions, the next sub agent event overwrites it.
- `●` and `─` are ambiguous width characters; their actual width depends on the terminal settings.

## What setup adds

Written by the `subagent.watch.setup` action (or `sh bin/run.sh scripts/setup.mjs`). For the rules and conflict handling, see [Setup](../README.md#setup) in the README.

Under `hooks` in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` (other settings are untouched):

```json
"SubagentStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "sh \"<plugin dir>/bin/run.sh\" \"<plugin dir>/hooks/sidebar-hook.mjs\"",
        "timeout": 5
      }
    ]
  }
],
"SubagentStop": [ same as above ]
```

`<plugin dir>` is the absolute path of the plugin when setup runs (the managed checkout from `herdr plugin install`, or the folder given to `herdr plugin link`). node is not written into the command; `bin/run.sh` looks it up every time.

Added to `config.toml` (`$HERDR_CONFIG_PATH`, or `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml` when that is not set), each block wrapped between `# >>> subagent.watch` and `# <<< subagent.watch`:

```toml
[[keys.command]]
key = "prefix+."
type = "plugin_action"
command = "subagent.watch.open"
description = "sub agent viewer"

[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$sub1", bold = true, dim = false }],
  [{ token = "$sub2", bold = true, dim = false }],
  [{ token = "$sub3", bold = true, dim = false }],
  [{ token = "$sub4", bold = true, dim = false }],
  [{ token = "$sub5", bold = true, dim = false }],
]
```

The first two rows are the default rows from the herdr docs. `rows_by_agent` replaces `rows` entirely instead of appending to it, so the two default rows have to be included. If you customized `rows` under `[ui.sidebar.agents]`, the claude row goes back to these two rows (setup warns you about this).

`$sub*` uses an inline style table and is always `bold`: the sidebar only shows running sub agents, so there is no status to tell apart.

- No `fg`: colors follow the herdr theme entirely, so switching themes needs no change to these five lines.
- `dim = false`: the herdr docs state that fields left out inherit the token's contextual style, and only an explicit `false` removes that modifier. This makes sure the tree lines are never drawn dim.

Older versions of setup also wrote `rules = [{ contains = "✓", bold = false }]` on each line. `✓` no longer appears, so that rule does nothing if it is still there. Setup treats claude rows that already contain `$sub1` as configured and does not rewrite them; to remove the rule, delete it yourself, or (if it is inside the markers) run remove and then setup again.

## How to remove

1. Run `herdr plugin action invoke subagent.watch.remove` (or `sh bin/run.sh scripts/setup.mjs --remove`): it removes the hooks in `settings.json` that point at `sidebar-hook.mjs` and the content between the markers in `config.toml`, then runs `herdr server reload-config`.
2. Settings added by hand without markers have to be removed yourself: in `settings.json`, delete the entry whose `command` points at `sidebar-hook.mjs` (if the array becomes empty, remove the whole key); in `config.toml`, delete the `[[keys.command]]` block for `prefix+.` and `$sub1`…`$sub5` from the `claude` rows, then run `herdr server reload-config`.
3. Clear tokens left on panes (run once for each pane that has claude):

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch --seq "$(date +%s%3N)" \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

4. The state files are in `$XDG_RUNTIME_DIR/subagent-watch/`. They are cleared automatically on reboot, or you can delete that folder by hand.

## Tests

```
node --test test/sidebar*.test.mjs
```

Covers payload parsing, state updates (stop removes the entry, a stop without a seen start is skipped, old `done` entries are dropped), tree lines (start two → stop one leaves `└─` → stop all clears everything, `+N more` counts only running ones, 80-character truncation), increasing seq, staying silent outside herdr, falling back to herdr on `PATH` when `HERDR_BIN_PATH` is missing, skipping nested `claude -p`, no data loss with parallel starts, and running the script for real with a fake herdr executable (checking exit 0, empty stdout, and finishing within 1 second).
