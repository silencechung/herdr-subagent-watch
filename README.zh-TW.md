# herdr-subagent-watch

[English](README.md) | 繁體中文

herdr plugin `subagent.watch`：用 popup 即時顯示「從哪個 Claude Code pane 開的，就看那個 session 的 sub agent 在做什麼」，另外在 herdr 側邊欄 claude 那一列底下列出還在跑的 sub agent（見 [`docs/sidebar.zh-TW.md`](docs/sidebar.zh-TW.md)）。側邊欄不留歷程，sub 一結束那一行就消失；結束的 sub 和它做過的事在 popup 看（結束的 tab 會留著）。純 Node 內建模組，不需要 `npm install`。

- **只支援 Claude Code**：讀的是 Claude Code 的 transcript 與 `SubagentStart`／`SubagentStop` hook，其他 agent 的 pane 會顯示 `This pane is not running Claude Code (detected: <agent>)`。
- 需求：herdr ≥ 0.9.3、Node.js ≥ 22、Linux（sidebar hook 靠 `/proc` 與 `XDG_RUNTIME_DIR`）。
- 不寫死任何路徑、帳號或顏色：node 由 `bin/run.sh` 找，herdr 用 `HERDR_BIN_PATH`（沒有就找 PATH 上的 `herdr`），Claude Code 設定照 `CLAUDE_CONFIG_DIR`，顏色只用 terminal theme 的 ANSI 16 色。

## 安裝

```sh
herdr plugin install silencechung/herdr-subagent-watch
# 本機開發改用 link：herdr plugin link /path/to/herdr-subagent-watch

herdr plugin action invoke subagent.watch.setup
```

然後在跑 Claude Code 的 pane 按 `prefix+.`。

`subagent.watch.setup` 會改兩個使用者自己的設定檔，結果用 herdr 通知顯示，細節（包含要手動貼的片段）在 `herdr plugin log list --plugin subagent.watch`：

1. Claude Code：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `hooks.SubagentStart`、`hooks.SubagentStop` 各加一筆 `sh "<plugin 目錄>/bin/run.sh" "<plugin 目錄>/hooks/sidebar-hook.mjs"`（timeout 5 秒）。
   - 已經有指向 `sidebar-hook.mjs` 的 hook 就原地換成新的寫法，不重複加。
   - 其他 hook 一個都不動。
2. herdr：`$HERDR_CONFIG_PATH`，沒設就是 `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`。加的內容都包在 `# >>> subagent.watch` ／ `# <<< subagent.watch` 之間。
   - 快捷鍵：沒有任何東西用 `prefix+.` 才加 `[[keys.command]]`；已被別的動作佔用就跳過，log 裡附上可以改成別的鍵的片段。
   - 側邊欄：沒有 `[ui.sidebar.agents.rows_by_agent]` 就整段加上；有這個表但沒有 `claude =` 就插在表頭下一行；已經有自己的 `claude =` 而且沒有 `$sub1` 就不動，log 裡附上要自己貼進去的五行。
   - 寫完跑 `herdr config check`：多出新的問題就還原原檔並回報錯誤；通過才 `herdr server reload-config`。

- 兩個檔案寫入前都會備份成同資料夾的 `<檔名>.subagent-watch.bak`（每次真的有改才備份）。
- 跑幾次結果都一樣；已經設定好就不會再寫檔。
- 先看會改什麼：在 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs --dry-run`，只印出改動，不寫檔、不呼叫 herdr。
- 設定檔路徑看的是執行 setup 那個環境的 `CLAUDE_CONFIG_DIR`、`HERDR_CONFIG_PATH`、`XDG_CONFIG_HOME`；action 用的是 herdr server 的環境。路徑不對時，改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`。
- 用 `herdr plugin install` 重裝後 plugin 目錄可能換位置，再跑一次 setup 就會把 hook 指到新的位置。

## 移除

```sh
herdr plugin action invoke subagent.watch.remove
herdr plugin uninstall subagent.watch    # link 的話用 herdr plugin unlink subagent.watch
```

