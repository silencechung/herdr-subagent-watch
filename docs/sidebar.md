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

Before writing, the hook checks the `subagent-watch` folder: it must belong to your uid, must not be a symlink, and must have mode `0700`. Otherwise nothing is written (and `XDG_RUNTIME_DIR` itself is never created when it is missing).

Both files are written to a temporary file and then `rename`d, so the viewer never reads half-written JSON. The temporary file has a random name and is created with `wx`, so a symlink planted in advance cannot redirect the write to another file.

Read-modify-write for one session is serialized with `session-<id>.json.lock`, so starting several sub agents in parallel loses no data:

- The lock holds the pid of its holder, its start time (field 22 of `/proc/<pid>/stat`) and when it was created. It is written to a temporary file first and then `link`ed into place (like `wx`, this only succeeds when the lock does not exist), so nobody reads a half-written lock.
- A lock is stale when `process.kill(pid, 0)` finds no such process, the process is a zombie, or the pid now belongs to a process with a different start time (pid reuse). An empty lock left by an older version has no pid and becomes stale after 2 seconds; any lock older than 10 seconds is stale (a safety net for when the pid check cannot be trusted; the hook itself finishes in under 1 second).
- Taking over: the hook first claims the name `<lock>.break-<inode>` with `link`, and only removes the lock if it got that name and the lock is still the inode it judged stale. It never removes a fresh lock someone else just created. A `.break-*` file left by a process killed in between is cleared once it is 2 seconds old.
- On release, the lock is removed only if it is still the inode this run created.

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
- herdr limits a token to 80 characters and strips control characters. The hook first removes control characters (`\p{Cc}`) and format characters (`\p{Cf}`, such as the bidi controls U+202A–202E and U+2066–2069 and the zero-width characters U+200B–200F), so an `agent_type` cannot reverse or hide text in the sidebar; one that is too long is truncated with `…`, so `●` always stays at the end of the line.
- herdr is called through `HERDR_BIN_PATH`; only when that is missing is `herdr` looked up on `PATH`, and only in absolute `PATH` entries: an empty entry or a relative one such as `node_modules/.bin` is relative to the current folder, which is the repo the user has open, and a `herdr` placed there must never run. `open-action.mjs`, `scripts/setup.mjs` and the notification in `bin/run.sh` follow the same rule.

### Designed not to disturb Claude sessions

The hook is global and applies to every Claude session:

