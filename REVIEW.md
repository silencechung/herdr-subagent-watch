# REVIEW.md

For code reviewers: use this file to decide whether to review, what to check, and how to rate each finding. Project background and constraints are in `CLAUDE.md`; runtime details are in `docs/internals.md`.

## When to review

First, check the scope of the change: a branch about to merge into main, or a small change.

- Review once before a branch merges into main, covering the whole branch.
- Do not review small changes: a single commit touching one or two files with no architectural change.
- Before each commit, run only syntax / type checks (this repo has no type check; run `node --check` on changed `.mjs` files). Do not review.
- If there are no findings, reply "No findings" in one line. Do not invent comments.

## What to look at / what to skip

First, read the hard constraints in `CLAUDE.md`, then the parts of `docs/internals.md` that the diff touches.

Look at:

- Layering: `lib/*.mjs` must not touch the TTY, raw mode, or `process.exit`; those belong in the entry files (`viewer.mjs`, `open-action.mjs`, `scripts/setup.mjs`). Imports between `lib` modules go one way, no cycles.
- Public API changes: action ids and entrypoints in `herdr-plugin.toml`, `bin/run.sh` arguments, environment variables such as `SUBAGENT_WATCH_*`, `setup.mjs` flags, and the marker block format. If one changes, check that callers and `README.md` change with it.
- Swallowed errors: a new empty `catch` must match an expected case (missing file, broken or incomplete JSONL line). Other errors must show on screen or in the log.
- Conflicts with the stack:
  - A third-party package or `package.json` was added.
  - Hard-coded node, herdr, or `~/.claude` paths.
  - Colors outside ANSI 16.
  - Transcript text drawn to the terminal without the sanitize in `lib/text.mjs`.
- Terminal state: every exit path (`q`, `Ctrl+C`, SIGTERM, SIGHUP, exceptions) restores raw mode and mouse reporting.
- setup / remove: rerunning gives the same result, `--dry-run` writes nothing, only content between the markers changes, and the backup is made only once.
- Linux and macOS both work: paths and commands are not written for one platform only.
- Bilingual docs: if `README.md` or `docs/*.md` changes, its `.zh-TW` version changes too.

Skip:

- Formatting, indentation, naming style.
- Comments that only narrate what was changed.
- Behavior already covered by `test/*.test.mjs` with those tests passing.

## Severity

First, rate each finding and state the evidence (file, line, which rule above it breaks).

- blocker: must be fixed before merging into main. Examples: terminal not restored on exit, transcript not sanitized, a package added.
- should: fix now, or record it as a to-do (say where, such as a GitHub issue or the project's to-do list) and then merge. Examples: an error swallowed without being reported, bilingual docs out of sync.
- nit: optional. Example: a variable name could be clearer.
