# herdr-subagent-watch

English | [繁體中文](README.zh-TW.md)

A herdr plugin to watch Claude Code sub agents live in a popup. Pure Node.js built-in modules, no `npm install`.

> **Claude Code only.** The plugin reads Claude Code's transcripts and asks herdr which session a pane runs. In a pane running another agent, the popup shows `This pane is not running Claude Code (detected: <agent>)`.

## Requirements

- herdr ≥ 0.9.3
- Node.js ≥ 22 (found automatically, see [How Node is found](docs/internals.md#how-node-is-found))
- Claude Code
- Linux or macOS

## Install

```sh
herdr plugin install silencechung/herdr-subagent-watch   # for local development: herdr plugin link <path>
herdr plugin action invoke subagent.watch.setup
```

Then press `prefix+.` in a pane running Claude Code.

Setup adds the `prefix+.` key binding to herdr's `config.toml` (backed up first; running it again is safe). The result is shown as a herdr notification; the details are in `herdr plugin log list --plugin subagent.watch`. Conflict handling, backups and the `--dry-run` preview are in [Setup details](docs/internals.md#setup-details).

**Upgrading from a version with the sidebar count**: run setup again. The sidebar count is gone, and setup cleans up what the older version added: its hooks in Claude Code's `settings.json`, its sidebar rows in `config.toml`, and the files its hook left in `$XDG_RUNTIME_DIR/subagent-watch` (on macOS `$TMPDIR/subagent-watch`). Until you do, the old hooks stay in `settings.json` but do nothing.

## Usage

Press `prefix+.` in a pane running Claude Code and a popup shows what the sub agents of *that pane's* session are doing, one tab per sub agent, one line per tool call (`HH:MM:SS  <tool>  <argument summary>`). Each tab shows `●` while the sub agent runs, `◐` while it waits on background work it started itself (it resumes on its own when that work ends), and `✓` once it has finished. Finished sub agents keep their tab, so you can still read what they did. The popup closes only when you close it.

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

Run remove **before** uninstall: after uninstalling, the action no longer exists. Remove only takes out this plugin's marked blocks in `config.toml` and anything an older version added; see [Remove details](docs/internals.md#remove-details).

## Troubleshooting

- **`prefix+.` does nothing**: check the setup log. Setup skips the key binding when another action already uses `prefix+.`; the log then includes a snippet to paste yourself.
- **The popup shows the previous session, or `(guessed: latest session)`**: the popup follows the session herdr reports for the pane, once that session's transcript exists (it is written after the first prompt). Without a session from herdr it guesses from the pane's cwd, which can be wrong when several Claude Code sessions share a folder. See [Which session a pane maps to](docs/internals.md#which-session-a-pane-maps-to).
- **`No Claude Code session in this pane`**: herdr reports no agent in that pane (a plain shell). The popup asks again every 2 seconds, so starting Claude Code in that pane later connects automatically.
- **A tab stays `◐`**: the sub agent is waiting on its own background work. If that work cannot be checked (see [when a sub agent counts as finished](docs/internals.md#data-sources-and-when-a-sub-agent-counts-as-finished)), the tab stays `◐` until neither the sub agent nor the work's output file has changed for 10 minutes, then turns `✓` with `no change for 10 min while waiting`. A background shell that keeps writing its output (a dev server) keeps it `◐`.
- **Node.js 22+ not found**: the reason is printed. To pick a specific node, set `SUBAGENT_WATCH_NODE` in the environment that starts herdr.
- **Setup wrote to the wrong config file**: the action uses the herdr server's environment; run `sh bin/run.sh scripts/setup.mjs` from your own shell in the plugin directory.

The full list, including known limitations, is in [Troubleshooting and known limitations](docs/internals.md#troubleshooting-and-known-limitations).

## More

- [`docs/internals.md`](docs/internals.md): for anyone who wants to know how the plugin works or work on it: session lookup, when a sub agent counts as finished, run modes and tests.

## License

[MIT](LICENSE)
