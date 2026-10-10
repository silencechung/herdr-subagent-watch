# herdr-subagent-watch

English | [繁體中文](README.zh-TW.md)

A herdr plugin to watch Claude Code sub agents live: a popup viewer and a sidebar tree.

- **Popup viewer**: press `prefix+.` in a pane running Claude Code and a popup shows what the sub agents of *that pane's* session are doing, one tab per sub agent. Finished sub agents keep their tab, so you can still read what they did.
- **Sidebar tree**: under the claude row of the herdr sidebar, the sub agents that are still running are listed (see [`docs/sidebar.md`](docs/sidebar.md)). The sidebar keeps no history: a row disappears as soon as its sub agent ends.

Pure Node.js built-in modules, no `npm install`.

> **Claude Code only.** The plugin reads Claude Code's transcripts and its `SubagentStart` / `SubagentStop` hooks. In a pane running another agent, the popup shows `This pane is not running Claude Code (detected: <agent>)`.

Nothing is hard-coded (paths, accounts, colors): node is located by `bin/run.sh`, herdr is called through `HERDR_BIN_PATH` (or `herdr` on `PATH` when that is not set), Claude Code config follows `CLAUDE_CONFIG_DIR`, and colors are only the 16 ANSI colors of your terminal theme.

## Requirements

