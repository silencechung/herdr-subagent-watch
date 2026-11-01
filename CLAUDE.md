# herdr-subagent-watch

herdr plugin `subagent.watch`：在跑 Claude Code 的 pane 按 `prefix+.`，popup 即時顯示該 session 的 sub agent 在做什麼。以 Node.js（只用內建模組）實作，只支援 Claude Code、Linux 與 macOS；細節以 `README.md`、`docs/internals.md` 為準。

## 結構

- `herdr-plugin.toml`：manifest：actions（open／setup／remove）與 popup pane，command 一律經 bin/run.sh
- `bin/run.sh`：node launcher：找 Node ≥ 22（SUBAGENT_WATCH_NODE → PATH → fnm／volta／nvm）
- `viewer.mjs`：popup 本體（tab、捲動、按鍵）
- `open-action.mjs`：prefix+. 的 action：問 herdr focused pane，開 viewer pane
- `scripts/setup.mjs`：setup／remove：改 herdr config.toml 的 marker 區塊、清舊版殘留
- `demo.mjs`：等同 viewer.mjs --demo
- `lib/*.mjs`：純邏輯模組（transcript、session、watcher、render、text、setup-*…）
- `test/*.test.mjs`：node:test；fixtures 在 test/fixtures/
- `docs/internals.md`：運作細節與開發說明
- `README.md`、`docs/*.md`：各有 .zh-TW 版，改一份要同步另一份

## 指令

- test：`node --test 'test/*.test.mjs'`（CI 兩個 job 跑同一條；只收檔案或 glob，給資料夾會失敗）。pty 測試需要 util-linux `script`，`herdr config check` 測試沒裝 herdr 時 skip。
- check／build：無（沒有 `package.json`、lint、bundler）。
- 手動跑：`sh bin/run.sh viewer.mjs [--once|--demo|--session <jsonl>]`、`sh bin/run.sh scripts/setup.mjs [--remove] [--dry-run]`。

## 不看會做錯

- 只用 Node 內建模組，不加套件、不 `npm install`。
- 所有入口都走 `bin/run.sh`，manifest 與 code 不寫死 node、herdr、`~/.claude` 路徑（分別靠 `SUBAGENT_WATCH_NODE`、`HERDR_BIN_PATH`、`CLAUDE_CONFIG_DIR`）。
- 顏色只用 bold／dim／reverse 與 ANSI 16 色，跟 terminal theme 走，不套 `bazzite-palette`。
- 畫到 terminal 前 transcript 文字一律過 `lib/text.mjs` 的 sanitize。
- `main` 有 branch protection：走 PR，required check 名稱固定是 `test`。

## Reading Notes

給 sub-agent：改這個 repo 要讀什麼、載什麼。格式規格在 plugin `hotpapa` 的 skill `repo-agent`。

### 相關 skills

- `hotpapa:ts-js-style`
- `hotpapa:node-first`

### 專案 skills

無（沒有 `.claude/skills/`）。

### 專案 rules

無（沒有 `.claude/rules/`）。