- It always exits 0 and prints nothing to stdout (herdr's output is sent to `ignore` too), with an overall budget of 800 ms (herdr is killed with `SIGKILL` on timeout); the 5-second timeout in `settings.json` is a safety net.
- No `HERDR_PANE_ID`, no `XDG_RUNTIME_DIR`, or no herdr executable → it writes nothing and exits.
- When `bin/run.sh` cannot find Node.js 22+, it always exits 0 silently for this hook (the other entry points print an error).
- Events with an empty `agent_type` are skipped: Claude Code's internal agents (prompt suggestion, `/btw`) also fire `SubagentStop`.
- A `SubagentStop` without a matching `SubagentStart` seen earlier is skipped.
- The `subagent-watch` folder is not yours, is a symlink, or is not `0700` → nothing is written.
- Events from another Claude session in the same pane are skipped (for example the claude in the pane running `claude -p` through Bash). Child processes inherit the same `HERDR_PANE_ID`; without this check they would overwrite the main session's tree and mapping file. How it decides:
  - It first asks `herdr pane get <pane>` for `agent_session` (reported by herdr's claude integration): only an event whose `session_id` matches updates the sidebar; a different session, or a session of another agent, is skipped. It waits at most 300 ms and never eats into the minimum budget for reporting to herdr.
  - Only when herdr has no `agent_session` (integration not installed, herdr not answering) does it fall back to the ancestor processes: two or more groups of `claude` → skipped. `claude` processes that are direct parent and child count as one group, so a wrapper script named claude that does not `exec` no longer makes every event look nested; commands run by the Bash tool always sit behind a shell, so a nested `claude -p` still counts as a second group.

### Known limitations

- If a session ends or switches to another session while sub agents are still running, the old tree lines stay until the next sub agent event in that pane overwrites them (only `SubagentStart` / `SubagentStop` are hooked, not `SessionStart` / `SessionEnd`).
- If a sub agent's `SubagentStop` is missed (for example the hook gives up on the event after waiting too long for the lock), its line does not go away by itself within the same session (it is removed only when that sub agent gets another `SubagentStop`); after switching sessions, the next sub agent event overwrites it.
- `agent_session` is reported by herdr's claude integration on `SessionStart`; its hook only skips sub agents (events with an `agent_id`), not a nested `claude -p`. If a nested session's report overwrites the pane's `agent_session`, later events of the main session are skipped as another session until the main session's next `SessionStart` (`/clear`, `/resume` and so on). Whether the herdr server rejects such a report has not been verified.
- The ancestor fallback cannot tell `exec claude -p` apart (the nested claude is then a direct child of the main claude and counts as the same group).
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

Setup and remove recognize their own hook by the whole `command`: it must be exactly the form above (`run.sh` and `hooks/sidebar-hook.mjs` under the same absolute plugin folder), or the older hand-written form from before the launcher, `<absolute node path> <absolute path>/hooks/sidebar-hook.mjs` (setup upgrades it in place). Another tool's hook that merely has a file named `sidebar-hook.mjs` is neither changed nor removed. None of the hook fields listed in the official Claude Code hooks docs can carry an identifier, so the command is the only thing to compare.

How the files are written:

- Before a change, each file is backed up to `<file name>.subagent-watch.bak` in the same folder, **only the first time**: an existing `.bak` is never overwritten, so the earliest original is kept (delete the old `.bak` yourself if you want a fresh one).
- When a config file is a symlink (for example into a dotfiles repo), the real file it points to is written and the symlink stays; a symlink to a missing file is reported and left alone.
- The new `config.toml` is first written to a temporary file next to the real file and checked with `herdr config check` through `HERDR_CONFIG_PATH`; only when that passes is it `rename`d into place. If the check fails the temporary file is deleted and the original was never touched, so there is nothing to restore.
- `settings.json` keeps its indentation, line endings (CRLF stays CRLF) and trailing newline; remove does not write the file when there is nothing to remove.

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

1. Run `herdr plugin action invoke subagent.watch.remove` (or `sh bin/run.sh scripts/setup.mjs --remove`): it removes this plugin's hooks from `settings.json` (recognized as described in "What setup adds") and the content between the markers in `config.toml`, then runs `herdr server reload-config`.
2. Settings added by hand without markers have to be removed yourself: in `settings.json`, delete the entry whose `command` points at `sidebar-hook.mjs` (if the array becomes empty, remove the whole key); in `config.toml`, delete the `[[keys.command]]` block for `prefix+.` and `$sub1`…`$sub5` from the `claude` rows, then run `herdr server reload-config`.
3. Clear tokens left on panes (run once for each pane that has claude):

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch --seq "$(date +%s%3N)" \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

4. The state files are in `$XDG_RUNTIME_DIR/subagent-watch/`. They are cleared automatically on reboot, or you can delete that folder by hand.

## Tests

```
node --test test/sidebar*.test.mjs test/security-*.test.mjs
```

Covers payload parsing, state updates (stop removes the entry, a stop without a seen start is skipped, old `done` entries are dropped), tree lines (start two → stop one leaves `└─` → stop all clears everything, `+N more` counts only running ones, 80-character truncation, bidi and zero-width characters removed), increasing seq, staying silent outside herdr, falling back to herdr on `PATH` when `HERDR_BIN_PATH` is missing (relative `PATH` entries excluded), deciding the pane session from `agent_session` (a wrapper named claude still updates, a nested `claude -p` is skipped, tested with a real process tree), the state folder checks (symlink, mode, owner, planted symlinks), the lock (stale detection, taking over without removing someone else's fresh lock, several hooks racing for one stale lock lose no data), no data loss with parallel starts, and running the script for real with a fake herdr executable (checking exit 0, empty stdout, and finishing within 1 second).
