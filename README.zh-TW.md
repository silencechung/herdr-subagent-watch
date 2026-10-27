# herdr-subagent-watch

[English](README.md) | 繁體中文

herdr plugin `subagent.watch`：用 popup 即時看 Claude Code 的 sub agent 在做什麼。純 Node 內建模組，不需要 `npm install`。

> **只支援 Claude Code**：讀的是 Claude Code 的 transcript，並問 herdr 每個 pane 跑的是哪個 session。其他 agent 的 pane 會顯示 `This pane is not running Claude Code (detected: <agent>)`。

## 需求

- herdr ≥ 0.9.3
- Node.js ≥ 22（自動找，見 [Node 怎麼找](docs/internals.zh-TW.md#node-怎麼找)）
- Claude Code
- Linux 或 macOS

## 安裝

```sh
herdr plugin install silencechung/herdr-subagent-watch   # 本機開發改用 link：herdr plugin link /path/to/herdr-subagent-watch
herdr plugin action invoke subagent.watch.setup
```

然後在跑 Claude Code 的 pane 按 `prefix+.`。

setup 會在 herdr 的 `config.toml` 加上 `prefix+.` 快捷鍵（改動前先備份，跑幾次結果都一樣）。結果用 herdr 通知顯示，細節在 `herdr plugin log list --plugin subagent.watch`。衝突處理、備份與 `--dry-run` 預覽見 [setup 細節](docs/internals.zh-TW.md#setup-細節)。

**從有側邊欄數量的舊版升級**：再跑一次 setup。側邊欄數量已經拿掉，setup 會清掉舊版加的東西：Claude Code `settings.json` 裡的 hook、`config.toml` 裡的側邊欄 rows，以及舊 hook 留在 `$XDG_RUNTIME_DIR/subagent-watch`（macOS 是 `$TMPDIR/subagent-watch`）的檔案。還沒重跑之前，舊的 hook 雖然還留在 `settings.json`，但什麼都不會做。

## 操作

在跑 Claude Code 的 pane 按 `prefix+.`，popup 會顯示「從哪個 pane 開的，就看那個 session」的 sub agent 在做什麼，一個 sub 一個 tab，每個 tool 呼叫一行（`HH:MM:SS  <tool>  <參數摘要>`）。tab 上 `●` 是跑中、`◐` 是在等它自己啟動的背景工作（那個工作結束後它會自己接著跑）、`✓` 是已結束。結束的 tab 會留著，還看得到它做過的事。popup 開、關都手動。

| 按鍵 | 作用 |
| --- | --- |
| `←` / `→`、`0`–`9`、滑鼠點 tab 列 | 切換 tab：上一個／下一個（循環）、輸入編號直接跳過去、或點到的那個 |
| `↑` / `↓`、`PgUp` / `PgDn`、滑鼠滾輪 | 捲一行、一頁、或一次 3 行；往上捲會暫停 follow |
| `Home` / `End` | 捲到最舊／回到最新、恢復 follow |
| `q` / `Esc` / `Ctrl+C` | 關閉 |

tab 列、事件格式、捲動與滑鼠的細節見 [popup viewer 細節](docs/internals.zh-TW.md#popup-viewer-細節)。

## 移除

```sh
herdr plugin action invoke subagent.watch.remove
herdr plugin uninstall subagent.watch    # link 的話用 herdr plugin unlink subagent.watch
```

要先跑 remove 再 uninstall：uninstall 之後就沒有這個 action 了。remove 只拿掉 `config.toml` 裡本 plugin 的 marker 區塊，以及舊版加的東西，見 [remove 細節](docs/internals.zh-TW.md#remove-細節)。

## 疑難排解

- **按 `prefix+.` 沒反應**：看 setup 的 log。`prefix+.` 已被別的動作佔用時 setup 不加快捷鍵，log 裡附上要自己貼的片段。
- **popup 還停在上一個 session，或顯示 `(guessed: latest session)`**：popup 跟著 herdr 回報的這個 pane 的 session，那個 session 的 transcript 出現後才換過去（第一個 prompt 之後才寫出來）。herdr 沒回報 session 時用 pane 的 cwd 猜，同一個資料夾開多個 Claude Code 時可能猜錯。見[怎麼找到 pane 對應的 session](docs/internals.zh-TW.md#怎麼找到-pane-對應的-session)。
- **`No Claude Code session in this pane`**：herdr 回報那個 pane 沒有 agent（純 shell）。popup 每 2 秒重問一次，之後在同一個 pane 開 Claude Code 會自動接上。
- **tab 一直是 `◐`**：那個 sub 在等它自己的背景工作。判斷不了那個工作有沒有結束時（見[資料來源與結束判斷](docs/internals.zh-TW.md#資料來源與結束判斷)），tab 維持 `◐`，不會說它已經結束。
- **找不到 Node.js 22+**：會印出原因。要指定 node 就在啟動 herdr 的環境裡設 `SUBAGENT_WATCH_NODE`。
- **setup 寫到錯的設定檔**：action 用的是 herdr server 的環境；改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`。

完整清單與已知限制見[疑難排解與已知限制](docs/internals.zh-TW.md#疑難排解與已知限制)。

## 更多

- [`docs/internals.zh-TW.md`](docs/internals.zh-TW.md)：給想了解運作或參與開發的人：怎麼找 session、sub 什麼時候算結束、執行模式與測試。

## 授權

[MIT](LICENSE)
