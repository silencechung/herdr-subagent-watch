# herdr-subagent-watch

[English](README.md) | 繁體中文

herdr plugin `subagent.watch`：即時看 Claude Code 的 sub agent 在做什麼，有 popup viewer 與側邊欄數量兩種。純 Node 內建模組，不需要 `npm install`。

> **只支援 Claude Code**：讀的是 Claude Code 的 transcript 與 `SessionStart`／`SubagentStart`／`SubagentStop`／`Stop`／`StopFailure` hook，其他 agent 的 pane 會顯示 `This pane is not running Claude Code (detected: <agent>)`。

## 需求

- herdr ≥ 0.9.3
- Node.js ≥ 22（自動找，見 [Node 怎麼找](docs/internals.zh-TW.md#node-怎麼找)）
- Claude Code
- Linux（sidebar hook 靠 `/proc` 與 `XDG_RUNTIME_DIR`）

## 安裝

```sh
herdr plugin install silencechung/herdr-subagent-watch   # 本機開發改用 link：herdr plugin link /path/to/herdr-subagent-watch
herdr plugin action invoke subagent.watch.setup
```

然後在跑 Claude Code 的 pane 按 `prefix+.`。

setup 會改兩個使用者自己的設定檔：在 Claude Code 的 `settings.json` 加 sidebar hook，在 herdr 的 `config.toml` 加 `prefix+.` 快捷鍵與側邊欄的 rows。兩個檔案改動前都會先備份，跑幾次結果都一樣。結果用 herdr 通知顯示，細節在 `herdr plugin log list --plugin subagent.watch`。衝突處理、備份與 `--dry-run` 預覽見 [setup 細節](docs/internals.zh-TW.md#setup-細節)。

## 操作

**popup viewer**：在跑 Claude Code 的 pane 按 `prefix+.`，popup 會顯示「從哪個 pane 開的，就看那個 session」的 sub agent 在做什麼，一個 sub 一個 tab，每個 tool 呼叫一行（`HH:MM:SS  <tool>  <參數摘要>`）。結束的 tab 會留著，還看得到它做過的事。popup 開、關都手動。

**側邊欄數量**：herdr 側邊欄 claude 那一列底下，用一行顯示還在跑的 sub agent 有幾個（`● 3 running`）。側邊欄不留歷程，sub 一結束數量就減一，都沒在跑時那一行就消失。見 [`docs/sidebar.zh-TW.md`](docs/sidebar.zh-TW.md)。

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

要先跑 remove 再 uninstall：uninstall 之後就沒有這個 action 了。remove 只拿掉本 plugin 的 hook 和 `config.toml` 裡 marker 之間的內容，見 [remove 細節](docs/internals.zh-TW.md#remove-細節)。

## 疑難排解

- **側邊欄沒有數量，或按 `prefix+.` 沒反應**：看 setup 的 log。`prefix+.` 已被別的動作佔用時 setup 不加快捷鍵；已經有自己的 `claude =` 側邊欄 rows 時 setup 不動它；這兩種情況 log 裡都附上要自己貼的片段。用舊版 setup 過的話，再跑一次 setup。
- **popup 還停在上一個 session，或顯示 `(guessed: latest session)`**：開了新 session 之後，新 session 的 transcript 一出現 popup 就換過去（第一個 prompt 之後才寫出來），前提是這一版的 setup 已經加上 `SessionStart` hook。猜的 session 是用 pane 的 cwd 猜的，同一個資料夾開多個 Claude Code 時可能猜錯。見[怎麼找到 pane 對應的 session](docs/internals.zh-TW.md#怎麼找到-pane-對應的-session)。
- **`No Claude Code session in this pane`**：herdr 回報那個 pane 沒有 agent（純 shell）。popup 每 2 秒重問一次，之後在同一個 pane 開 Claude Code 會自動接上。
- **找不到 Node.js 22+**：會印出原因。要指定 node 就在啟動 herdr 與 Claude Code 的環境裡設 `SUBAGENT_WATCH_NODE`。
- **setup 寫到錯的設定檔**：action 用的是 herdr server 的環境；改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`。

完整清單與已知限制見[疑難排解與已知限制](docs/internals.zh-TW.md#疑難排解與已知限制)。

## 更多

- [`docs/sidebar.zh-TW.md`](docs/sidebar.zh-TW.md)：側邊欄數量的原理、setup 會加什麼、怎麼手動移除。
- [`docs/internals.zh-TW.md`](docs/internals.zh-TW.md)：給想了解運作或參與開發的人：怎麼找 session、sub 什麼時候算結束、執行模式與測試。

## 授權

[MIT](LICENSE)
