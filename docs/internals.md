# herdr-subagent-watch internals

English | [繁體中文](internals.zh-TW.md)

Details for anyone who wants to know how the plugin works or work on it. For installing and everyday use, see the [README](../README.md); the sidebar has its own page, [`sidebar.md`](sidebar.md).

## Setup details

The `subagent.watch.setup` action edits two of your own config files. The result is shown as a herdr notification; the details (including any snippet you need to paste by hand, and the plugin directory on the `plugin:` line) are in `herdr plugin log list --plugin subagent.watch`.

1. **Claude Code**: in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, adds one entry each to `hooks.SubagentStart`, `hooks.SubagentStop`, `hooks.SessionStart`, `hooks.Stop` and `hooks.StopFailure`, all with the same command: `sh "<plugin dir>/bin/run.sh" "<plugin dir>/hooks/sidebar-hook.mjs"` (timeout 5 seconds).
   - A hook this plugin added earlier (even from an older plugin folder), or the older hand-written form `<absolute node path> <absolute path>/hooks/sidebar-hook.mjs`, is replaced in place, not added twice. Another tool's hook that merely has a file named `sidebar-hook.mjs` does not count.
   - No other hook is touched; your own `SessionStart` / `Stop` / `StopFailure` hooks stay, and this entry is added after them.
   - **Already set up with an older version** (only `SubagentStart` / `SubagentStop`)? Run setup again: it adds `SessionStart`, `Stop` and `StopFailure` and leaves the existing two as they are. Each event is checked on its own, so whichever are missing get added and none is added twice. Until then the popup uses the older session lookup, and a sub agent that ended without its `SubagentStop` leaves the sidebar count only at a `SubagentStart` / `SubagentStop` of another sub agent of the same session that comes 2 minutes or more after its last write: the cleanup runs on every event, but only those two events are hooked. A Claude Code session that was already running gets its session mapping at its next `SessionStart` (restart, `/resume`, `/clear` or compaction).
