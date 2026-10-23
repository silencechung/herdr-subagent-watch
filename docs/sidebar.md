# Sidebar sub agent count

English | [繁體中文](sidebar.zh-TW.md)

Under the claude row of the herdr sidebar, one line shows how many sub agents of that session are **still running**:

```
<state_icon> <workspace> · <tab>
claude
● 3 running
```

- Only the number is shown: no names and no upper limit (`● 12 running` when 12 are running). A `SubagentStart` adds one, except when it resumes a sub agent that is still counted (its previous `SubagentStop` was missed, so its file is still there): that only replaces the start time and the number stays the same. A `SubagentStop` subtracts one; one without a `SubagentStart` seen earlier changes nothing.
- A sub agent that ended without a `SubagentStop` (for example one stopped by an API error such as a usage limit) is removed at the first hook event of that session that comes 2 minutes or more after its last write (for example when the main session finishes its next turn: `Stop`, or `StopFailure` when that turn itself ends with an API error). See [Sub agents that ended without SubagentStop](#sub-agents-that-ended-without-subagentstop).
- When the pane switches to another session (a new `claude`, `/clear`, `/resume`), the count is redrawn for that session right away (`SessionStart`); a session without running sub agents clears it.
- With no running sub agent the line disappears and the sidebar shows only the claude row.
- The sidebar keeps no history: finished sub agents and what they did are in the popup viewer (`prefix+.`), see the [README](../README.md).

## How it works

1. Claude Code fires the `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` and `StopFailure` hooks. All five run the same command: `bin/run.sh` finds node and runs `hooks/sidebar-hook.mjs`; the payload arrives on stdin and `hook_event_name` tells the events apart.
2. The hook writes or removes the file of its own sub agent (one file per running sub agent, no lock), then counts the sub agent files of its session and calls `herdr pane report-metadata` to write `● N running` into pane token `sub1` (and clear `sub2`…`sub5`, see step 3).
   - `SessionStart`: writes the pane map (marked as written at session start, see below) and always redraws the count from that session's sub agent files.
   - `SubagentStart` / `SubagentStop`: writes / removes the file of that sub agent and writes the pane map.
   - `Stop` (the main session finished a turn) and `StopFailure` (the turn ended with an API error instead, such as a usage limit): only remove sub agents that have ended and redraw when something was removed. They never write the pane map.
   - Every event first checks the session's other sub agents and removes the ones that have ended (see [below](#sub-agents-that-ended-without-subagentstop)).
3. `rows_by_agent.claude` in `config.toml` has one extra line, `$sub1`. The herdr docs state that a token that has not been reported makes its whole line disappear, so with nothing running no empty line shows.
   - Setup from an older version wrote five lines, `$sub1`…`$sub5` (one per sub agent). Those configs keep working without running setup again: every report clears `sub2`…`sub5`, so their lines disappear the same way and only `$sub1` shows the count. See [What setup adds](#what-setup-adds) for how to tidy them up.

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

The hook process inherits Claude Code's environment variables: `HERDR_PANE_ID` (e.g. `w8:pV`), `HERDR_BIN_PATH` and `XDG_RUNTIME_DIR` were all present in testing on Linux. macOS does not set `XDG_RUNTIME_DIR` by default; the hook then uses `$TMPDIR` (see below). Sample payloads are in `test/fixtures/sidebar/`.

### Files written

The folder is `$XDG_RUNTIME_DIR/subagent-watch/` (tmpfs on Linux, cleared on reboot). On macOS without `XDG_RUNTIME_DIR` it is `$TMPDIR/subagent-watch/` (`os.tmpdir()`, `/var/folders/…/T`, one per user with mode `0700`); macOS deletes files there that have not been accessed for 3 days (see [Known limitations](#known-limitations)). On Linux without `XDG_RUNTIME_DIR` the hook does not fall back to `/tmp`, which is shared with other users, and writes nothing. The hook, `lib/session.mjs` and the popup pick the folder with the same function (`lib/runtime-directory.mjs`).

- `sub-<sessionId>-<agentId>.json`: one file per running sub agent, `{ sessionId, id, agentType, startedAtMs }`. `SubagentStart` writes it and `SubagentStop` (or the cleanup below) removes it, so the folder only holds running sub agents; a session that never starts a sub agent leaves no file.
  - A file counts only when its `sessionId` and `id` match its name: when one session id happens to be another one plus "-…", the name prefixes overlap. Broken or mismatched files are skipped.
  - A `SubagentStart` for a sub agent whose file is still there (a resume whose previous `SubagentStop` was missed) overwrites it with this start time; a `SubagentStart` for one whose file was already removed (resume) writes it again. The start time decides which run an end signal belongs to (see the next section).
  - The `session-<sessionId>.json` and `.lock` files of the previous version: see [Upgrading from the previous version](#upgrading-from-the-previous-version) below.
- `pane-<HERDR_PANE_ID>.json`: the mapping file the popup viewer reads: `{"sessionId","transcriptPath","cwd","updatedAtMs"}`, plus `"sessionStartSource"` (the `source` of that `SessionStart`, e.g. `"startup"`) when the file was written by the `SessionStart` of this session. **The four fields are fixed**; the viewer reads `sessionStartSource` only as a mark (see [Which session a pane maps to](internals.md#which-session-a-pane-maps-to)).
  - `SubagentStart` / `SubagentStop` of the same session rewrite the file and keep the mark; an event of another session writes the file without it, because that session's `SessionStart` may never have been seen.
  - `Stop` / `StopFailure` never write it.

Before writing, the hook checks the `subagent-watch` folder: it must belong to your uid, must not be a symlink, and must have mode `0700`. Otherwise nothing is written (and `XDG_RUNTIME_DIR` or `$TMPDIR` itself is never created when it is missing). Only `subagent-watch` itself is checked with `lstat`, so the `/var` → `/private/var` symlink above `$TMPDIR` on macOS does not get in the way.

Sub agent files and the pane map are written to a temporary file and then `rename`d, so neither the viewer nor another hook reads half-written JSON. The temporary file has a random name and is created with `wx`, so a symlink planted in advance cannot redirect the write to another file.

### Hooks running in parallel, without a lock

Each hook only writes or removes the file of its own sub agent, so hooks running in parallel never change the same file; herdr's `--seq` decides which report stays on screen:

- The order within one event: write the pane map → move the previous version's state file (if any) → write / remove its own sub agent file → find and remove sub agents that have ended (next section) → **take the seq** → read the session's sub agent files (`readdir`) and count them → call herdr.
- For one pane and one source, herdr only accepts a report whose seq is larger than the last one it accepted (tested: a smaller or equal one is ignored, exit 0, no message), so the sidebar ends up showing the report with the largest seq, whatever order they arrive in. The seq is taken after the files are changed and before the folder is read: when a hook that changed a file takes its seq, the change is complete, so any report with a larger seq read the folder after that and includes the change; a report that read the folder before the change was complete has a smaller seq and is ignored. However the hooks interleave, the report left on screen includes every change.
- Two hooks can get the same seq: with 8 hooks fired at once, two processes on different cores sometimes read the clock in the same nanosecond (4 times in 30 runs of the parallel test). herdr then keeps whichever arrives first and ignores the other, and this is harmless: the same seq means both took it in the same nanosecond, when the change of each was already complete and neither had read the folder yet (reading it takes microseconds), so both reports include every change up to that seq. A change completed after that is made by a hook that takes its seq only afterwards, so its seq is larger and its report replaces both. In those 30 runs the sidebar always ended up equal to the files; a test also has a hook take the same seq in the middle of another one and checks that both reports are correct. A millisecond seq is different: within one millisecond another hook still has time to finish its change, so the ignored report can be the only one that saw it (see the proof of concept below). This relies on the clock tick being shorter than the time between reading the clock and reading the folder. The clocksource on the development machine is `tsc` (ns resolution; see `/sys/devices/system/clocksource/clocksource0/current_clocksource`). With `hpet` or `acpi_pm` (a tick of about 70–280 ns) it presumably still holds (not verified); falling back to `jiffies` (1/HZ, milliseconds) would lose updates the same way a millisecond seq does (not verified). On macOS, Node 22's `process.hrtime` uses `mach_continuous_time` (libuv 1.51, `src/unix/darwin.c`), whose tick on an M1 is about 41.67 ns (timebase 125/3), much shorter than a `readdir`, so it presumably holds there too (not verified).
- An event that changed no file (`Stop` / `StopFailure` with nothing to remove, a `SubagentStop` whose file does not exist) takes no seq and does not call herdr; `SessionStart` always redraws.
- When a sub agent that ended is removed, another hook may have resumed it (rewritten its file) after it was judged. Reading and then deleting would remove a new file put there in between, so the hook first `rename`s the file to a random temporary name to take it, reads what it took, and deletes it only when the start time is the one it judged; otherwise (the new run of a resume) it puts it back with `link` (which never overwrites, so a newer file already there is kept). Between taking and putting back, other hooks reading the folder do not see that sub agent, so putting it back counts as a change: the hook then takes a seq and redraws.
- Proof of concept (the real herdr, 8 hooks fired at once, 20 rounds of 3 scenarios: all start, all stop, each starts and stops right away; normal, `taskset -c 0`, and with 4 or 6 CPU-bound processes added): this design lost no update; a millisecond seq lost 22 of 60 to equal values, a seq taken before writing the file lost 1–2 of 60, and no seq lost 10–19 of 60.
- Compared with the lock version (a fake herdr that takes 30 ms per call, 5 running sub agents with about 1 MB of transcript each, a main transcript of about 3 MB; times include node startup):
  - A single `SubagentStart`: the same for both, about 75 ms with about 39 ms of CPU (mostly node startup); about 255 ms pinned to 1 CPU next to 4 CPU-bound processes.
  - 8 hooks fired at once: a median of about 76 ms per hook and at most about 90 ms (lock version: about 203 ms, at most about 630 ms); pinned to 1 CPU next to 4 CPU-bound processes, a median of about 545 ms and at most about 650 ms (lock version: about 665 ms, at most about 1.3 seconds).
  - Neither version lost an update (15 rounds normally and 16 rounds on the busy machine, 3 scenarios each).

### Upgrading from the previous version

The previous version kept one `session-<sessionId>.json` per session and serialized read-modify-write with `session-<sessionId>.json.lock`.

- On every event the new version checks for its own session's old file (when there is none this costs one failed open), moves the sub agents still running in it to sub agent files (never overwriting one that exists; entries with `status` `"done"`, left by an even older version, are not moved), and removes the old file. Sub agents running during the upgrade therefore stay in the sidebar and go away as usual with their `SubagentStop` or the cleanup; one that has in fact ended is caught by the cleanup in the same event.
- `.lock` and `.break-*` files left by the previous version are ignored and not removed: the new version never reads them, and like the other files they live on tmpfs and are gone after a reboot (or when `XDG_RUNTIME_DIR` is cleared at logout); on macOS `$TMPDIR` drops them after 3 days without access. A lock naming a live process does not block the new version either.
- If a hook of the previous version that was still running at the moment of the upgrade writes the old file back after it was moved, the next event moves it again; a sub agent no longer in the old file but still having a sub agent file is not removed because of that, only by the cleanup.
- Two cases right at the upgrade can make a sub agent that has already stopped count again: the old file written back as above, and two new hooks moving the same old file at the same time. See Known limitations.

### Sub agents that ended without SubagentStop

A sub agent stopped by an API error can stay in the list forever when only `SubagentStop` removes it: on 2026-10-10 a sub agent that hit the usage limit (its last transcript line is an assistant entry with `isApiErrorMessage: true`) stayed in the sidebar for hours; why Claude Code did not fire `SubagentStop` for it is not verified. So on every hook event (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`), the hook looks at the transcript of every sub agent that has a file in that session and removes the files of the ones that have ended:

- Where: `<main transcript without .jsonl>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` next to it; task notifications come from the main transcript (`transcript_path` of the event). When the main transcript does not exist or the path is not absolute, nothing is removed: the sub agent paths could not be trusted.
- Only the last 64 KB of each transcript (and of the main transcript) is read; a cut first line is dropped.
- This cleanup is only a safety net for a missed `SubagentStop`. A sub agent is removed only when all three hold:
  1. the last real entry (`user` / `assistant`) of its transcript is an end signal, one of:
     - the popup viewer's rules (see [internals](internals.md#data-sources-and-when-a-sub-agent-counts-as-finished), the same code in `lib/subagent-state.mjs`): a `SubagentHandback` (followed by nothing but its own tool result) or `end_turn` for sub agents that are not background. The viewer's 10-minute "no writes" rule is not used here;
     - a `<task-notification>` with `completed` / `killed` / `failed` in the main transcript: only the time of its `enqueue` line counts, and it must not be older than the last real entry; it is ignored when that entry is a new instruction (a `user` entry that is not a tool result, such as the message of a resume). The `remove` (dequeue) time is not used: it can come after a resume or after later entries of the sub agent. One local sub agent kept running Bash after its `SubagentHandback` because of a queued message, and its notification was dequeued after what was then its last entry;
     - an API error (`isApiErrorMessage: true`). The 3 local sub agents with an API error all stop at that entry with nothing after it;
     - `[Request interrupted by user…]`. The 3 local sub agents that end this way were all interrupted background sub agents, and the main transcript recorded `killed` for them at the same moment (that notification may already be outside the last 64 KB);
  2. the end signal is not older than this run's `SubagentStart` (no tolerance). A resumed sub agent still has the previous run's ending at the end of its transcript until it writes something new, so every `SubagentStart` (including one for a sub agent that is still in the list) replaces the start time with the time of that event;
  3. the last entry, the transcript's mtime (and, for a task notification, the notification) are all 2 minutes old or more (`quietAfterEndSignalMs`). The few seconds after a resume, before the new run writes anything, are covered: over 21 local resumes, the new run's first entry came at most about 5 seconds after `SendMessage`, and its first assistant reply at most about 10 seconds after.
- A transcript that still does not exist 2 minutes after its `SubagentStart` is removed as well (in testing it appeared about 0.1 seconds after `SubagentStart`).
- A sub agent without an end signal is kept, however long it has not been written. The older "no writes for 60 minutes" rule is gone: 2 local sub agents went on running after 7 and 23 hours without a write within the same run (presumably the computer was asleep; not verified) and would have been removed.
- The cost: a sub agent whose `SubagentStop` was missed does not disappear right away, only at the first hook event 2 minutes or more after its last write (the main session finishing a turn, another sub agent starting or ending, a session starting).
- Why these rules: a simulation on the real timelines of the 210 local sub agents (231 runs, 21 of them resumes), with hook events at the main transcript's turn ends and at the starts and ends of the other sub agents of the session. The old rules (a signal counts from 2 seconds before `SubagentStart`, the old start time is kept on a resume, plus the 60-minute rule) removed a running sub agent 4 times; these rules never did (also never when sampling every second). The sub agent stopped by an API error without a `SubagentStop` was removed 120 seconds after its last entry when sampling every second.
- The sub agent of the event being handled is never checked in that same event (for `SubagentStop` it is removed anyway; for `SubagentStart` it may be a resume whose transcript still ends with the previous run).
- Time: with 5 sub agents and real transcripts (0.5–1.8 MB each, a 3.4 MB main transcript), the whole hook process took about 42 ms (median of 15 runs, including about 18 ms of node startup). The checks themselves take about 10 ms, and at most about 22 ms with 8 hooks running at once (5 sub agents, real transcripts of 1.4–2.4 MB and a 3.7 MB main transcript). They stop after 100 ms, which is reached when 8 hooks share one CPU, so the event's own report is not held up for long; the remaining sub agents are kept and checked at the next event.
- The current state of the 210 sub agent transcripts on this machine (2026-10-11) was run through these rules: 208 counted as ended (`SubagentHandback` 165, `end_turn` 32, task notification `completed` 5, API error 3, interrupted 3). Of the 2 kept, one is the sub agent running the check; the other is a background sub agent ending with `end_turn` whose `completed` notification is no longer in the last 64 KB of the (about 10 MB) main transcript (see Known limitations; the hooks at that time could read it).

### Reporting to herdr

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token "sub1=● 2 running" \
  --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
```

When the last running sub agent ends, `sub1` is cleared too (`--clear-token sub1`), so all five tokens are cleared. `sub2`…`sub5` are cleared on every report: configs written by an older setup still have those rows, and the tree lines the previous version left on a pane go away with the first report.

- `SessionStart` always reports, so the count of the previous session is replaced (or cleared) as soon as the pane switches sessions. `SubagentStart` / `SubagentStop` report when the list changed, `Stop` / `StopFailure` only when something was removed; otherwise herdr is not called.
- Only one source, `subagent.watch`, is used: herdr allows at most 32 sequenced sources per pane for its whole lifetime, and clearing one does not give it back.
- `--seq` is "boot time (seconds: `btime` in `/proc/stat` on Linux, `kern.boottime` from `/usr/sbin/sysctl -n kern.boottime` on macOS) × 10⁹ + the monotonic clock (ns, `process.hrtime`)", computed as a BigInt and passed to herdr as a string (herdr's limit is u64; above it herdr exits 1).
  - The monotonic clock is shared by all processes and has ns resolution, so hooks running in parallel rarely get the same value, and when they do it is harmless (see [Hooks running in parallel, without a lock](#hooks-running-in-parallel-without-a-lock)); with milliseconds they often do and updates get lost (see the proof of concept above).
  - The monotonic clock starts over at boot; adding the boot time keeps the seq increasing across reboots (whether herdr still remembers an old seq after a reboot is not verified).
  - The value is now about 1.79×10¹⁸, far larger than the millisecond seq of the previous version (about 1.79×10¹²), so the first report after an upgrade is not ignored.
  - On macOS the boot time is not computed as `Date.now()` − `os.uptime()`: that differs by a few ms on every call, and when it crosses a second boundary the base jumps by 1 second and the seq goes back, so herdr would ignore the report.
  - When the boot time cannot be read (no `/proc`, `sysctl` failing or timing out after 200 ms), it uses a fixed 10¹⁷ + the monotonic clock instead: still fine-grained and still larger than the previous version's, but it starts low again after a reboot.
- `agent_type` never reaches herdr: the line is only the count. The hook still removes control characters (`\p{Cc}`) and format characters (`\p{Cf}`, such as bidi controls and zero-width characters) from it, because an `agent_type` that is empty after that marks one of Claude Code's internal agents and is skipped.
- herdr is called through `HERDR_BIN_PATH`; only when that is missing is `herdr` looked up on `PATH`, and only in absolute `PATH` entries: an empty entry or a relative one such as `node_modules/.bin` is relative to the current folder, which is the repo the user has open, and a `herdr` placed there must never run. `open-action.mjs`, `scripts/setup.mjs` and the notification in `bin/run.sh` follow the same rule.
- `bin/run.sh` goes further: before running any other command it drops empty and relative entries from `PATH` and exports the cleaned value, so `dirname`, `sed`, `sort`, `tail`, `cut` and the `node` it `exec`s are never taken from the current folder either. If no entry is left it uses `/usr/bin:/bin`, because bash (the `sh` on Fedora-based systems) treats an empty `PATH` as the current folder.

### Designed not to disturb Claude sessions

The hook is global and applies to every Claude session:

- It always exits 0 and prints nothing to stdout (herdr's output is sent to `ignore` too), with an overall budget of 1500 ms, not counting node startup (herdr is killed with `SIGKILL` on timeout); the 5-second timeout in `settings.json` is a safety net.
  - The budget is a cap that normal runs never reach: with 8 hooks fired at once (a fake herdr that takes 30 ms per call, 5 running sub agents with about 1 MB of transcript each, node startup included) a hook takes at most about 90 ms; pinned to 1 CPU next to 4 CPU-bound processes, at most about 650 ms.
  - Without the lock nothing waits for another hook any more, but the budget stays at 1.5 seconds: the herdr call's timeout is whatever budget is left, and a killed herdr call is a lost update, so a smaller budget would only lose more updates on a busy machine while normal runs never reach it.
- No `HERDR_PANE_ID`, no `XDG_RUNTIME_DIR` (on Linux; macOS falls back to `$TMPDIR`), or no herdr executable → it writes nothing and exits.
- When `bin/run.sh` cannot find Node.js 22+, it always exits 0 silently for this hook (the other entry points print an error).
- `SubagentStart` / `SubagentStop` events with an empty `agent_type` are skipped: Claude Code's internal agents (prompt suggestion, `/btw`) also fire `SubagentStop`.
- A `SubagentStop` without a matching `SubagentStart` seen earlier is skipped.
- `Stop` fires after every turn of every session (`StopFailure` instead when the turn ends with an API error). Without running sub agents in that session it lists the folder once and calls nothing (about 29 ms for the whole process, most of it node startup); with running sub agents of which none has ended, it also reads their transcripts but takes no seq and does not call herdr.
- The `subagent-watch` folder is not yours, is a symlink, or is not `0700` → nothing is written.
- Events from another Claude session in the same pane are skipped (for example the claude in the pane running `claude -p` through Bash). Child processes inherit the same `HERDR_PANE_ID`; without this check they would overwrite the main session's sidebar line and mapping file. The same check applies to all five events. How it decides:
  - It first counts the groups of `claude` processes among its ancestors: on Linux by reading `/proc/<pid>/stat` up the chain, on macOS from one `/bin/ps -A -o pid=,ppid=,comm=` snapshot (300 ms timeout; one call, not one per level). On macOS `comm` is `argv[0]` and can be a full path, so only its file name is compared; `(name)`, which `ps` shows for processes whose arguments it cannot read, counts as `name`. If `ps` fails, no group is found and the event is accepted, the same as an unreadable `/proc`. `claude` processes that are direct parent and child count as one group, so a wrapper script named claude that does not `exec` is still one group; commands run by the Bash tool always sit behind a shell, so a nested `claude -p` counts as a second group.
  - One group (or none) → the event is accepted and herdr is not asked.
  - Two or more groups → it asks `herdr pane get <pane>` for `agent_session` (reported by herdr's claude integration): only an event whose `session_id` matches updates the sidebar; a different session, a session of another agent, or no answer is skipped. It waits at most 300 ms and never eats into the minimum budget for reporting to herdr.
  - herdr's `agent_session` alone never rejects an event, because it can be stale (see Known limitations).

### Known limitations

- Sessions that were already running when the hooks were added (or before setup was run again after upgrading) have had no `SessionStart`: until they restart, `/resume`, `/clear` or compact, the pane map has no mark and switching sessions does not redraw the count right away. The official docs say edits to hooks in settings files are normally picked up by a file watcher; whether a running session then fires the new `Stop` / `StopFailure` hooks is not verified.
- When `claude` exits while sub agents are running and no new session starts in that pane, they stay in the count (`SessionEnd` is not hooked). Whether herdr still shows the claude rows of a pane that no longer runs Claude Code is not verified.
- A sub agent that ended without `SubagentStop` is removed only at the first hook event of its session that comes 2 minutes or more after its last write. Per the official docs a turn that ends with an API error fires `StopFailure` instead of `Stop`; after a usage limit that also ends the main turn, if `StopFailure` fires within 2 minutes of the sub agent's last write (how far apart they are is not verified), it stays in the count until the next turn, sub agent event or session start. `StopFailure` itself is not tested on this machine.
- The cleanup reads only the last 64 KB of a transcript: an end signal followed by more than 64 KB of other lines, or a task notification no longer in the last 64 KB of the main transcript, is missed, and the sub agent stays in the count until the pane switches sessions. If a future Claude Code moves the sub agent transcripts, every sub agent would be removed by the 2-minute rule at the first hook event after that.
- A sub agent without an end signal is never removed: sub agents of a Claude Code process that was killed and left no signal stay in the count until the pane switches sessions.
- Whether Claude Code ever continues a sub agent after writing an API error entry is not verified (none of the 3 local cases did). If it does, more than 2 minutes later, with a hook event in between, it is taken out of the count early.
- herdr's `agent_session` can be stale: after the herdr server restarts it can stay on the session restored from `session.json`, the one from before the restart, and later `startup` reports from Claude Code do not overwrite it (seen with herdr 0.9.3; in the same test a `resume` report did not overwrite it either, for an unknown reason). So the hook does not rely on it to tell which session is the pane's main one, and only asks herdr when the ancestor scan finds two or more groups of `claude`. What is still not caught:
  - A nested `claude -p --resume` / `claude -p -c`: if herdr accepts its report and makes it the pane's `agent_session`, its events are treated as the main session's.
  - `exec claude -p`, or an `sh -c 'claude -p …'` that runs only that one command (for example a hook whose command is itself `claude -p …`; sh then execs into claude): the nested claude is a direct child of the main claude and counts as the same group, so it is taken as the main session and its events are accepted. How Claude Code actually starts the hook process is not verified.
  - When Claude Code is installed through npm and its process name is `node` rather than `claude`, the ancestor scan finds 0 groups and every event is accepted, nested ones included (not verified).
  - On macOS, what the native Claude Code binary shows in the `comm` column of `ps` has not been checked on a real Mac. If it is not `claude` (or a path ending in `/claude`), the same happens as with npm above.
  - Since `SessionStart`, `Stop` and `StopFailure` are hooked too, a nested session that gets through costs more than before: every time it starts, its `SessionStart` rewrites the pane map with the mark (the popup follows it) and redraws the count for its own session, usually clearing the main session's line. Before, only its sub agent events got through.
- The `sh` at the start of the hook command is looked up by Claude Code through your `PATH` before `bin/run.sh` runs, so the `PATH` cleanup in `bin/run.sh` does not cover it.
- The boot time in the seq is "system time − time since boot", in whole seconds (rounded down). When the system time is set back (by hand, or an NTP step), the boot time gets smaller with it, and because it is cut to whole seconds, even a step back of a few milliseconds can lower the seq by about 1 second. Until the time catches up, a seq can be smaller than one sent before the change and herdr ignores those reports, so the sidebar can freeze for about as long as the time was set back (plus up to 1 second), not just a few seconds. The previous version raised the seq by 1 over the session's last one and was not affected within a session, so this is a small regression. Per the Linux timekeeping code, sleep and gradual NTP corrections (slew) do not change it (not tested). Whether `kern.boottime` on macOS changes after sleep or a time change is not verified.
- Going back to the previous version: it sends a millisecond seq (about 1.79×10¹²), but herdr has already accepted this version's seq (about 1.79×10¹⁸) for the pane, so it ignores every report of the previous version (exit 0, no message) and the sidebar stops updating. Restart the herdr server to get it back (herdr's saved state has no seq, so this is inferred, not tested).
- Only around the first events after an upgrade, a sub agent that has already stopped can count again: hook B (`SubagentStart` of Y) reads the previous version's `session-<sessionId>.json`, and before B links the sub agent files, hook A (`SubagentStop` of X) runs to the end (it moves the same old file, removes it and removes the file of X); B then puts the file of X back and counts it. The same happens when a hook of the previous version that was still running at the upgrade writes the old file back with X in it (see [Upgrading from the previous version](#upgrading-from-the-previous-version)). X stays in the count until the cleanup removes it (2 minutes after its end signal).
- A hook killed after changing its file and before its report reaches herdr (for example when herdr hangs past the budget) leaves that change off the screen until the next report of that session.
- If the `SubagentStop` of a sub agent arrives during the few microseconds in which the cleanup has taken its file away to put it back, it finds no file, and the sub agent that is put back stays in the count until the cleanup removes it (2 minutes after its end signal).
- On macOS without `XDG_RUNTIME_DIR`, the files live in `$TMPDIR`, where macOS deletes files not accessed for 3 days. After a pane has been idle for 3 days, its pane map can be gone and the popup falls back to guessing the session from the cwd until the next `SessionStart` or sub agent event. A sub agent file can go the same way, and that sub agent then drops out of the count. The hook and the popup also need the same `TMPDIR`: if herdr and Claude Code were started with different values, the popup does not find the pane map.
- `●` is an ambiguous width character; its actual width depends on the terminal settings.

## What setup adds

Written by the `subagent.watch.setup` action (or `sh bin/run.sh scripts/setup.mjs`). For the rules and conflict handling, see [Setup details](internals.md#setup-details) in `docs/internals.md`.

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

Upgrading from a version that only added `SubagentStart` / `SubagentStop`: run setup again. Each event is checked on its own, so the three missing ones are added and the existing two are left as they are (`unchanged`), never added twice; the same goes for any other mix of events already there. Until then the popup uses the older session lookup, and a sub agent that ended without its `SubagentStop` leaves the count only at a `SubagentStart` / `SubagentStop` of another sub agent of the same session that comes 2 minutes or more after its last write: the cleanup runs on every event, but only those two events are hooked.

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
]
```

The first two rows are the default rows from the herdr docs. `rows_by_agent` replaces `rows` entirely instead of appending to it, so the two default rows have to be included. If you customized `rows` under `[ui.sidebar.agents]`, the claude row goes back to these two rows (setup warns you about this).

`$sub1` uses an inline style table and is always `bold`: the line only counts running sub agents, so there is no status to tell apart.

- No `fg`: colors follow the herdr theme entirely, so switching themes needs no change to this line.
- `dim = false`: the herdr docs state that fields left out inherit the token's contextual style, and only an explicit `false` removes that modifier. This makes sure the line is never drawn dim.

Older versions of setup wrote five lines, `$sub1`…`$sub5`, one per sub agent. Running setup again does **not** rewrite them: setup treats claude rows that already contain `$sub1` as configured, the same way it never rewrites anything already there. They need no change either: the hook clears `sub2`…`sub5` on every report, so those four lines never show. To tidy them up, delete the `$sub2`…`$sub5` lines yourself, or (if they are inside the markers) run remove and then setup again, which writes the single line above.

Even older versions of setup also wrote `rules = [{ contains = "✓", bold = false }]` on each line. `✓` no longer appears, so that rule does nothing if it is still there. Setup treats claude rows that already contain `$sub1` as configured and does not rewrite them; to remove the rule, delete it yourself, or (if it is inside the markers) run remove and then setup again.

## How to remove

1. Run `herdr plugin action invoke subagent.watch.remove` (or `sh bin/run.sh scripts/setup.mjs --remove`): it removes this plugin's hooks from `settings.json` (recognized as described in "What setup adds") and the content between the markers in `config.toml`, then runs `herdr server reload-config`.
2. Settings added by hand without markers have to be removed yourself: in `settings.json`, delete the entries whose `command` points at `sidebar-hook.mjs` under `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` and `StopFailure` (if an array becomes empty, remove the whole key); in `config.toml`, delete the `[[keys.command]]` block for `prefix+.` and `$sub1` (`$sub1`…`$sub5` from an older setup) from the `claude` rows, then run `herdr server reload-config`.
3. Clear tokens left on panes (run once for each pane that has claude):

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

   Leave out `--seq`: herdr ignores a seq that is not larger than the last one it accepted, and the hook's seq (about 1.79×10¹⁸) is far larger than anything typed by hand such as `$(date +%s%3N)` (milliseconds, about 1.79×10¹²), so the tokens would stay. A report without `--seq` is always accepted and does not reset the last seq.

4. The state files are in `$XDG_RUNTIME_DIR/subagent-watch/` (on macOS without `XDG_RUNTIME_DIR`: `$TMPDIR/subagent-watch/`). On Linux they are cleared automatically on reboot; on macOS files not accessed for 3 days are deleted. You can also delete that folder by hand.

## Tests

```
node --test test/sidebar*.test.mjs test/security-*.test.mjs
```

Covers payload parsing (including the real `SessionStart` startup / resume and `Stop` payloads), sub agent files (stop removes the file, a stop without a seen start is skipped, a resume gets the new start time, the content must match the name, broken files are skipped and not counted), upgrading from the previous version (running entries become sub agent files, `done` entries are not moved, an existing sub agent file is never overwritten, old locks are ignored, a `Stop` whose only change is the move still reports), `SessionStart` (pane map mark, the mark kept by sub agent events of the same session and dropped for another session, the count redrawn or cleared when the session changes), `Stop` and `StopFailure` (never write the pane map, call herdr only when something was removed; `StopFailure` with the documented payload removes a sub agent stopped by an API error and goes through the same nested `claude` check), removing sub agents that ended without `SubagentStop` (the real API error and interrupted transcript tails, the viewer rules, only the last real entry counting, removal only after 2 minutes without writes, end signals from before a resume not counting with no tolerance, a resume replacing the start time, the review's E2E timeline where a resume within 2 seconds of the previous end is kept, task notifications counted by their `enqueue` time and ignored after a new instruction, a sub agent without an end signal kept however long it is silent, the 2-minute rule for a missing transcript, only the last 64 KB read, a planted FIFO not waited on, the time budget, every transcript read before the seq is taken, only files that no other hook changed in between removed, a resumed file put back and redrawn, a `Stop` with nothing to remove taking no seq and not calling herdr), the sidebar line (start two → `● 2 running` → stop one → `● 1 running` → stop all clears everything, no upper limit, only running ones counted, `sub2`…`sub5` cleared on every report, `agent_type` never sent to herdr, bidi and zero-width characters removed from it), the seq (a BigInt, boot time plus the monotonic clock, increasing across reboots, larger than the previous version's millisecond seq, the fallback without `btime`, taken after the files are changed and before the folder is read), the macOS branch run on Linux with an injected platform and fake `ps` / `sysctl` output (full paths, names with spaces, `(p_comm)`, `<defunct>`, empty and garbage output, one `ps` call per event, `kern.boottime` with and without `sec`, `$TMPDIR` used only on macOS and only without `XDG_RUNTIME_DIR`, the folder checks applied to it), staying silent outside herdr, falling back to herdr on `PATH` when `HERDR_BIN_PATH` is missing (relative `PATH` entries excluded), `bin/run.sh` running no tool from a relative `PATH` entry, deciding the pane session (one `claude` ancestor updates even when herdr reports a stale `agent_session`, a wrapper named claude still updates, a nested `claude -p` is skipped unless herdr reports its session, tested with a real process tree), the state folder checks (symlink, mode, owner, planted symlinks), parallel updates without a lock (real processes with 8 hooks that all start, all stop, each start and stop right away, and mix starts with stops, while a fake herdr applies herdr's rule of accepting only a larger seq in the order the reports arrive, the report left on screen always equal to the files, equal seqs allowed but every report carrying a phase's newest seq equal to the files; a hook taking the same seq in the middle of another one, both reports correct; every combination of one hook running inside another at its seq or report step, plus random nested interleavings; no loss with 8 hooks fired at once next to any kind of lock left by the previous version), the overall budget staying at most half of the `settings.json` timeout, and running the script for real with a fake herdr executable (checking exit 0, empty stdout, and finishing within 1 second).