- 要先跑 remove 再 uninstall：uninstall 之後就沒有這個 action 了。
- remove 只拿掉 `settings.json` 裡指向 `sidebar-hook.mjs` 的 hook（event 陣列空了就整個 key 拿掉）和 `config.toml` 裡 marker 之間的內容，同樣先備份、跑 `herdr config check`、`herdr server reload-config`。
- 不在 marker 裡、手動加的設定不會被刪，log 會列出行號。
- 側邊欄已經顯示的樹狀行會留到那個 pane 下次回報或 herdr 重開；要馬上清掉見 [`docs/sidebar.zh-TW.md`](docs/sidebar.zh-TW.md#怎麼移除) 的「怎麼移除」。

## Node 怎麼找

manifest 的 action／pane 與 Claude Code hook 都經過 `bin/run.sh`（POSIX sh），依序找第一個 ≥ 22 的 node：

1. `SUBAGENT_WATCH_NODE`（有設就只用它，不能用直接報錯）
2. `command -v node`：會檢查檔案真的存在且可執行。herdr server 的 PATH 可能還留著已經消失的 node（例如 fnm 每個 shell 各自的暫存路徑）。
3. `$FNM_DIR`、`${XDG_DATA_HOME:-~/.local/share}/fnm`、`~/.fnm` 的 `aliases/default/bin/node`
4. `~/.volta/bin/node`
5. `${NVM_DIR:-~/.nvm}/versions/node/*/bin/node` 裡版本最新的
6. `/opt/homebrew/bin/node`、`/usr/local/bin/node`、`/usr/bin/node`

都找不到（或都低於 22）時印出原因：

- popup 裡會停在 `Press any key to close.` 等按鍵，不會一閃就關。
- action 另外用 herdr 通知提醒。
- sidebar hook 則安靜地 exit 0，不干擾 Claude session。

要指定 node 就在啟動 herdr 與 Claude Code 的環境裡設 `SUBAGENT_WATCH_NODE`。

## 開啟

- action：`subagent.watch.open`（setup 把 `prefix+.` 綁在這個 id）。`open-action.mjs` 從 `HERDR_PLUGIN_CONTEXT_JSON` 讀 `focused_pane_id`，再呼叫 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer --env SUBAGENT_WATCH_PANE_ID=<pane>`。
- 也可以直接 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer`；這時 viewer 改用 popup 自己的 context JSON 裡的 `focused_pane_id`。

popup 開、關都手動：所有 sub 結束也不會自己關。

## 操作

| 按鍵 | 作用 |
| --- | --- |
| `←` / `→` | 切換 tab（循環） |
| `↑` / `↓` | 捲一行（折行後的畫面行，以下同） |
| `PgUp` / `PgDn` | 捲一頁 |
| `Home` | 捲到最舊 |
| `End` | 回到最新、恢復 follow |
| 滑鼠滾輪 | 一次捲 3 行（見下面的限制） |
| `q` / `Esc` / `Ctrl+C` | 關閉 |

- tab 列長這樣：`2 running · 3 done │ ◀ [● Explore] [● general-purpose] [✓ claude-code-guide] ▶`
  - 顏色跟著 terminal theme：只用 bold、dim、reverse 和 ANSI 16 色，不寫死任何色碼。
  - 最左邊固定是跑中／結束數量摘要，跑中數字是 ANSI magenta，其餘 dim。
  - 狀態符號在每個 tab 最前面：`●` 跑中（預設字色＋magenta `●`）、`✓` 結束（整個 dim）。選取的 tab 是 reverse video＋bold。
  - tab 本身不帶編號，沒有 1–9 直跳。結束的 tab 留著，順序照啟動時間，狀態改變不會重排。
  - 不是 TTY（`--once` 導到檔案或 pipe）時輸出同樣結構的純文字。
- tab 名稱用 meta 的 `agentType`；同一個 type 出現多次時接 `description` 片段區分。
- 新的 `agent-*.jsonl` 出現就即時多一個 tab（`fs.watch` 監看 `subagents/`，每秒 polling 備援）。第一次有 tab 時選最新的跑中 sub，之後選取跟著 agent 走，新 tab 不會搶走目前看的。
- 事件格式：`HH:MM:SS  <tool>  <參數摘要>`。Bash 取 `command`、Read／Edit／Write 取 `file_path`、Grep 取 `pattern`、WebFetch 取 `url`、Agent 取 `description`，其他取第一個字串欄位；thinking 顯示 `thinking...`。只顯示 assistant 的 `tool_use` 與 thinking，不顯示 `tool_result` 內容。
  - 摘要太長時自動折行，續行縮排對齊摘要欄（時間與 tool 欄留白）；寬度照 display width 算（CJK／全形算 2 格），寬字不會被切半。
  - 多行內容（例 Bash heredoc）保留原本的換行與縮排，每一行各自折行；tab 換成 4 個空白。
  - tool 名稱比 tool 欄（10 格）寬時（例 `SubagentHandback`），tool 名稱自己佔一行、摘要從下一行的摘要欄開始，所有事件的摘要都對齊同一欄。
  - 一個事件最多 20 行，超過時第 20 行顯示 `… (+N more lines)`（dim）。
  - resize 會重新折行，暫停中的捲動位置停在同一個事件。
- 捲動：每個 sub 的事件整份留著（不限筆數，開啟時從頭讀整個 transcript），可以捲回最舊的一行。捲動單位是折行後的畫面行。
  - 預設 follow：新事件進來自動捲到最新。
  - 往上捲就暫停 follow，底部提示列最前面顯示 `↓ N new`（暫停後新進來的事件佔幾個畫面行）；按 `End` 或捲回最底恢復 follow。
  - 每個 tab 各自記住捲動位置，切 tab 不會影響其他 tab。
  - 底部提示列：`<-/-> switch  ↑/↓ PgUp/PgDn scroll  End follow  q close`，視窗窄時自動縮短。
- 滑鼠：開啟時打開 SGR mouse reporting（`\x1b[?1000h\x1b[?1006h`）收滾輪，離開時一定關掉（`q`、`Esc`、`Ctrl+C`、SIGTERM、未預期的例外都會關）。
- 還沒有 sub 時顯示 `No sub agents yet in this session`。

## 怎麼找到 pane 對應的 session

pane id 來源依序：`SUBAGENT_WATCH_PANE_ID`（open action 傳入）→ context JSON 的 `focused_pane_id` → `HERDR_PANE_ID`（非 popup 時）。拿到 pane 之後先問 herdr（`herdr pane get <pane>`），看 herdr 偵測到的 `agent`：

| herdr 回報（0.9.3 實測） | viewer 顯示 |
| --- | --- |
| 沒有 `agent` key（純 shell） | `No Claude Code session in this pane` |
| `agent` 是別的值（例 `"codex"`） | `This pane is not running Claude Code (detected: codex)` |
| `agent` 是 `"claude"` | 往下找 session（下面 1 → 2 → 3） |

這兩種「不是 Claude Code」的情況不會去猜 session；viewer 每 2 秒重問一次，之後在同一個 pane 開 Claude Code 會自動接上。

1. **herdr**：`agent_session`（herdr 的 claude integration 會回報，實測 `{"agent":"claude","kind":"id","source":"herdr:claude","value":"<session-id>"}`）。用 session id 在 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/` 找 `<session-id>.jsonl`。session 剛開還沒寫 transcript 時會等它出現，不會退回去猜。
2. **pane map**：sidebar hook 寫的 `$XDG_RUNTIME_DIR/subagent-watch/pane-<paneId>.json`（`sessionId`、`transcriptPath`、`cwd`、`updatedAtMs`）。
3. **猜**：用 pane 的 cwd 對到 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd 的 / 換成 ->/`，取最新修改的 `<session-id>.jsonl`。底部分隔線會標 `(guessed: latest session)`：同一個資料夾開多個 Claude Code 時可能猜錯。`/var/home/...` 與 `/home/...` 兩種寫法都會試（Fedora Atomic 的 home 在 `/var/home`）；另外也試把所有非英數字元換成 `-` 的寫法（未驗證 Claude Code 是否這樣編碼含 `.` 的路徑）。

問不到 herdr（找不到 herdr、`herdr pane get` 失敗）時，直接走 2 → 3；完全沒有 pane id 時跳過 pane map，只能用猜的（3）。都找不到時顯示 `No Claude Code session found for this pane` 和每一步失敗的原因。

## 資料來源與結束判斷

- sub transcript：`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`，旁邊 `agent-<id>.meta.json`（`agentType`、`description`）。只讀新增的 bytes；壞掉或不完整的行直接跳過。格式是 Claude Code internal，升版可能改。
- 判斷 sub 結束（任一成立就 `✓`），依據是開發時看過的 117 個真實 sub transcript：
  1. sub JSONL 出現 `tool_use` `SubagentHandback`（85 個背景 sub 都是這樣結束）。
  2. 最後一筆 assistant 的 `stop_reason` 是 `end_turn`（27 個 `fork` sub 沒有 `SubagentHandback`，都是這樣結束）。
  3. main transcript 出現 `<task-notification>`，`<task-id>` 是這個 agent、`<status>` 是 `completed`／`killed`／`failed`（被 kill 的 sub 只有這個訊號）。
  4. 備案：transcript 超過 10 分鐘沒寫入。門檻對齊 Bash tool 單次最長 10 分鐘，避免把正在等指令的 sub 誤判。這時結束行顯示 `no writes for 10 min`，之後若又寫入會變回 `●`。
- 結束訊號比最後一筆 assistant 活動早時不算數：sub 被 resume 後會回到 `●`。
- 前景 sub：樣本裡的 meta 全是 `"requestShape":"background"`，沒有前景 sub 的樣本，前景 sub 的結束訊號**未驗證**；預期會落在 2（`end_turn`）或 4（10 分鐘備案）。

## 模式

在 plugin 目錄：

```sh
sh bin/run.sh viewer.mjs                      # 互動模式（popup 用這個）
sh bin/run.sh viewer.mjs --once               # 印一張畫面到 stdout 後 exit 0，不需要 TTY
sh bin/run.sh viewer.mjs --demo               # 假資料，規則與正式版相同（8 秒後會多一個 tab）
sh bin/run.sh viewer.mjs --session <path>     # 手動指定 main transcript（<session-id>.jsonl）
sh bin/run.sh demo.mjs                        # 等同 viewer.mjs --demo
sh bin/run.sh scripts/setup.mjs [--remove] [--dry-run]
```

`sh bin/run.sh` 換成 `node` 也可以，只是不經過找 node 的流程。

## 測試

在 repo 目錄：

```sh
node --test 'test/*.test.mjs'
```

Node 22 的 `node --test` 只吃檔案或 glob，傳資料夾（`node --test test/`）會被當成要載入的 module 而失敗。pty 測試需要 util-linux 的 `script`，沒有就跳過；`herdr config check` 的測試在找不到 herdr 時跳過。

## 測 open action 不開 popup

`$HERDR_PLUGIN_STATE_DIR/dry-run` 存在（或 command 多帶 `--dry-run`）時，`open-action.mjs` 只把 context 與將要執行的指令寫進 `$HERDR_PLUGIN_STATE_DIR/open-action.log` 並印到 stdout，不開 popup。

## 已知限制

- `◀ ▶ ● ─ │ · … ↑ ↓` 是 East Asian ambiguous width 字元，terminal 設成 ambiguous = wide 時畫面會錯位。
- herdr 會不會把滑鼠滾輪轉給 popup **沒驗證過**。若滾輪沒反應，用 `↑` / `↓`。
- 開了 mouse reporting，在 viewer 裡用滑鼠拖曳選字會被 viewer 吃掉、選不到字。部分 terminal 按住 Shift 拖曳可以繞過，herdr popup 裡是否可行未驗證。
- 摘要在讀 transcript 時只留前 20 行、總寬度 8000 欄（夠在 400 欄寬的摘要欄折滿 20 行）；被截掉的部分在 `+N` 裡每個原始行算一行，原始行很長時實際會更多。
- 視窗窄時摘要照樣保留，tab 列只顯示選取的 tab 附近幾個，兩端箭頭變 magenta 代表那一側還有藏起來的 tab；單一 tab 比剩下的寬度還寬時只截名稱（結尾 `…`），狀態符號一定看得到。
- setup 沒有 TOML parser，只做逐行文字處理：看不懂的寫法（多行字串、inline table 形式的 `rows_by_agent` 等）會跳過或被 `herdr config check` 擋下還原，這時照 log 的片段手動貼。
- plugin 目錄路徑含 `"`、`$`、`` ` ``、`\` 時 setup 不會寫 hook（會破壞 shell command），要手動設定。