2. **herdr**: in `$HERDR_CONFIG_PATH`, or `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml` when that is not set. Everything added is wrapped between `# >>> subagent.watch` and `# <<< subagent.watch`.
   - Key binding: a `[[keys.command]]` for `prefix+.` is added only when nothing else uses `prefix+.`. If another action already has it, setup skips it and the log includes a snippet you can use to bind a different key.
   - Sidebar rows: if there is no `[ui.sidebar.agents.rows_by_agent]`, the whole table is added; if the table exists but has no `claude =`, the rows are inserted right below the table header; if you already have your own `claude =` without `$sub1`, it is left alone and the log includes the line to paste yourself. Claude rows that already contain `$sub1`, including the five `$sub1`…`$sub5` lines written by an older setup, count as set up and are not rewritten (see [What setup adds](sidebar.md#what-setup-adds)).
   - The new content is first written to a temporary file next to the config file and checked with `herdr config check`. If it reports new problems, the temporary file is deleted and the error is reported (the original file was never touched, so there is nothing to restore); only when it passes is the temporary file `rename`d into place and `herdr server reload-config` run.

Notes:

- Before a change, both files are backed up to `<file name>.subagent-watch.bak` in the same folder, **only the first time**: an existing `.bak` is never overwritten, so the earliest original is kept (delete the old `.bak` yourself if you want a fresh one).
- Idempotent: running it again gives the same result, and nothing is written when everything is already set up.
- To preview the changes, run `sh bin/run.sh scripts/setup.mjs --dry-run` in the plugin directory. It only prints the changes: no file is written and herdr is not called.
- The config paths come from `CLAUDE_CONFIG_DIR`, `HERDR_CONFIG_PATH` and `XDG_CONFIG_HOME` in the environment that runs setup; the action runs with the herdr server's environment. If the paths are wrong, run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory instead.
- After reinstalling with `herdr plugin install` the plugin directory may move. Run setup again and it points the hooks to the new location.

## Remove details

- Run remove **before** uninstall: after uninstalling, the action no longer exists.
- `subagent.watch.remove` only removes this plugin's hooks from `settings.json` (recognized the same way as in setup; an event array left empty is removed entirely) and the content between the markers in `config.toml`. Backups and `herdr config check` work the same way as in setup; then it runs `herdr server reload-config`.

What remove does not touch:

- Settings you added by hand outside the markers are not deleted; the log lists their line numbers.
- Your other hooks and the rest of both files.
- The sidebar line already on screen stays until that pane reports again or herdr restarts. To clear it right away, see [How to remove](sidebar.md#how-to-remove) in `docs/sidebar.md`.

## Popup viewer details

Press `prefix+.` in a pane running Claude Code. Setup binds `prefix+.` to the action `subagent.watch.open`, which opens the popup for the pane you pressed it in. The popup opens and closes only when you ask: it does not close by itself when all sub agents have finished.

| Key | Action |
| --- | --- |
| `←` / `→` | Switch tab (wraps around) |
| `0`–`9` | Jump to the tab with that number (see below) |
| Mouse click on the tab bar | A number or the selected tab: switch to it; `◀` / `▶`: previous / next tab, same as `←` / `→` |
| `↑` / `↓` | Scroll one line (one wrapped screen line; the same unit below) |
| `PgUp` / `PgDn` | Scroll one page |
| `Home` | Jump to the oldest line |
| `End` | Jump to the newest line and resume follow |
| Mouse wheel | Scroll 3 lines (see [known limitations](#troubleshooting-and-known-limitations)) |
| `q` / `Esc` / `Ctrl+C` | Close |

Tab bar:

- It looks like `2 running · 3 done │   1 [2 ● general-purpose] 3 4 5`: the selected tab shows its number, status and name; every other tab shows only its number.
- Colors follow your terminal theme: only bold, dim, reverse and the 16 ANSI colors, no hard-coded color values.
- The left end is always a running / finished count. The running number is ANSI magenta; the rest is dim.
- The selected tab is `[<number> <status> <name>]` in reverse video + bold, with `●` for running and `✓` for finished. Other tabs are bare numbers: bold while running, dim once finished (no color, only text attributes).
- Numbers start at 1 and are the tab's place in the full list, ordered by start time. Finished tabs stay and a status change does not reorder them; scrolling the visible part of the tab bar does not change any number. Two- and three-digit numbers are shown as they are, without zero padding.
- Typing a number jumps to that tab. When the digits typed so far could still be the start of a longer number (for example `1` with 14 tabs, which could become 10–14), the viewer waits 600 ms for the next digit and then jumps to what was typed; when no longer number is possible (`2`–`9` with fewer than 20 tabs) it jumps right away. A number starting with `0` or larger than the tab count is ignored and cleared. Any other key while typing drops the typed digits and then does what it normally does. The wait never blocks redrawing.
- Clicking works on the tab bar only: a number or the selected tab switches to that tab, `◀` / `▶` move to the previous / next tab; clicks anywhere else are ignored. Only the left-button press counts (the release is ignored), and the clickable columns are taken from what was last drawn, using the same display width as the drawing (CJK and emoji count as 2).
- Tab names come from the sub agent's `agentType`; when the same type appears more than once, a piece of its `description` is appended.
- A new tab appears as soon as a new `agent-*.jsonl` shows up (`fs.watch` on `subagents/`, with 1-second polling as a fallback). The first time there are tabs, the newest running sub agent is selected; after that the selection follows that agent, so a new tab never steals the one you are reading.
- When the output is not a TTY (`--once` redirected to a file or a pipe), the same structure is printed as plain text.

Events:

- Format: `HH:MM:SS  <tool>  <argument summary>`. The summary is `command` for Bash, `file_path` for Read / Edit / Write, `pattern` for Grep, `url` for WebFetch, `description` for Agent, and the first string field for any other tool. Thinking shows as `thinking...`. Only the assistant's `tool_use` and thinking are shown, never `tool_result` content.
- Long summaries wrap; continuation lines are indented to the summary column (the time and tool columns stay blank). Width is measured in display width: characters whose Unicode East Asian Width is W or F (CJK, full-width forms, and emoji such as `✅` `🚀`) count as 2, and wide characters are never cut in half.
- Multi-line content (for example a Bash heredoc) keeps its line breaks and indentation, and each line wraps on its own. Tabs become 4 spaces.
- Escape sequences (CSI, OSC such as OSC 52 / OSC 8, DCS), other control characters including the 8-bit C1 controls, and Unicode format characters (bidi overrides, zero-width space, BOM) are removed from transcripts, meta files and herdr output before anything is drawn, so a transcript cannot write the clipboard, add links or clear the screen.
  - A string sequence starting with ESC (OSC, DCS, SOS, PM, APC) is removed up to its terminator (BEL or ST). Without a terminator only its introducer is removed and the text after it stays, so it does not swallow the rest of the summary.
  - An 8-bit C1 control (`U+0080`–`U+009F`, including the 8-bit forms of CSI, OSC and DCS) is removed on its own and never takes the text after it along: once it is gone the terminal sees no sequence, and latin1 / cp1252 mojibake often has `U+009D` … `U+009C` pairs around ordinary text (`“a” and “b”` read as latin1).
  - ZWJ (`U+200D`) and ZWNJ (`U+200C`) are kept, with zero width, so emoji sequences such as 👨‍👩‍👧 and scripts such as Persian are not broken apart.
- When a tool name is wider than the tool column (10 cells), for example `SubagentHandback`, the tool name takes its own line and the summary starts on the next line in the summary column, so every event's summary lines up in the same column.
- One event takes at most 20 lines; beyond that, line 20 shows `… (+N more lines)` (dim).
- Resizing re-wraps everything; while follow is paused, the scroll position stays on the same event.

Scrolling:

- Every event of every sub agent is kept (no limit; the whole transcript is read when the popup opens), so you can scroll back to the very first line. The scroll unit is a wrapped screen line.
- Follow is on by default: new events scroll the view to the newest line.
- Scrolling up pauses follow, and the start of the bottom hint bar shows `↓ N new` (how many screen lines arrived since the pause). Press `End` or scroll back to the bottom to resume follow.
- Each tab remembers its own scroll position; switching tabs does not affect other tabs.
- Bottom hint bar: `<-/-> 0-9 click switch  ↑/↓ PgUp/PgDn scroll  End follow  q close`, shortened automatically in narrow windows (`click` is dropped first, `0-9` last).
- Mouse: SGR mouse reporting (`\x1b[?1000h\x1b[?1006h`) is turned on while the popup is open to receive wheel events and clicks, and always turned off on exit (`q`, `Esc`, `Ctrl+C`, SIGTERM, SIGHUP and unexpected exceptions all turn it off).
- Before any sub agent exists, the popup shows `No sub agents yet in this session`.

You can also open the popup without the action: `herdr plugin pane open --plugin subagent.watch --entrypoint viewer`. The viewer then uses the `focused_pane_id` from the popup's own context JSON.

## Sidebar

Under the claude row of the herdr sidebar, one line shows how many sub agents of that session are **still running**:

```
claude
● 3 running
```

- Only the number is shown, without names and without an upper limit. A `SubagentStart` adds one, except when it resumes a sub agent that is still counted (its previous `SubagentStop` was missed, so its file is still there): that only replaces the start time and the number stays the same. A `SubagentStop` subtracts one; one without a `SubagentStart` seen earlier changes nothing.
- A sub agent that ended without `SubagentStop` (for example stopped by an API error such as a usage limit) is removed at the first hook event of that session that comes 2 minutes or more after its last write, for example when the main session finishes its next turn (`Stop`, or `StopFailure` when that turn itself ends with an API error). This is only a safety net: a sub agent without an end signal (or a resumed one whose new run has not written anything yet) is never removed, however long it is silent.
- When the pane switches to another session (a new `claude`, `/clear`, `/resume`), the count is redrawn for that session right away.
- With nothing running, the line disappears and only the claude row is left.
- Finished sub agents and what they did are in the popup viewer.

Details are in [`docs/sidebar.md`](sidebar.md).

## How it works

Nothing is hard-coded (paths, accounts, colors): node is located by `bin/run.sh`, herdr is called through `HERDR_BIN_PATH` (or `herdr` on `PATH` when that is not set), Claude Code config follows `CLAUDE_CONFIG_DIR`, and colors are only the 16 ANSI colors of your terminal theme.

### Which session a pane maps to

The pane id comes from, in order: `SUBAGENT_WATCH_PANE_ID` (passed in by the open action) → `focused_pane_id` in the context JSON → `HERDR_PANE_ID` (when not running in a popup). With a pane id, the viewer first asks herdr (`herdr pane get <pane>`) which `agent` herdr detected:

| herdr reports (tested on 0.9.3) | Viewer shows |
| --- | --- |
| No `agent` key (plain shell) | `No Claude Code session in this pane` |
| `agent` is something else (e.g. `"codex"`) | `This pane is not running Claude Code (detected: codex)` |
| `agent` is `"claude"` | Looks up the session (1 → 2 → 3 below) |

In the two "not Claude Code" cases the viewer does not guess a session. It asks again every 2 seconds, so starting Claude Code in that pane later connects automatically.

1. **herdr**: `agent_session` (reported by herdr's claude integration; observed as `{"agent":"claude","kind":"id","source":"herdr:claude","value":"<session-id>"}`). The session id is used to find `<session-id>.jsonl` under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/`. herdr's answer can be stale: after the herdr server restarted, a new Claude Code started in the same pane was still reported with the session from before the restart (observed; the cause is not known).
2. **Pane map**: `$XDG_RUNTIME_DIR/subagent-watch/pane-<paneId>.json`, written by the sidebar hook (`sessionId`, `transcriptPath`, `cwd`, `updatedAtMs`). The hook writes it on `SessionStart`, so it names the pane's session from the moment a session starts, is resumed or cleared; the file then also carries `sessionStartSource` as a mark (kept when sub agent events of the same session rewrite the file). Without the mark (written only on `SubagentStart` / `SubagentStop`: setup from an older version not run again yet, or a session that started before the hooks were added), it can point at the previous session until the next sub agent starts.
3. **Guess**, only when neither herdr nor the pane map names a session: the pane's cwd is mapped to `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd with / replaced by ->/` and the most recently modified `<session-id>.jsonl` is used. The bottom separator then shows `(guessed: latest session)`: with several Claude Code sessions in the same folder, the guess can be wrong. Both `/var/home/...` and `/home/...` spellings are tried (Fedora Atomic keeps home under `/var/home`), plus a spelling with every non-alphanumeric character replaced by `-` (not verified whether Claude Code encodes paths containing `.` that way).

**A pane map with the mark whose transcript exists is used as it is**: herdr's answer and write times are not compared, and the popup switches whenever the pane map names another session (the bottom separator still shows `herdr says session <id>, pane map says <id>` when herdr disagrees). Right after a new session starts, its transcript does not exist yet (with Claude Code 2.1.296 it is written after the first prompt); until it appears, the rules below apply.

Without the mark, either of the first two can be out of date, so neither one always wins. When the viewer has no session yet (or the transcript on screen was deleted), it uses the session whose transcript exists and was written most recently (on a tie, herdr's): both belong to this pane, and a stale value usually names an old session nobody is writing any more. When they name different sessions, the bottom separator adds `herdr says session <id>, pane map says <id>`. When neither transcript exists yet (a session that has just started and not written anything), the viewer waits for the session herdr reported (otherwise the pane map's) instead of falling back to a guess.

If herdr cannot be asked (herdr not found, or `herdr pane get` fails), only the pane map is left before the guess; without any pane id it can only guess (3). When nothing is found it shows `No Claude Code session found for this pane` plus the reason each step failed.

The lookup keeps running every 2 seconds after a session is found, but from then on write times alone never decide a switch. A stale value can name a session that another pane keeps writing (`claude -c` and `--resume` continue the same session id); the two transcripts then take turns being the newest, and following the newest one switched the popup back and forth every few seconds, losing the selected tab and the scroll position. Instead the viewer remembers the session herdr and the pane map each reported at their last successful lookup, and replaces the session on screen only when:

- the current session is a guess and the new one comes from herdr or the pane map;
- neither is a guess, and herdr or the pane map now reports a different session than before (its value changed), that session is not the one on screen, and its transcript exists. If both changed in the same lookup, the more recently written one wins. A source that reports a session for the first time (for example herdr failing at first and recovering later) only wins if that transcript was written more recently than the current one, and only that once;
- the current transcript no longer exists (the session is then picked again as described above);
- both are guesses and the current transcript no longer exists.

So after `/resume` or restarting `claude`, the popup switches to the new session as soon as herdr or the pane map reports it and its transcript exists (rebuilding the tabs and updating the session label). A failed lookup leaves what the viewer remembers unchanged, so herdr briefly failing, or coming back with the same stale value, does not bring a previous session back. A guess never replaces a session that came from herdr or the pane map, and a lookup that finds nothing keeps the session on screen. With two sessions in the same folder writing in turn, a guessed session stays put instead of switching back and forth. If the lookup itself fails with an error while a session is on screen, the error is shown on the bottom separator and cleared by the next successful lookup. Lookups run asynchronously and one at a time, and `herdr pane get` times out after 3 seconds, so `q` / `Esc` close the popup right away even while herdr is stuck.

### Data sources and when a sub agent counts as finished

- Sub agent transcript: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` next to it (`agentType`, `description`). Only newly appended bytes are read, at most 8 MB at a time; broken or incomplete lines, and single lines longer than 64 MB, are skipped. A file that shrinks is read again from the start. This format is internal to Claude Code and may change between versions.
- A sub agent is shown as finished (`✓`) when any of these holds. The rules are based on the 154 real sub agent transcripts (with their meta files) examined during development:
  1. The sub agent JSONL contains a `tool_use` of `SubagentHandback` (117 sub agents ended this way, including the only foreground one).
  2. An assistant entry has `stop_reason` `end_turn`, but only for sub agents that are not background: meta `isFork: true`, or a `requestShape` other than `"background"`. The 31 `fork` sub agents have no `SubagentHandback` and all ended this way. Background sub agents ignore `end_turn`: 6 of them hit `end_turn` mid-run, were sent a `[handback-send-enforce]` prompt and only finished with `SubagentHandback` afterwards, so counting `end_turn` made them flash `✓` for a few seconds.
  3. The main transcript has a `<task-notification>` whose `<task-id>` is this agent and whose `<status>` is `completed` / `killed` / `failed` (a killed sub agent has no other signal). Only `queue-operation` lines whose content starts with `<task-notification>` count: every notification in the sample was written that way, and the same tag quoted in a user message, a queued message or a tool result is ignored.
  4. Fallback: the transcript has not been written for 10 minutes. The threshold matches the 10-minute maximum of a single Bash tool call, so a sub agent waiting on a command is not marked finished. The end line then reads `no writes for 10 min`; if the transcript is written again, the tab goes back to `●`.
- An end signal older than the last assistant activity does not count: a resumed sub agent goes back to `●`.
- Foreground sub agents: the sample has only one (`"requestShape":"foreground"`), and it ended with `SubagentHandback` (rule 1). Rule 2 (`end_turn`) still applies to them; whether a foreground sub agent can also stop at `end_turn` mid-run is **not verified**.

### Sidebar count

Claude Code fires the `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` and `StopFailure` hooks (`StopFailure` fires instead of `Stop` when a turn ends with an API error); `hooks/sidebar-hook.mjs` (run through `bin/run.sh`) writes or removes one small file per running sub agent (no lock: hooks running in parallel only ever touch their own sub agent's file, and herdr's `--seq` keeps the newest report) and calls `herdr pane report-metadata` to write `● N running` into pane token `sub1`, which the `claude` rows added by setup display (`sub2`…`sub5`, used by older versions, are cleared on every report). The hook also writes the pane map used in step 2 above (on every event except `Stop` and `StopFailure`). On every event it also removes sub agents of that session whose transcript ends with an end signal (a `SubagentHandback`, an API error, an interruption, a task notification, and so on) from this run and has not been written for 2 minutes, because some of them never get a `SubagentStop`. The hook applies to every Claude Code session, so it always exits 0, prints nothing and finishes within its time budget. See [`docs/sidebar.md`](sidebar.md) for the details.

### How Node is found

The manifest's actions and pane, and the Claude Code hook, all go through `bin/run.sh` (POSIX sh), which uses the first node ≥ 22 from:

1. `SUBAGENT_WATCH_NODE` (when set, only this one is used; if it is not usable, it is an error)
2. `command -v node`, after checking that the file really exists and is executable. The herdr server's `PATH` may still contain a node that no longer exists (for example fnm's per-shell temporary path).
3. `aliases/default/bin/node` under `$FNM_DIR`, `${XDG_DATA_HOME:-~/.local/share}/fnm` and `~/.fnm`
4. `~/.volta/bin/node`
5. The newest version under `${NVM_DIR:-~/.nvm}/versions/node/*/bin/node`
6. `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`

## Troubleshooting and known limitations

- **Node.js 22+ not found** (or every candidate is older than 22): the reason is printed.
  - In the popup, it waits at `Press any key to close.` instead of vanishing immediately.
  - Actions also show a herdr notification.
  - The sidebar hook exits 0 silently so it never disturbs the Claude session.
  - To pick a specific node, set `SUBAGENT_WATCH_NODE` in the environment that starts herdr and Claude Code.
- **Setup wrote to the wrong config file**: the action uses the herdr server's environment; run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory (see [Setup details](#setup-details)).
- **`(guessed: latest session)` in the popup**: the session was guessed from the pane's cwd and may be the wrong one when several Claude Code sessions share a folder. It was the newest one when it was guessed and stays until herdr or the pane map names a session or its transcript is removed (see [Which session a pane maps to](#which-session-a-pane-maps-to)).
- **The popup stays on the previous session after starting a new one**:
  - With the `SessionStart` hook in place, this lasts only until the new session's transcript exists (in testing it was written after the first prompt).
  - Without it (setup from an older version not run again, or a session that started before the hooks were added): when herdr and the pane map are both stale (herdr kept an old value, and no sub agent has started in the new session yet), the popup switches only when the first sub agent starts and the hook updates the pane map. When the popup first picks a session it compares write times; if a stale value names a session another pane is still writing, that session can be picked. After that, the popup switches only when herdr or the pane map reports a different session than it last reported, or the transcript on screen is deleted (see [Which session a pane maps to](#which-session-a-pane-maps-to)).
- **The popup switches to a `claude -p` started from that pane**: only for a nested `claude -p` the hook cannot tell apart from the pane's own session (see Known limitations in [`docs/sidebar.md`](sidebar.md#known-limitations)). Its `SessionStart` writes the pane map with the mark, so the popup follows it until the pane's own session writes the pane map again (its next sub agent event or `SessionStart`).
- **The popup ends up on an older session and stays there**: only when the pane map has no `SessionStart` mark. Two cases where the rule above does this while the popup is open:
  - herdr's report changes back to an older session (for example the herdr server restoring an old value after a restart). That counts as a changed value, so the popup switches to that session without comparing write times, and stays there until herdr or the pane map reports a different session than it last reported. Whether the viewer survives a herdr server restart at all is not verified.
  - herdr or the pane map reports a session for the first time (for example the pane map did not exist when the popup opened and the hook writes it when a sub agent starts, or herdr failed at first and recovers), while another pane happened to write the old session's transcript at the same time or later. The popup stays on the old session, and write times are not compared again for that source.
  - In both cases, closing and reopening the popup picks the session again by write time, the same way as on first open.
- `◀ ▶ ● ─ │ · … ↑ ↓` are East Asian ambiguous width characters. With a terminal set to treat ambiguous width as wide, the layout breaks.
- Only characters whose East Asian Width is W or F (Unicode 16.0) count as 2 columns. Symbols that some terminals draw wide only with a variation selector (for example `❤️`) can be measured differently from how the terminal draws them. An emoji ZWJ sequence is measured as the sum of its parts (👨‍👩‍👧 counts as 6 columns), so a terminal that joins it into one glyph draws it narrower than measured.
- Whether herdr forwards the mouse wheel to the popup is **not verified**. If the wheel does nothing, use `↑` / `↓`. Left clicks were checked in a real herdr popup: herdr forwards them as SGR press / release with coordinates relative to the popup content (top-left is 1,1), and clicks outside the popup do nothing.
- With mouse reporting on, selecting text by dragging inside the viewer is captured by the viewer, so nothing gets selected. Some terminals let you hold Shift while dragging to get around this; whether that works inside a herdr popup is not verified.
- When reading the transcript, a summary keeps only its first 20 lines and at most 8000 columns in total (enough to fill 20 lines in a 400-column summary column). In `+N`, each cut original line counts as one line, so the real number of screen lines can be higher when an original line is very long.
- In narrow windows the tab bar shows only the numbers around the selected tab (adding one on each side in turn), with a magenta `◀` / `▶` on a side that has hidden tabs. With nothing hidden on the left, the `◀` position stays blank, so the numbers do not shift when it appears; with nothing hidden on the right, nothing is drawn. The selected tab is always fully visible: when it is wider than the space left, only its name is cut (ending in `…`), never its number or status symbol. If the window is too narrow for even the summary plus the selected tab's number and symbol, the summary is left out. The line never exceeds the window width.
- Setup has no TOML parser and works line by line. Forms it does not understand (multi-line strings, `rows_by_agent` written as an inline table, and so on) are skipped, or rejected by `herdr config check` (the original file is left untouched, so nothing needs restoring). In that case paste the snippet from the log by hand.
- If the plugin directory path contains `"`, `$`, `` ` `` or `\`, setup does not write the hooks (they would break the shell command); set them up by hand.

## Development

### Run modes

In the plugin directory:

```sh
sh bin/run.sh viewer.mjs                      # interactive mode (what the popup runs)
sh bin/run.sh viewer.mjs --once               # print one frame to stdout and exit 0; no TTY needed
sh bin/run.sh viewer.mjs --demo               # fake data with the same rules as the real thing (a new tab appears after 8 seconds)
sh bin/run.sh viewer.mjs --session <path>     # use a specific main transcript (<session-id>.jsonl)
sh bin/run.sh demo.mjs                        # same as viewer.mjs --demo
sh bin/run.sh scripts/setup.mjs [--remove] [--dry-run]
```

`node` works in place of `sh bin/run.sh` too; it just skips the node lookup.

### Tests

In the repo directory:

```sh
node --test 'test/*.test.mjs'
```

Node 22's `node --test` only accepts files or globs; passing a folder (`node --test test/`) treats it as a module to load and fails. The pty tests need util-linux's `script` and are skipped without it; the `herdr config check` tests are skipped when herdr is not found.

### Testing the open action without a popup

When `$HERDR_PLUGIN_STATE_DIR/dry-run` exists (or the command is given `--dry-run`), `open-action.mjs` only writes the context and the command it would run to `$HERDR_PLUGIN_STATE_DIR/open-action.log` and prints them to stdout, without opening a popup.

`open-action.mjs` reads `focused_pane_id` from `HERDR_PLUGIN_CONTEXT_JSON` and runs `herdr plugin pane open --plugin subagent.watch --entrypoint viewer --env SUBAGENT_WATCH_PANE_ID=<pane>`.