- herdr ≥ 0.9.3
- Node.js ≥ 22 (see [How Node is found](#how-node-is-found))
- Claude Code
- Linux (the sidebar hook relies on `/proc` and `XDG_RUNTIME_DIR`)

## Install

```sh
herdr plugin install silencechung/herdr-subagent-watch
```

For local development, link a checkout instead:

```sh
herdr plugin link <path>
```

## Setup

```sh
herdr plugin action invoke subagent.watch.setup
```

Then press `prefix+.` in a pane running Claude Code.

The `subagent.watch.setup` action edits two of your own config files. The result is shown as a herdr notification; the details (including any snippet you need to paste by hand, and the plugin directory on the `plugin:` line) are in `herdr plugin log list --plugin subagent.watch`.

1. **Claude Code**: in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, adds one entry each to `hooks.SubagentStart` and `hooks.SubagentStop`: `sh "<plugin dir>/bin/run.sh" "<plugin dir>/hooks/sidebar-hook.mjs"` (timeout 5 seconds).
   - A hook that already points at `sidebar-hook.mjs` is replaced in place, not added twice.
   - No other hook is touched.
2. **herdr**: in `$HERDR_CONFIG_PATH`, or `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml` when that is not set. Everything added is wrapped between `# >>> subagent.watch` and `# <<< subagent.watch`.
   - Key binding: a `[[keys.command]]` for `prefix+.` is added only when nothing else uses `prefix+.`. If another action already has it, setup skips it and the log includes a snippet you can use to bind a different key.
   - Sidebar rows: if there is no `[ui.sidebar.agents.rows_by_agent]`, the whole table is added; if the table exists but has no `claude =`, the rows are inserted right below the table header; if you already have your own `claude =` without `$sub1`, it is left alone and the log includes the five lines to paste yourself.
   - After writing, setup runs `herdr config check`. If it reports new problems, the original file is restored and the error is reported; only when it passes does setup run `herdr server reload-config`.

Notes:

- Both files are backed up to `<file name>.subagent-watch.bak` in the same folder before being written (only when something actually changes).
- Idempotent: running it again gives the same result, and nothing is written when everything is already set up.
- To preview the changes, run `sh bin/run.sh scripts/setup.mjs --dry-run` in the plugin directory. It only prints the changes: no file is written and herdr is not called.
- The config paths come from `CLAUDE_CONFIG_DIR`, `HERDR_CONFIG_PATH` and `XDG_CONFIG_HOME` in the environment that runs setup; the action runs with the herdr server's environment. If the paths are wrong, run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory instead.
- After reinstalling with `herdr plugin install` the plugin directory may move. Run setup again and it points the hooks to the new location.

## Usage

### Popup viewer

Press `prefix+.` in a pane running Claude Code. Setup binds `prefix+.` to the action `subagent.watch.open`, which opens the popup for the pane you pressed it in. The popup opens and closes only when you ask: it does not close by itself when all sub agents have finished.

| Key | Action |
| --- | --- |
| `←` / `→` | Switch tab (wraps around) |
| `↑` / `↓` | Scroll one line (one wrapped screen line; the same unit below) |
| `PgUp` / `PgDn` | Scroll one page |
| `Home` | Jump to the oldest line |
| `End` | Jump to the newest line and resume follow |
| Mouse wheel | Scroll 3 lines (see [known limitations](#troubleshooting-and-known-limitations)) |
| `q` / `Esc` / `Ctrl+C` | Close |

Tab bar:

- It looks like `2 running · 3 done │ ◀ [● Explore] [● general-purpose] [✓ claude-code-guide] ▶`.
- Colors follow your terminal theme: only bold, dim, reverse and the 16 ANSI colors, no hard-coded color values.
- The left end is always a running / finished count. The running number is ANSI magenta; the rest is dim.
- Each tab starts with its status: `●` running (default text color with a magenta `●`), `✓` finished (the whole tab dim). The selected tab is reverse video + bold.
- Tabs have no numbers, so there is no 1–9 jump. Finished tabs stay, ordered by start time; a status change does not reorder them.
- Tab names come from the sub agent's `agentType`; when the same type appears more than once, a piece of its `description` is appended.
- A new tab appears as soon as a new `agent-*.jsonl` shows up (`fs.watch` on `subagents/`, with 1-second polling as a fallback). The first time there are tabs, the newest running sub agent is selected; after that the selection follows that agent, so a new tab never steals the one you are reading.
- When the output is not a TTY (`--once` redirected to a file or a pipe), the same structure is printed as plain text.

Events:

- Format: `HH:MM:SS  <tool>  <argument summary>`. The summary is `command` for Bash, `file_path` for Read / Edit / Write, `pattern` for Grep, `url` for WebFetch, `description` for Agent, and the first string field for any other tool. Thinking shows as `thinking...`. Only the assistant's `tool_use` and thinking are shown, never `tool_result` content.
- Long summaries wrap; continuation lines are indented to the summary column (the time and tool columns stay blank). Width is measured in display width: characters whose Unicode East Asian Width is W or F (CJK, full-width forms, and emoji such as `✅` `🚀`) count as 2, and wide characters are never cut in half.
- Multi-line content (for example a Bash heredoc) keeps its line breaks and indentation, and each line wraps on its own. Tabs become 4 spaces.
- Escape sequences (CSI, OSC such as OSC 52 / OSC 8, DCS, and their 8-bit C1 forms), other control characters and Unicode format characters (bidi overrides, zero-width space, BOM) are removed from transcripts, meta files and herdr output before anything is drawn, so a transcript cannot write the clipboard, add links or clear the screen.
  - A string sequence (OSC, DCS, SOS, PM, APC) is removed up to its terminator (BEL or ST). Without a terminator only its introducer is removed and the text after it stays, so a stray `U+009D` (common in cp1252 mojibake) does not swallow the rest of the summary.
  - ZWJ (`U+200D`) and ZWNJ (`U+200C`) are kept, with zero width, so emoji sequences such as 👨‍👩‍👧 and scripts such as Persian are not broken apart.
- When a tool name is wider than the tool column (10 cells), for example `SubagentHandback`, the tool name takes its own line and the summary starts on the next line in the summary column, so every event's summary lines up in the same column.
- One event takes at most 20 lines; beyond that, line 20 shows `… (+N more lines)` (dim).
- Resizing re-wraps everything; while follow is paused, the scroll position stays on the same event.

Scrolling:

- Every event of every sub agent is kept (no limit; the whole transcript is read when the popup opens), so you can scroll back to the very first line. The scroll unit is a wrapped screen line.
- Follow is on by default: new events scroll the view to the newest line.
- Scrolling up pauses follow, and the start of the bottom hint bar shows `↓ N new` (how many screen lines arrived since the pause). Press `End` or scroll back to the bottom to resume follow.
- Each tab remembers its own scroll position; switching tabs does not affect other tabs.
- Bottom hint bar: `<-/-> switch  ↑/↓ PgUp/PgDn scroll  End follow  q close`, shortened automatically in narrow windows.
- Mouse: SGR mouse reporting (`\x1b[?1000h\x1b[?1006h`) is turned on while the popup is open to receive wheel events, and always turned off on exit (`q`, `Esc`, `Ctrl+C`, SIGTERM, SIGHUP and unexpected exceptions all turn it off).
- Before any sub agent exists, the popup shows `No sub agents yet in this session`.

You can also open the popup without the action: `herdr plugin pane open --plugin subagent.watch --entrypoint viewer`. The viewer then uses the `focused_pane_id` from the popup's own context JSON.

### Sidebar

Under the claude row of the herdr sidebar, up to 5 lines show the sub agents of that session that are **still running**:

```
claude
├─ Explore ●
├─ general-purpose ●
└─ Plan ●
```

- Only running sub agents (`●`) are listed, without numbers. When a sub agent ends (`SubagentStop`), its line is removed and the rest are redrawn.
- With more than 5 running, the fifth line becomes `└─ +N more`.
- With nothing running, only the claude row is left.
- Finished sub agents and what they did are in the popup viewer.

Details are in [`docs/sidebar.md`](docs/sidebar.md).

## Remove

```sh
herdr plugin action invoke subagent.watch.remove
herdr plugin uninstall subagent.watch    # if you linked it: herdr plugin unlink subagent.watch
```

- Run remove **before** uninstall: after uninstalling, the action no longer exists.
- `subagent.watch.remove` only removes the hooks in `settings.json` that point at `sidebar-hook.mjs` (an event array left empty is removed entirely) and the content between the markers in `config.toml`. Like setup, it backs up first, runs `herdr config check`, then `herdr server reload-config`.

What remove does not touch:

- Settings you added by hand outside the markers are not deleted; the log lists their line numbers.
- Your other hooks and the rest of both files.
- Sidebar rows already on screen stay until that pane reports again or herdr restarts. To clear them right away, see [How to remove](docs/sidebar.md#how-to-remove) in `docs/sidebar.md`.

## How it works

### Which session a pane maps to

The pane id comes from, in order: `SUBAGENT_WATCH_PANE_ID` (passed in by the open action) → `focused_pane_id` in the context JSON → `HERDR_PANE_ID` (when not running in a popup). With a pane id, the viewer first asks herdr (`herdr pane get <pane>`) which `agent` herdr detected:

| herdr reports (tested on 0.9.3) | Viewer shows |
| --- | --- |
| No `agent` key (plain shell) | `No Claude Code session in this pane` |
| `agent` is something else (e.g. `"codex"`) | `This pane is not running Claude Code (detected: codex)` |
| `agent` is `"claude"` | Looks up the session (1 → 2 → 3 below) |

In the two "not Claude Code" cases the viewer does not guess a session. It asks again every 2 seconds, so starting Claude Code in that pane later connects automatically.

1. **herdr**: `agent_session` (reported by herdr's claude integration; observed as `{"agent":"claude","kind":"id","source":"herdr:claude","value":"<session-id>"}`). The session id is used to find `<session-id>.jsonl` under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/`. herdr's answer can be stale: after the herdr server restarted, a new Claude Code started in the same pane was still reported with the session from before the restart (observed; the cause is not known).
2. **Pane map**: `$XDG_RUNTIME_DIR/subagent-watch/pane-<paneId>.json`, written by the sidebar hook (`sessionId`, `transcriptPath`, `cwd`, `updatedAtMs`). It is only written on `SubagentStart` / `SubagentStop`, so after `/resume` or restarting `claude` it points at the previous session until the next sub agent starts.
3. **Guess**, only when neither herdr nor the pane map names a session: the pane's cwd is mapped to `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd with / replaced by ->/` and the most recently modified `<session-id>.jsonl` is used. The bottom separator then shows `(guessed: latest session)`: with several Claude Code sessions in the same folder, the guess can be wrong. Both `/var/home/...` and `/home/...` spellings are tried (Fedora Atomic keeps home under `/var/home`), plus a spelling with every non-alphanumeric character replaced by `-` (not verified whether Claude Code encodes paths containing `.` that way).

Since either of the first two can be out of date, neither one always wins. Both belong to this pane, and only one Claude Code in a pane writes its transcript at a time, so of the two the session whose transcript exists and was written most recently is used (on a tie, herdr's). When they name different sessions, the bottom separator adds `herdr says session <id>, pane map says <id>`. When neither transcript exists yet (a session that has just started and not written anything), the viewer waits for the session herdr reported (otherwise the pane map's) instead of falling back to a guess.

If herdr cannot be asked (herdr not found, or `herdr pane get` fails), only the pane map is left before the guess; without any pane id it can only guess (3). When nothing is found it shows `No Claude Code session found for this pane` plus the reason each step failed.

The lookup keeps running every 2 seconds after a session is found. A lookup that names a different session replaces the one on screen only when:

- the current session is a guess and the new one comes from herdr or the pane map;
- neither is a guess, and the new transcript was written more recently than the current one or the current transcript no longer exists;
- both are guesses and the current transcript no longer exists.

So after `/resume` or restarting `claude`, the popup switches to the new transcript as soon as it is written (rebuilding the tabs and updating the session label), while herdr briefly failing and falling back to an older pane map does not bring the previous session back. A guess never replaces a session that came from herdr or the pane map, and a lookup that finds nothing keeps the session on screen. With two sessions in the same folder writing in turn, a guessed session stays put instead of switching back and forth. If the lookup itself fails with an error while a session is on screen, the error is shown on the bottom separator and cleared by the next successful lookup. Lookups run asynchronously and one at a time, and `herdr pane get` times out after 3 seconds, so `q` / `Esc` close the popup right away even while herdr is stuck.

### Data sources and when a sub agent counts as finished

- Sub agent transcript: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` next to it (`agentType`, `description`). Only newly appended bytes are read, at most 8 MB at a time; broken or incomplete lines, and single lines longer than 64 MB, are skipped. A file that shrinks is read again from the start. This format is internal to Claude Code and may change between versions.
- A sub agent is shown as finished (`✓`) when any of these holds. The rules are based on the 154 real sub agent transcripts (with their meta files) examined during development:
  1. The sub agent JSONL contains a `tool_use` of `SubagentHandback` (117 sub agents ended this way, including the only foreground one).
  2. An assistant entry has `stop_reason` `end_turn`, but only for sub agents that are not background: meta `isFork: true`, or a `requestShape` other than `"background"`. The 31 `fork` sub agents have no `SubagentHandback` and all ended this way. Background sub agents ignore `end_turn`: 6 of them hit `end_turn` mid-run, were sent a `[handback-send-enforce]` prompt and only finished with `SubagentHandback` afterwards, so counting `end_turn` made them flash `✓` for a few seconds.
  3. The main transcript has a `<task-notification>` whose `<task-id>` is this agent and whose `<status>` is `completed` / `killed` / `failed` (a killed sub agent has no other signal). Only `queue-operation` lines whose content starts with `<task-notification>` count: every notification in the sample was written that way, and the same tag quoted in a user message, a queued message or a tool result is ignored.
  4. Fallback: the transcript has not been written for 10 minutes. The threshold matches the 10-minute maximum of a single Bash tool call, so a sub agent waiting on a command is not marked finished. The end line then reads `no writes for 10 min`; if the transcript is written again, the tab goes back to `●`.
- An end signal older than the last assistant activity does not count: a resumed sub agent goes back to `●`.
- Foreground sub agents: the sample has only one (`"requestShape":"foreground"`), and it ended with `SubagentHandback` (rule 1). Rule 2 (`end_turn`) still applies to them; whether a foreground sub agent can also stop at `end_turn` mid-run is **not verified**.

### Sidebar tree

Claude Code fires the `SubagentStart` / `SubagentStop` hooks; `hooks/sidebar-hook.mjs` (run through `bin/run.sh`) updates a state file and calls `herdr pane report-metadata` to write the tree lines into pane tokens `sub1`…`sub5`, which the `claude` rows added by setup display. The hook also writes the pane map used in step 2 above. The hook applies to every Claude Code session, so it always exits 0, prints nothing and finishes within its time budget. See [`docs/sidebar.md`](docs/sidebar.md) for the details.

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
- **Setup wrote to the wrong config file**: the action uses the herdr server's environment; run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory (see [Setup](#setup)).
- **`(guessed: latest session)` in the popup**: the session was guessed from the pane's cwd and may be the wrong one when several Claude Code sessions share a folder. It was the newest one when it was guessed and stays until herdr or the pane map names a session or its transcript is removed (see [Which session a pane maps to](#which-session-a-pane-maps-to)).
- `◀ ▶ ● ─ │ · … ↑ ↓` are East Asian ambiguous width characters. With a terminal set to treat ambiguous width as wide, the layout breaks.
- Only characters whose East Asian Width is W or F (Unicode 16.0) count as 2 columns. Symbols that some terminals draw wide only with a variation selector (for example `❤️`) can be measured differently from how the terminal draws them. An emoji ZWJ sequence is measured as the sum of its parts (👨‍👩‍👧 counts as 6 columns), so a terminal that joins it into one glyph draws it narrower than measured.
- Whether herdr forwards the mouse wheel to the popup is **not verified**. If the wheel does nothing, use `↑` / `↓`.
- With mouse reporting on, selecting text by dragging inside the viewer is captured by the viewer, so nothing gets selected. Some terminals let you hold Shift while dragging to get around this; whether that works inside a herdr popup is not verified.
- When reading the transcript, a summary keeps only its first 20 lines and at most 8000 columns in total (enough to fill 20 lines in a 400-column summary column). In `+N`, each cut original line counts as one line, so the real number of screen lines can be higher when an original line is very long.
- In narrow windows the summaries stay; the tab bar shows only a few tabs around the selected one, and an arrow at either end turns magenta when tabs are hidden on that side. When a single tab is wider than the space left, only its name is cut (ending in `…`); the status symbol is always visible.
- Setup has no TOML parser and works line by line. Forms it does not understand (multi-line strings, `rows_by_agent` written as an inline table, and so on) are skipped, or rejected by `herdr config check` and restored. In that case paste the snippet from the log by hand.
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

## License

[MIT](LICENSE)
