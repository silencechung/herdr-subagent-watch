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
- A sub agent that ended without a `SubagentStop` (for example one stopped by an API error such as a usage limit) is removed at the next hook event of that session, at the latest when the main session finishes its turn (`Stop`, or `StopFailure` when that turn itself ends with an API error). See [Sub agents that ended without SubagentStop](#sub-agents-that-ended-without-subagentstop).
- When the pane switches to another session (a new `claude`, `/clear`, `/resume`), the tree is redrawn for that session right away (`SessionStart`); a session without running sub agents clears it.
- With no running sub agent, the sidebar shows only the claude row.
- The sidebar keeps no history: finished sub agents and what they did are in the popup viewer (`prefix+.`), see the [README](../README.md).

## How it works

1. Claude Code fires the `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` and `StopFailure` hooks. All five run the same command: `bin/run.sh` finds node and runs `hooks/sidebar-hook.mjs`; the payload arrives on stdin and `hook_event_name` tells the events apart.
2. The hook updates its state file, then calls `herdr pane report-metadata` to write the tree lines into pane tokens `sub1`…`sub5`.
   - `SessionStart`: writes the pane map (marked as written at session start, see below) and always redraws the tree from that session's state.
   - `SubagentStart` / `SubagentStop`: adds / removes the sub agent and writes the pane map.
   - `Stop` (the main session finished a turn) and `StopFailure` (the turn ended with an API error instead, such as a usage limit): only remove sub agents that have ended and redraw when something was removed. They never write the pane map.
   - Every event first checks the session's other sub agents and removes the ones that have ended (see [below](#sub-agents-that-ended-without-subagentstop)).
3. `rows_by_agent.claude` in `config.toml` has five extra lines, `$sub1`…`$sub5`. The herdr docs state that a token that has not been reported makes its whole line disappear, so normally no empty lines show.

### Hook input (tested 2026-10-10 with `claude -p` 2.1.296)

| Field | SessionStart | SubagentStart | SubagentStop | Stop |
| --- | --- | --- | --- | --- |
| `hook_event_name`, `session_id`, `transcript_path`, `cwd` | ✓ | ✓ | ✓ | ✓ |
| `source` (`startup`, `resume`) | ✓ | | | |
| `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` | only `resume` | | | |
| `prompt_id` | | ✓ | ✓ | ✓ |
| `agent_id` (e.g. `a12e8c491ce2f7f4a`, no `agent-` prefix) | | ✓ | ✓ | |
| `agent_type` (e.g. `general-purpose`) | | ✓ | ✓ | |
| `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | | | ✓ | ✓ |
| `agent_transcript_path` | | | ✓ | |

- `SessionStart`: the official [hooks docs](https://code.claude.com/docs/en/hooks) list `source` as `startup`, `resume` (`--resume`, `--continue`, `/resume`), `clear` (`/clear`), `compact` and `fork`, and optional `model`, `agent_type` (with `claude --agent <name>`) and `session_title`. Only `startup` and `resume` were tested (with `-p`); `/clear` and `/resume` in an interactive session cannot be tested with `-p` and are **not tested on this machine**. An unknown `source` is recorded as `unknown`. `--resume <id>` kept the same `session_id`. With `startup`, the transcript did not exist yet when the hook ran; it is written after the first prompt.
- `Stop`: per the official docs it fires when Claude finishes responding; when a turn ends because of an API error, `StopFailure` fires instead.
- `StopFailure`: **not tested on this machine** (it needs a real API error); the fields come from the official docs ([StopFailure input](https://code.claude.com/docs/en/hooks#stopfailure-input)): the common `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus `error` (`rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error` or `unknown`; this is also what a `matcher` filters on), optional `error_details` and optional `last_assistant_message` (the API error text itself). Claude Code ignores its output and exit code. The hook uses only the common fields, so every error type is handled the same way.
- `SubagentStop`: `last_assistant_message` was missing in the first test of that day and present in a later one (a foreground sub agent). This hook does not use it.

The hook process inherits Claude Code's environment variables: `HERDR_PANE_ID` (e.g. `w8:pV`), `HERDR_BIN_PATH` and `XDG_RUNTIME_DIR` were all present in testing. Sample payloads are in `test/fixtures/sidebar/`.

### Files written (`$XDG_RUNTIME_DIR/subagent-watch/`, tmpfs, cleared on reboot)

- `session-<sessionId>.json`: `{ sessionId, lastSequence, subagents: [{ id, agentType, startedAtMs }] }`, where `subagents` holds only running sub agents. `SubagentStop` (or the cleanup below) removes the entry, so the file size depends only on how many sub agents run at the same time and does not keep growing. It is only written when something changed, so a session that never starts a sub agent leaves no file.
  - Entries left by an older version with `status` `"done"` are dropped the next time an event reads the file.
  - A `SubagentStart` for a sub agent that is still in the list keeps a single entry (with its original start order); a `SubagentStart` for one that has already been removed (resume) adds it again at the end.
- `pane-<HERDR_PANE_ID>.json`: the mapping file the popup viewer reads: `{"sessionId","transcriptPath","cwd","updatedAtMs"}`, plus `"sessionStartSource"` (the `source` of that `SessionStart`, e.g. `"startup"`) when the file was written by the `SessionStart` of this session. **The four fields are fixed**; the viewer reads `sessionStartSource` only as a mark (see [Which session a pane maps to](../README.md#which-session-a-pane-maps-to)).
  - `SubagentStart` / `SubagentStop` of the same session rewrite the file and keep the mark; an event of another session writes the file without it, because that session's `SessionStart` may never have been seen.
  - `Stop` / `StopFailure` never write it.

Before writing, the hook checks the `subagent-watch` folder: it must belong to your uid, must not be a symlink, and must have mode `0700`. Otherwise nothing is written (and `XDG_RUNTIME_DIR` itself is never created when it is missing).

Both files are written to a temporary file and then `rename`d, so the viewer never reads half-written JSON. The temporary file has a random name and is created with `wx`, so a symlink planted in advance cannot redirect the write to another file.

Read-modify-write for one session is serialized with `session-<id>.json.lock`, so starting several sub agents in parallel loses no data:

- The lock holds the pid of its holder, its start time (field 22 of `/proc/<pid>/stat`) and when it was created. It is written to a temporary file first and then `link`ed into place (like `wx`, this only succeeds when the lock does not exist), so nobody reads a half-written lock.
- A lock is stale when `process.kill(pid, 0)` finds no such process, the process is a zombie, or the pid now belongs to a process with a different start time (pid reuse). An empty lock left by an older version has no pid and becomes stale after 2 seconds; any lock older than 10 seconds is stale (a safety net for when the pid check cannot be trusted; the hook itself finishes in under 1 second).
- A lock is identified by its inode together with its content (pid, start time, creation time). The inode alone is not enough: file systems such as ext4 hand a just-freed inode to the next new file, so a fresh lock created right after a stale one is removed can get the same inode. If the content cannot be read, the lock is not removed.
- Taking over: the hook first claims the name `<lock>.break-<inode>` with `link`, and only removes the lock if it got that name and the lock it reads back through that name is still the inode and content it judged stale. It never removes a fresh lock someone else just created. A `.break-*` file left by a process killed in between is cleared once it is 2 seconds old.
- On release, the lock is removed only if it is still the inode and content this run created.
- Inside the lock the hook only reads and writes the state file and reports to herdr. The transcripts used to spot sub agents that ended (next section) are read before the lock is taken: with those reads inside, every hook of a session started in parallel also waited for each earlier one to finish reading, and one that ran out of budget gave up (`lock-timeout`); a dropped `SubagentStart` never shows up in the sidebar.
  - Inside the lock the state file is read again, and only sub agents that are still in it with the same start time are removed. One that another hook removed and started again (resume) in between is kept: the transcript that was checked belongs to the previous run.
  - A `Stop` / `StopFailure` that finds nothing to remove returns without taking the lock.
  - Measured with 8 `SubagentStart` hooks started at once, a fake herdr that answers in 30 ms, and 5 running sub agents with real transcripts (state and transcripts on btrfs, 20 rounds): the lock is held for about 36 ms (median), almost all of it the herdr call, the same as before sub agent pruning existed. With the transcript reads inside the lock it was about 47 ms; pinned to one CPU shared with 4 busy processes, 46 of 160 updates were lost that way, and none of 640 after the change.

### Sub agents that ended without SubagentStop

A sub agent stopped by an API error can stay in the list forever when only `SubagentStop` removes it: on 2026-10-10 a sub agent that hit the usage limit (its last transcript line is an assistant entry with `isApiErrorMessage: true`) stayed in the sidebar for hours; why Claude Code did not fire `SubagentStop` for it is not verified. So on every hook event (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`), before taking the session lock, the hook looks at the transcript of every sub agent in that session's state file and removes the ones that have ended:

- Where: `<main transcript without .jsonl>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` next to it; task notifications come from the main transcript (`transcript_path` of the event). When the main transcript does not exist or the path is not absolute, nothing is removed: the sub agent paths could not be trusted.
- Only the last 64 KB of each transcript (and of the main transcript) is read; a cut first line is dropped.
- A sub agent counts as ended when:
  1. the popup viewer's rules say so (see [README](../README.md#data-sources-and-when-a-sub-agent-counts-as-finished), the same code in `lib/subagent-state.mjs`): a `SubagentHandback`, `end_turn` for sub agents that are not background, or a `<task-notification>` with `completed` / `killed` / `failed` in the main transcript. The viewer's 10-minute "no writes" rule is not used here;
  2. its last `user` / `assistant` entry is an API error (`isApiErrorMessage: true`). The 3 local sub agents with an API error all stop at that entry with nothing after it;
  3. its last `user` / `assistant` entry is `[Request interrupted by user…]`. The 3 local sub agents that end this way were all interrupted background sub agents, and the main transcript recorded `killed` for them at the same moment (that notification may already be outside the last 64 KB);
  4. its transcript still does not exist 2 minutes after its `SubagentStart` (in testing it appeared about 0.1 seconds after `SubagentStart`);
  5. as a last resort, no end signal but its transcript (or its `SubagentStart`, whichever is later) is more than 60 minutes old. This catches sub agents of a Claude Code process that was killed and left no signal at all. The threshold is 6 times the 10-minute maximum of a single Bash tool call, so a sub agent waiting for a command or an API response is not removed; a foreground sub agent left waiting on a permission prompt for more than an hour is (see Known limitations).
- A signal older than the sub agent's `SubagentStart` (with 2 seconds of tolerance) does not count: a resumed sub agent still has the previous run's ending at the end of its transcript until it writes something new. The sub agent of the event being handled is never checked in that same event (for `SubagentStop` it is removed anyway).
- Time: with 5 sub agents and real transcripts (0.5–1.8 MB each, a 3.4 MB main transcript), the whole hook process took about 42 ms (median of 15 runs, including about 18 ms of node startup). The checks themselves take about 10 ms, and at most about 22 ms with 8 hooks running at once (5 sub agents, real transcripts of 1.4–2.4 MB and a 3.7 MB main transcript). They stop after 100 ms, which is reached when 8 hooks share one CPU, so the event's own update still has time to get the lock (with a 200 ms limit, 8 hooks on one CPU shared with 4 busy processes lost 5 of 640 updates; with 100 ms, none); the remaining sub agents are kept and checked at the next event.
- The 195 sub agent transcripts on this machine (2026-10-10) were run through these rules: 192 counted as ended (`SubagentHandback` 146, `end_turn` 33, task notification `completed` 7 / `killed` 1, API error 3, interrupted 2). The 3 kept were two sub agents still being written at that moment (one of them the sub agent running the check) and one not written for about 15 minutes, whose real state is not verified.

### Reporting to herdr

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token sub1=├─ Explore ● --token sub2=└─ Plan ● \
  --clear-token sub3 --clear-token sub4 --clear-token sub5
```

When the last running sub agent ends, all five tokens are cleared with `--clear-token`.

- `SessionStart` always reports, so the tree of the previous session is replaced (or cleared) as soon as the pane switches sessions. `SubagentStart` / `SubagentStop` report when the list changed, `Stop` / `StopFailure` only when something was removed; otherwise herdr is not called.
- Only one source, `subagent.watch`, is used: herdr allows at most 32 sequenced sources per pane for its whole lifetime, and clearing one does not give it back.
- `--seq` is `Date.now()`; for several events in the same millisecond it uses "previous + 1", so it always increases (herdr ignores an older seq).
- Order: by start time. With more than 5 running, the fifth line becomes `└─ +N more`, where N counts only running sub agents that are not listed.
- herdr limits a token to 80 characters and strips control characters. The hook first removes control characters (`\p{Cc}`) and format characters (`\p{Cf}`, such as the bidi controls U+202A–202E and U+2066–2069 and the zero-width characters U+200B–200F), so an `agent_type` cannot reverse or hide text in the sidebar; one that is too long is truncated with `…`, so `●` always stays at the end of the line.
- herdr is called through `HERDR_BIN_PATH`; only when that is missing is `herdr` looked up on `PATH`, and only in absolute `PATH` entries: an empty entry or a relative one such as `node_modules/.bin` is relative to the current folder, which is the repo the user has open, and a `herdr` placed there must never run. `open-action.mjs`, `scripts/setup.mjs` and the notification in `bin/run.sh` follow the same rule.
- `bin/run.sh` goes further: before running any other command it drops empty and relative entries from `PATH` and exports the cleaned value, so `dirname`, `sed`, `sort`, `tail`, `cut` and the `node` it `exec`s are never taken from the current folder either. If no entry is left it uses `/usr/bin:/bin`, because bash (the `sh` on Fedora-based systems) treats an empty `PATH` as the current folder.

### Designed not to disturb Claude sessions

The hook is global and applies to every Claude session:

- It always exits 0 and prints nothing to stdout (herdr's output is sent to `ignore` too), with an overall budget of 800 ms (herdr is killed with `SIGKILL` on timeout); the 5-second timeout in `settings.json` is a safety net.
- No `HERDR_PANE_ID`, no `XDG_RUNTIME_DIR`, or no herdr executable → it writes nothing and exits.
- When `bin/run.sh` cannot find Node.js 22+, it always exits 0 silently for this hook (the other entry points print an error).
- `SubagentStart` / `SubagentStop` events with an empty `agent_type` are skipped: Claude Code's internal agents (prompt suggestion, `/btw`) also fire `SubagentStop`.
- A `SubagentStop` without a matching `SubagentStart` seen earlier is skipped.
- `Stop` fires after every turn of every session (`StopFailure` instead when the turn ends with an API error). Without running sub agents in the state file it only reads that file and calls nothing (about 30 ms for the whole process, most of it node startup); with running sub agents of which none has ended, it also reads their transcripts but neither takes the lock nor calls herdr.
- The `subagent-watch` folder is not yours, is a symlink, or is not `0700` → nothing is written.
- Events from another Claude session in the same pane are skipped (for example the claude in the pane running `claude -p` through Bash). Child processes inherit the same `HERDR_PANE_ID`; without this check they would overwrite the main session's tree and mapping file. The same check applies to all five events. How it decides:
  - It first counts the groups of `claude` processes among its ancestors. `claude` processes that are direct parent and child count as one group, so a wrapper script named claude that does not `exec` is still one group; commands run by the Bash tool always sit behind a shell, so a nested `claude -p` counts as a second group.
  - One group (or none) → the event is accepted and herdr is not asked.
  - Two or more groups → it asks `herdr pane get <pane>` for `agent_session` (reported by herdr's claude integration): only an event whose `session_id` matches updates the sidebar; a different session, a session of another agent, or no answer is skipped. It waits at most 300 ms and never eats into the minimum budget for reporting to herdr.
  - herdr's `agent_session` alone never rejects an event, because it can be stale (see Known limitations).

### Known limitations

- Sessions that were already running when the hooks were added (or before setup was run again after upgrading) have had no `SessionStart`: until they restart, `/resume`, `/clear` or compact, the pane map has no mark and switching sessions does not redraw the tree right away. The official docs say edits to hooks in settings files are normally picked up by a file watcher; whether a running session then fires the new `Stop` / `StopFailure` hooks is not verified.
- When `claude` exits while sub agents are running and no new session starts in that pane, their lines stay (`SessionEnd` is not hooked). Whether herdr still shows the claude rows of a pane that no longer runs Claude Code is not verified.
- A sub agent that ended without `SubagentStop` is removed only at the next hook event of its session. Per the official docs a turn that ends with an API error fires `StopFailure` instead of `Stop`; both are hooked, so after a usage limit that also ends the main turn, the line goes when that turn ends. `StopFailure` itself is not tested on this machine, and neither is whether the sub agent's API error entry is already in its transcript at that moment; if not, the line stays until the next turn, sub agent event or session start.
- The cleanup reads only the last 64 KB of a transcript: an end signal followed by more than 64 KB of other lines is missed, and the line then goes only by the 60-minute rule. If a future Claude Code moves the sub agent transcripts, every row would be removed by the 2-minute rule at the first hook event after that.
- A foreground sub agent left waiting on a permission prompt for more than 60 minutes is removed by the 60-minute rule; its later `SubagentStop` is then ignored.
- Whether Claude Code ever continues a sub agent after writing an API error entry is not verified (none of the 3 local cases did). If it does and a hook event happens in between, the line is removed early.
- herdr's `agent_session` can be stale: after the herdr server restarts it can stay on the session restored from `session.json`, the one from before the restart, and later `startup` reports from Claude Code do not overwrite it (seen with herdr 0.9.3; in the same test a `resume` report did not overwrite it either, for an unknown reason). So the hook does not rely on it to tell which session is the pane's main one, and only asks herdr when the ancestor scan finds two or more groups of `claude`. What is still not caught:
  - A nested `claude -p --resume` / `claude -p -c`: if herdr accepts its report and makes it the pane's `agent_session`, its events are treated as the main session's.
  - `exec claude -p`, or an `sh -c 'claude -p …'` that runs only that one command (for example a hook whose command is itself `claude -p …`; sh then execs into claude): the nested claude is a direct child of the main claude and counts as the same group, so it is taken as the main session and its events are accepted. How Claude Code actually starts the hook process is not verified.
  - When Claude Code is installed through npm and its process name is `node` rather than `claude`, the ancestor scan finds 0 groups and every event is accepted, nested ones included (not verified).
  - Since `SessionStart`, `Stop` and `StopFailure` are hooked too, a nested session that gets through costs more than before: every time it starts, its `SessionStart` rewrites the pane map with the mark (the popup follows it) and redraws the tree for its own session, usually clearing the main session's lines. Before, only its sub agent events got through.
- The `sh` at the start of the hook command is looked up by Claude Code through your `PATH` before `bin/run.sh` runs, so the `PATH` cleanup in `bin/run.sh` does not cover it.
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
"SubagentStop": [ same as above ],
"SessionStart": [ same as above ],
"Stop": [ same as above ],
"StopFailure": [ same as above ]
```

No `matcher`, so `SessionStart` runs for every `source` and `StopFailure` for every error type. If you already have your own `SessionStart` / `Stop` / `StopFailure` hooks, this entry is added after them and they are left as they are.

Upgrading from a version that only added `SubagentStart` / `SubagentStop`: run setup again. Each event is checked on its own, so the three missing ones are added and the existing two are left as they are (`unchanged`), never added twice; the same goes for any other mix of events already there. Until then everything works as before: the popup uses the older session lookup and a sub agent row goes away only with its `SubagentStop`.

`<plugin dir>` is the absolute path of the plugin when setup runs (the managed checkout from `herdr plugin install`, or the folder given to `herdr plugin link`). node is not written into the command; `bin/run.sh` looks it up every time.

Setup and remove recognize their own hook by the whole `command`: it must be exactly the form above (`run.sh` and `hooks/sidebar-hook.mjs` under the same absolute plugin folder), or the older hand-written form from before the launcher, `<absolute node path> <absolute path>/hooks/sidebar-hook.mjs` (setup upgrades it in place). Another tool's hook that merely has a file named `sidebar-hook.mjs` is neither changed nor removed. None of the hook fields listed in the official Claude Code hooks docs can carry an identifier, so the command is the only thing to compare.

How the files are written:

- Before a change, each file is backed up to `<file name>.subagent-watch.bak` in the same folder, **only the first time**: an existing `.bak` is never overwritten, so the earliest original is kept (delete the old `.bak` yourself if you want a fresh one).
- When a config file is a symlink (for example into a dotfiles repo), the real file it points to is written and the symlink stays; a symlink to a missing file is reported and left alone. Only the file itself counts: a symlinked folder on the way (such as `/home` → `/var/home` on Bazzite) is not reported.
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
2. Settings added by hand without markers have to be removed yourself: in `settings.json`, delete the entries whose `command` points at `sidebar-hook.mjs` under `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` and `StopFailure` (if an array becomes empty, remove the whole key); in `config.toml`, delete the `[[keys.command]]` block for `prefix+.` and `$sub1`…`$sub5` from the `claude` rows, then run `herdr server reload-config`.
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

Covers payload parsing (including the real `SessionStart` startup / resume and `Stop` payloads), state updates (stop removes the entry, a stop without a seen start is skipped, old `done` entries are dropped), `SessionStart` (pane map mark, the mark kept by sub agent events of the same session and dropped for another session, the tree redrawn or cleared when the session changes), `Stop` and `StopFailure` (never write the pane map, call herdr only when something was removed; `StopFailure` with the documented payload removes a sub agent stopped by an API error and goes through the same nested `claude` check), removing sub agents that ended without `SubagentStop` (the real API error and interrupted transcript tails, the viewer rules, end signals from before a resume, the 2-minute and 60-minute rules, only the last 64 KB read, a planted FIFO not waited on, the time budget, every transcript read before the lock is taken, only entries that no other hook changed in between removed, a `Stop` with nothing to remove not taking the lock), tree lines (start two → stop one leaves `└─` → stop all clears everything, `+N more` counts only running ones, 80-character truncation, bidi and zero-width characters removed), increasing seq, staying silent outside herdr, falling back to herdr on `PATH` when `HERDR_BIN_PATH` is missing (relative `PATH` entries excluded), `bin/run.sh` running no tool from a relative `PATH` entry, deciding the pane session (one `claude` ancestor updates even when herdr reports a stale `agent_session`, a wrapper named claude still updates, a nested `claude -p` is skipped unless herdr reports its session, tested with a real process tree), the state folder checks (symlink, mode, owner, planted symlinks), the lock (stale detection, taking over or releasing without removing someone else's fresh lock, even one that got the same inode, several hooks racing for one stale lock lose no data), no data loss with parallel starts, and running the script for real with a fake herdr executable (checking exit 0, empty stdout, and finishing within 1 second).
