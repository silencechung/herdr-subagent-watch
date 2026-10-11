# herdr-subagent-watch

English | [繁體中文](README.zh-TW.md)

A herdr plugin to watch Claude Code sub agents live: a popup viewer and a sidebar tree. Pure Node.js built-in modules, no `npm install`.

> **Claude Code only.** The plugin reads Claude Code's transcripts and its `SessionStart` / `SubagentStart` / `SubagentStop` / `Stop` / `StopFailure` hooks. In a pane running another agent, the popup shows `This pane is not running Claude Code (detected: <agent>)`.

## Requirements

- herdr ≥ 0.9.3
- Node.js ≥ 22 (found automatically, see [How Node is found](docs/internals.md#how-node-is-found))
- Claude Code
- Linux (the sidebar hook relies on `/proc` and `XDG_RUNTIME_DIR`)

## Install

```sh
herdr plugin install silencechung/herdr-subagent-watch   # for local development: herdr plugin link <path>
herdr plugin action invoke subagent.watch.setup
```

Then press `prefix+.` in a pane running Claude Code.

Setup edits two of your own config files: it adds the sidebar hook to Claude Code's `settings.json`, and the `prefix+.` key binding plus the sidebar rows to herdr's `config.toml`. Both files are backed up first, and running it again is safe. The result is shown as a herdr notification; the details are in `herdr plugin log list --plugin subagent.watch`. Conflict handling, backups and the `--dry-run` preview are in [Setup details](docs/internals.md#setup-details).

## Usage

**Popup viewer**: press `prefix+.` in a pane running Claude Code and a popup shows what the sub agents of *that pane's* session are doing, one tab per sub agent, one line per tool call (`HH:MM:SS  <tool>  <argument summary>`). Finished sub agents keep their tab, so you can still read what they did. The popup closes only when you close it.

**Sidebar tree**: under the claude row of the herdr sidebar, up to 5 lines list the sub agents that are still running. The sidebar keeps no history: a row disappears as soon as its sub agent ends. See [`docs/sidebar.md`](docs/sidebar.md).

| Key | Action |
| --- | --- |
| `←` / `→`, `0`–`9`, mouse click on the tab bar | Switch tab: previous / next (wraps around), the tab with that number, or the tab clicked |
| `↑` / `↓`, `PgUp` / `PgDn`, mouse wheel | Scroll one line, one page, or 3 lines; scrolling up pauses follow |
| `Home` / `End` | Jump to the oldest line / the newest line and resume follow |
| `q` / `Esc` / `Ctrl+C` | Close |

The tab bar, event format, scrolling and mouse details are in [Popup viewer details](docs/internals.md#popup-viewer-details).

## Remove

```sh
herdr plugin action invoke subagent.watch.remove
herdr plugin uninstall subagent.watch    # if you linked it: herdr plugin unlink subagent.watch
```

Run remove **before** uninstall: after uninstalling, the action no longer exists. Remove only takes out this plugin's hooks and its marked block in `config.toml`; see [Remove details](docs/internals.md#remove-details).

## Troubleshooting

- **No sidebar tree, or `prefix+.` does nothing**: check the setup log. Setup skips the key binding when another action already uses `prefix+.`, and leaves your own `claude =` sidebar rows alone; in both cases the log includes a snippet to paste yourself. Set up with an older version? Run setup again.
- **The popup shows the previous session, or `(guessed: latest session)`**: after starting a new session, the popup switches once the new transcript exists (it is written after the first prompt), as long as setup from this version has added the `SessionStart` hook. A guessed session comes from the pane's cwd and can be wrong when several Claude Code sessions share a folder. See [Which session a pane maps to](docs/internals.md#which-session-a-pane-maps-to).
- **`No Claude Code session in this pane`**: herdr reports no agent in that pane (a plain shell). The popup asks again every 2 seconds, so starting Claude Code in that pane later connects automatically.
- **Node.js 22+ not found**: the reason is printed. To pick a specific node, set `SUBAGENT_WATCH_NODE` in the environment that starts herdr and Claude Code.
- **Setup wrote to the wrong config file**: the action uses the herdr server's environment; run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory.

The full list, including known limitations, is in [Troubleshooting and known limitations](docs/internals.md#troubleshooting-and-known-limitations).

## More

- [`docs/sidebar.md`](docs/sidebar.md): how the sidebar tree works, what setup adds, and how to remove it by hand.
- [`docs/internals.md`](docs/internals.md): for anyone who wants to know how the plugin works or work on it: session lookup, when a sub agent counts as finished, run modes and tests.

## License

[MIT](LICENSE)
