# herdr-subagent-watch 內部細節

[English](internals.md) | 繁體中文

給想了解 plugin 怎麼運作、或想參與開發的人。安裝與日常使用見 [README](../README.zh-TW.md)。

## setup 細節

`subagent.watch.setup` 會在 herdr 設定加上 `prefix+.` 快捷鍵，並清掉舊版加的東西。結果用 herdr 通知顯示，細節（包含要手動貼的片段，以及 `plugin:` 那一行的 plugin 目錄）在 `herdr plugin log list --plugin subagent.watch`：

1. herdr：`$HERDR_CONFIG_PATH`，沒設就是 `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`。加的內容都包在 `# >>> subagent.watch` ／ `# <<< subagent.watch` 之間。
   - 快捷鍵：沒有任何東西用 `prefix+.` 才加 `[[keys.command]]`；已被別的動作佔用就跳過，log 裡附上可以改成別的鍵的片段。
   - 舊版加的側邊欄 rows（含 `$sub1` 的 marker 區塊，包括更舊版的 `$sub1`…`$sub5` 五行）會拿掉：側邊欄數量已經拿掉了。marker 以外、自己手動加的 `$sub1` rows 不動，log 會列出行號。
   - 新內容先寫成設定檔旁邊的暫存檔，跑 `herdr config check`：多出新的問題就刪掉暫存檔並回報錯誤（原檔完全沒動過，不需要還原）；通過才把暫存檔 `rename` 過去，再 `herdr server reload-config`。
2. Claude Code，只用來清掉舊版：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 裡舊版 setup 加的 hook（`SubagentStart`、`SubagentStop`、`SessionStart`、`Stop`、`StopFailure` 上的 `sh "<plugin 目錄>/bin/run.sh" "<plugin 目錄>/hooks/sidebar-hook.mjs"`，或手動加的舊寫法 `<node 絕對路徑> <絕對路徑>/hooks/sidebar-hook.mjs`）會拿掉，event 陣列空了就整個 key 拿掉；別的工具的 hook 只是檔名剛好叫 `sidebar-hook.mjs` 不算，其他 hook 一個都不動。不會加任何東西，沒有要拿掉的就不寫檔。還沒重跑 setup 之前，留在那裡的舊 hook 會執行 `bin/run.sh`，它立刻安靜地 exit 0，不會干擾 Claude session。
3. 舊的側邊欄狀態檔：舊 hook 寫的檔（`sub-*.json`、`pane-*.json`，以及更舊版的 `session-*.json` 與它的 `.lock`／`.lock.break-*`，還有這些檔的暫存檔 `*.<16 位 hex>.tmp`）會從 `$XDG_RUNTIME_DIR/subagent-watch` 刪掉，macOS 另外也看 `$TMPDIR/subagent-watch`；刪完資料夾空了就連資料夾一起刪。資料夾是 symlink 或不是自己的就不動；其他名稱的檔一律留著（log 會列出來）。

- 檔案改動前備份成同資料夾的 `<檔名>.subagent-watch.bak`，**只備份第一次**：`.bak` 已經存在就不覆寫，保留最早的原始檔（想重新備份就自己刪掉舊的 `.bak`）。
- 跑幾次結果都一樣；已經設定好就不會再寫檔。
- 先看會改什麼：在 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs --dry-run`，只印出改動，不寫檔、不刪檔、不呼叫 herdr。
- 設定檔路徑看的是執行 setup 那個環境的 `CLAUDE_CONFIG_DIR`、`HERDR_CONFIG_PATH`、`XDG_CONFIG_HOME`、`XDG_RUNTIME_DIR`、`TMPDIR`；action 用的是 herdr server 的環境。路徑不對時，改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`。

## remove 細節

- 要先跑 remove 再 uninstall：uninstall 之後就沒有這個 action 了。
- remove 拿掉 `config.toml` 裡 marker 之間的內容（快捷鍵，以及舊版留下的側邊欄 rows），並跟 setup 一樣清掉舊的 hook 與狀態檔；備份與 `herdr config check` 的做法跟 setup 一樣，最後 `herdr server reload-config`。
- 不在 marker 裡、手動加的設定不會被刪，log 會列出行號。
- 你其他的 hook 與兩個檔案其餘的內容都不動。

## popup viewer 細節

- action：`subagent.watch.open`（setup 把 `prefix+.` 綁在這個 id）。`open-action.mjs` 從 `HERDR_PLUGIN_CONTEXT_JSON` 讀 `focused_pane_id`，再呼叫 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer --env SUBAGENT_WATCH_PANE_ID=<pane>`。
- 也可以直接 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer`；這時 viewer 改用 popup 自己的 context JSON 裡的 `focused_pane_id`。

popup 開、關都手動：所有 sub 結束也不會自己關。

| 按鍵 | 作用 |
| --- | --- |
| `←` / `→` | 切換 tab（循環） |
| `0`–`9` | 輸入 tab 編號直接跳過去（見下面） |
| 滑鼠點 tab 列 | 點編號或選取的 tab：切到那個 tab；點 `◀` / `▶`：上一個／下一個 tab，和 `←` / `→` 一樣 |
| `↑` / `↓` | 捲一行（折行後的畫面行，以下同） |
| `PgUp` / `PgDn` | 捲一頁 |
| `Home` | 捲到最舊 |
| `End` | 回到最新、恢復 follow |
| 滑鼠滾輪 | 一次捲 3 行（見下面的限制） |
| `q` / `Esc` / `Ctrl+C` | 關閉 |

- tab 列長這樣：`2 running · 3 done │   1 [2 ● general-purpose] 3 4 5`：選取的 tab 顯示編號、狀態與名稱，其他 tab 只顯示編號。
  - 顏色跟著 terminal theme：只用 bold、dim、reverse 和 ANSI 16 色，不寫死任何色碼。
  - 最左邊固定是跑中／結束數量摘要，跑中數字是 ANSI magenta，其餘 dim。
  - 選取的 tab 是 `[<編號> <狀態> <名稱>]`，reverse video＋bold；`●` 跑中、`◐` 在等自己的背景工作、`✓` 結束。其他 tab 只有編號：跑中與等待中 bold、結束 dim（不上色，只用文字屬性）。
  - 編號從 1 開始，是 tab 在完整清單裡的位置，順序照啟動時間；結束的 tab 留著，狀態改變不會重排，tab 列可見範圍捲動也不會改編號。兩位數、三位數照原樣顯示，不補零。
  - 輸入編號直接跳到那個 tab。目前輸入的數字還可能是更長編號的開頭時（例：14 個 tab 時按 `1`，可能是 10–14），等 600 ms 看有沒有下一位，沒有就跳到目前輸入的編號；不可能再延伸時（tab 不到 20 個時按 `2`–`9`）立刻跳。`0` 開頭或超過 tab 數的編號忽略並清掉。輸入到一半按其他鍵會丟掉已輸入的數字，那個鍵照常作用。等待期間畫面照常更新。
  - 滑鼠點擊只對 tab 列有效：點編號或選取的 tab 切到那個 tab，點 `◀` / `▶` 切到上一個／下一個；點其他地方不理。只算左鍵按下（放開不算），可點的欄位範圍取自最後一次畫出來的 tab 列，和畫面用同一套顯示寬度（中文、emoji 算 2 格）。
  - 不是 TTY（`--once` 導到檔案或 pipe）時輸出同樣結構的純文字。
- tab 名稱用 meta 的 `agentType`；同一個 type 出現多次時接 `description` 片段區分。
- 新的 `agent-*.jsonl` 出現就即時多一個 tab（`fs.watch` 監看 `subagents/`，每秒 polling 備援）。第一次有 tab 時選最新的跑中 sub，之後選取跟著 agent 走，新 tab 不會搶走目前看的。
- 事件格式：`HH:MM:SS  <tool>  <參數摘要>`。Bash 取 `command`、Read／Edit／Write 取 `file_path`、Grep 取 `pattern`、WebFetch 取 `url`、Agent 取 `description`，其他取第一個字串欄位；thinking 顯示 `thinking...`。只顯示 assistant 的 `tool_use` 與 thinking，不顯示 `tool_result` 內容。
  - 摘要太長時自動折行，續行縮排對齊摘要欄（時間與 tool 欄留白）；寬度照 display width 算：Unicode East Asian Width 為 W 或 F 的字元（CJK、全形、`✅` `🚀` 等 emoji）算 2 格，寬字不會被切半。
  - 多行內容（例 Bash heredoc）保留原本的換行與縮排，每一行各自折行；tab 換成 4 個空白。
  - transcript、meta、herdr 回傳內容裡的 escape sequence（CSI、OSC 52／OSC 8 等 OSC、DCS）、其他控制字元（含 8-bit C1）與 Unicode format 字元（bidi override、zero-width space、BOM）畫出來之前全部拿掉，transcript 沒辦法寫剪貼簿、加連結或清畫面。
    - ESC 開頭的字串型序列（OSC、DCS、SOS、PM、APC）連同結尾（BEL 或 ST）整段拿掉；沒有結尾時只拿掉 introducer，後面的文字留著，不會把摘要後面整段吃掉。
    - 8-bit C1（`U+0080`–`U+009F`，含 CSI、OSC、DCS 的 8-bit 寫法）只拿掉它自己，不會連後面的文字一起拿：C1 拿掉之後 terminal 看不到序列；latin1／cp1252 亂碼常在一般文字兩邊出現成對的 `U+009D` … `U+009C`（`“a” and “b”` 用 latin1 讀）。
    - ZWJ（`U+200D`）、ZWNJ（`U+200C`）保留、寬度算 0，👨‍👩‍👧 這類 emoji 序列和波斯文等文字不會被拆開。
  - tool 名稱比 tool 欄（10 格）寬時（例 `SubagentHandback`），tool 名稱自己佔一行、摘要從下一行的摘要欄開始，所有事件的摘要都對齊同一欄。
  - 一個事件最多 20 行，超過時第 20 行顯示 `… (+N more lines)`（dim）。
  - resize 會重新折行，暫停中的捲動位置停在同一個事件。
- 捲動：每個 sub 的事件整份留著（不限筆數，開啟時從頭讀整個 transcript），可以捲回最舊的一行。捲動單位是折行後的畫面行。
  - 預設 follow：新事件進來自動捲到最新。
  - 往上捲就暫停 follow，底部提示列最前面顯示 `↓ N new`（暫停後新進來的事件佔幾個畫面行）；按 `End` 或捲回最底恢復 follow。
  - 每個 tab 各自記住捲動位置，切 tab 不會影響其他 tab。
  - 底部提示列：`<-/-> 0-9 click switch  ↑/↓ PgUp/PgDn scroll  End follow  q close`，視窗窄時自動縮短（先省 `click`，`0-9` 留到最後）。
- 滑鼠：開啟時打開 SGR mouse reporting（`\x1b[?1000h\x1b[?1006h`）收滾輪與點擊，離開時一定關掉（`q`、`Esc`、`Ctrl+C`、SIGTERM、SIGHUP、未預期的例外都會關）。
- 還沒有 sub 時顯示 `No sub agents yet in this session`。

## 原理

不寫死任何路徑、帳號或顏色：node 由 `bin/run.sh` 找，herdr 用 `HERDR_BIN_PATH`（沒有就找 PATH 上的 `herdr`），Claude Code 設定照 `CLAUDE_CONFIG_DIR`，顏色只用 terminal theme 的 ANSI 16 色。

### 怎麼找到 pane 對應的 session

pane id 來源依序：`SUBAGENT_WATCH_PANE_ID`（open action 傳入）→ context JSON 的 `focused_pane_id` → `HERDR_PANE_ID`（非 popup 時）。拿到 pane 之後先問 herdr（`herdr pane get <pane>`），看 herdr 偵測到的 `agent`：

| herdr 回報（0.9.3 實測） | viewer 顯示 |
| --- | --- |
| 沒有 `agent` key（純 shell） | `No Claude Code session in this pane` |
| `agent` 是別的值（例 `"codex"`） | `This pane is not running Claude Code (detected: codex)` |
| `agent` 是 `"claude"` | 往下找 session（下面 1 → 2 → 3） |

這兩種「不是 Claude Code」的情況不會去猜 session；viewer 每 2 秒重問一次，之後在同一個 pane 開 Claude Code 會自動接上。

1. **herdr**：`agent_session`（herdr 的 claude integration 會回報，實測 `{"agent":"claude","kind":"id","source":"herdr:claude","value":"<session-id>"}`）。用 session id 在 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/` 找 `<session-id>.jsonl`。transcript 還不存在時（session 剛開；Claude Code 2.1.296 實測第一個 prompt 之後才寫出來）等它出現，不會退回去猜。herdr 的回報可能過期：herdr 0.9.3 實測 server 重啟後，在同一個 pane 開新的 Claude Code，herdr 仍回報重啟前的 session（原因未知）；herdr 0.9.5 實測 `/clear` 後馬上就更新。舊版另外讀 sidebar hook 寫的 pane map 來補這一點，已經跟 hook 一起拿掉，所以 herdr server 重啟後若 popup 顯示舊的 session，重開那個 pane。
2. **猜**（herdr 沒有回報 session 時才用）：用 pane 的 cwd 對到 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd 的 / 換成 ->/`，取最新修改的 `<session-id>.jsonl`。底部分隔線會標 `(guessed: latest session)`：同一個資料夾開多個 Claude Code 時可能猜錯。`/var/home/...` 與 `/home/...` 兩種寫法都會試（Fedora Atomic 的 home 在 `/var/home`）；另外也試把所有非英數字元換成 `-` 的寫法（未驗證 Claude Code 是否這樣編碼含 `.` 的路徑）。

問不到 herdr（找不到 herdr、`herdr pane get` 失敗）時只能用猜的；完全沒有 pane id 時也只能猜（2）。都找不到時顯示 `No Claude Code session found for this pane` 和每一步失敗的原因。

找到 session 之後仍然每 2 秒重查一次，但之後不再只看寫入時間決定換不換。過期的值可能指向別的 pane 正在寫的 session（`claude -c`、`--resume` 沿用同一個 session id），兩個 transcript 會輪流變成最新的；跟著最新的走，popup 會每幾秒來回切一次，選取的 tab 與捲動位置都被清掉。所以 viewer 記住 herdr 上一次查詢成功時回報的 session，只有下面幾種情況才換掉畫面上的：

- 現在的是猜的，新的來自 herdr；
- 兩個都不是猜的，herdr 現在回報的 session 跟之前不同（值變了）、不是畫面上的那個、transcript 存在。herdr 第一次回報 session（例：一開始失敗、後來恢復）時，只有那個 transcript 比現在的寫得更近才換，而且只會發生這一次；
- 現在的 transcript 已經不存在（照上面的方式重選）；
- 兩個都是猜的，而且現在的 transcript 已經不存在。

所以 `/resume` 或重開 `claude` 之後，herdr 一回報新 session、它的 transcript 一出現，popup 就換過去（重建 tab、底部的 session 標籤跟著換）。查詢失敗不會改 viewer 記住的值，herdr 暫時失敗、或恢復後回報同一個過期的值，都不會跳回上一個 session。猜的不會取代來自 herdr 的 session，查不到也會留著畫面上的 session；同一個資料夾兩個 session 輪流寫入時，猜到的 session 留在原地，不會來回切換。已經顯示 session 時，查詢本身出錯的話，錯誤顯示在底部分隔線，下一次查詢成功就清掉。查詢是非同步、同時只跑一個，`herdr pane get` 3 秒逾時；herdr 卡住時 `q`／`Esc` 一樣立即關閉。

### 資料來源與結束判斷

- sub transcript：`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`，旁邊 `agent-<id>.meta.json`（`agentType`、`description`）。只讀新增的 bytes，一次最多 8 MB；壞掉或不完整的行、超過 64 MB 的單一行直接跳過。檔案變小時從頭重讀。格式是 Claude Code internal，升版可能改。
- 判斷 sub 結束（任一成立就 `✓`），依據是開發時看過的 154 個真實 sub transcript（含 meta）：
  1. sub JSONL 出現 `tool_use` `SubagentHandback`（117 個 sub 這樣結束，包含唯一的前景 sub）。
  2. assistant 的 `stop_reason` 是 `end_turn`，但只限非 background 的 sub：meta 有 `isFork: true`，或 `requestShape` 不是 `"background"`。31 個 `fork` sub 沒有 `SubagentHandback`，都是這樣結束。background sub 不看 `end_turn`：其中 6 個中途出現 `end_turn`，接著收到 `[handback-send-enforce]` 才補呼叫 `SubagentHandback`，把 `end_turn` 當結束會讓它們閃一下 `✓`。
  3. main transcript 出現 `<task-notification>`，`<task-id>` 是這個 agent、`<status>` 是 `completed`／`killed`／`failed`（被 kill 的 sub 只有這個訊號）。只認 content 以 `<task-notification>` 開頭的 `queue-operation` 行：樣本裡每則通知都是這樣寫的；user 訊息、排隊中的訊息、tool result 裡引用的同樣 tag 不算。
  4. 備案：transcript 超過 10 分鐘沒寫入。門檻對齊 Bash tool 單次最長 10 分鐘，避免把正在等指令的 sub 誤判。這時結束行顯示 `no writes for 10 min`，之後若又寫入會變回 `●`。
- 結束訊號比最後一筆 assistant 活動早時不算數：sub 被 resume 後會回到 `●`。
- **在等自己的背景工作（`◐`）**：sub 啟動背景工作後結束這一輪並不代表做完了，那個工作結束後它會自己接著跑。等待期間 `SubagentHandback`（可能在等待前就送出）、`end_turn`、main transcript 的 `completed` 通知都會出現，只看規則 1–3 會顯示 `✓`（實測）。所以先做這幾步：
  - 從 sub 自己的 transcript 記下它啟動的背景工作：Bash `run_in_background`（`toolUseResult.backgroundTaskId`，shell）或背景 Agent（`toolUseResult.isAsync` 加 `agentId`，agent；巢狀 sub 在同一個 `subagents` 資料夾有自己的 transcript）。
  - 這一輪已經結束（規則 1–3 任一，或 `end_turn`，background sub 也算），而這些工作還有沒結束的：tab 顯示 `◐`，結束行是 `waiting on background work`，標題列算成 `N waiting`。
  - 工作什麼時候結束，依序看：sub transcript 裡說它結束的紀錄（`origin.kind` 是 `task-notification` 的 `user` 紀錄、`queued_command` 的 `attachment`、sub 自己 `TaskStop` 的結果，本機看過這三種），沒有的話 shell 看輸出檔（路徑在啟動時的 tool result 裡；最後一行是 `[exited with code N]` 或 `[killed]` 就是結束了，以檔案修改時間當結束時間），agent 看巢狀 sub 自己的狀態。判斷不了的工作讓 sub 維持 `◐`，不會變成 `✓`，也不套用 10 分鐘的備案。
  - 工作都結束了、sub 之後都沒有寫入：再維持 `◐` 30 秒（正常 1–2 秒內就會被叫醒），之後顯示為結束，結束行是 `background work ended, not resumed`。這是給等待中被停掉的 sub 用的：本機實測它不會留下 `SubagentStop`、`killed` 通知或任何紀錄，只有被 kill 的背景 shell。
  - 工作結束後 sub 又跑過：照原本的規則 1–4 判斷。main transcript 的 `killed`／`failed` 通知就算在等待中也直接算結束。
  - 輸出檔格式與 `origin`／`queued_command`／`TaskStop` 的形式都是 Claude Code internal（本機 2.1.311、macOS 實測），升版可能改；改了的話等待中的 sub 會一直是 `◐`，不會誤判成結束。
- 前景 sub：樣本只有一個（`"requestShape":"foreground"`），用 `SubagentHandback` 結束（規則 1）。規則 2（`end_turn`）對前景 sub 照樣適用；前景 sub 會不會中途出現 `end_turn` **未驗證**。

### Node 怎麼找

manifest 的 action／pane 都經過 `bin/run.sh`（POSIX sh），依序找第一個 ≥ 22 的 node：

1. `SUBAGENT_WATCH_NODE`（有設就只用它，不能用直接報錯）
2. `command -v node`：會檢查檔案真的存在且可執行。herdr server 的 PATH 可能還留著已經消失的 node（例如 fnm 每個 shell 各自的暫存路徑）。
3. `$FNM_DIR`、`${XDG_DATA_HOME:-~/.local/share}/fnm`、`~/Library/Application Support/fnm`（舊版 fnm 在 macOS 的預設位置）、`~/.fnm` 的 `aliases/default/bin/node`
4. `~/.volta/bin/node`
5. `${NVM_DIR:-~/.nvm}/versions/node/*/bin/node` 裡版本最新的
6. `/opt/homebrew/bin/node`、`/usr/local/bin/node`、`/usr/bin/node`

## 疑難排解與已知限制

- **找不到 Node.js 22+**（或都低於 22）時印出原因：
  - popup 裡會停在 `Press any key to close.` 等按鍵，不會一閃就關。
  - action 另外用 herdr 通知提醒。
  - 要指定 node 就在啟動 herdr 的環境裡設 `SUBAGENT_WATCH_NODE`。
- **setup 寫到錯的設定檔**：action 用的是 herdr server 的環境；改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`（見 [setup 細節](#setup-細節)）。
- **popup 顯示 `(guessed: latest session)`**：session 是用 pane 的 cwd 猜的，同一個資料夾開多個 Claude Code 時可能猜錯。猜的當下它是最新的，之後一直留著，直到 herdr 回報 session、或它的 transcript 被刪掉（見[怎麼找到 pane 對應的 session](#怎麼找到-pane-對應的-session)）。
- **開了新 session 之後 popup 還停在上一個 session**：herdr 回報新 session、它的 transcript 出現（實測在第一個 prompt 之後）就會換過去。herdr 一直回報舊 session 的話（herdr 0.9.3 server 重啟後看過），重開那個 pane。
- **popup 停在較舊的 session**：popup 開著時，照[怎麼找到 pane 對應的 session](#怎麼找到-pane-對應的-session) 的規則有兩種情況會這樣：
  - herdr 的回報變回較舊的 session（例：herdr server 重啟後還原舊值）。這算值變了，popup 不比寫入時間就換過去，之後停在那裡，直到 herdr 回報跟上一次不同的 session。viewer 能不能撐過 herdr server 重啟未驗證。
  - herdr 第一次回報 session（一開始失敗、後來恢復），而別的 pane 剛好把舊 session 的 transcript 寫得一樣晚或更晚：popup 停在舊 session，之後不會再比寫入時間。
  - 兩種情況關掉 popup 再開，都會跟第一次開啟一樣照寫入時間重新選擇。
- **已經不在的 sub 一直顯示 `◐`**：它的背景工作判斷不了（輸出檔不見了，或新版 Claude Code 改了格式）。popup 不會猜它已經結束，見[資料來源與結束判斷](#資料來源與結束判斷)。
- `◀ ▶ ● ─ │ · … ↑ ↓` 是 East Asian ambiguous width 字元，terminal 設成 ambiguous = wide 時畫面會錯位。
- 只有 East Asian Width 為 W 或 F（Unicode 16.0）的字元算 2 格。有些 terminal 只在加了 variation selector 時才畫成 2 格的符號（例 `❤️`），量出來的寬度可能和 terminal 實際畫的不同。emoji ZWJ 序列量的是各部分加總（👨‍👩‍👧 算 6 格），terminal 把它合成一個字畫的話會比量的窄。
- herdr 會不會把滑鼠滾輪轉給 popup **沒驗證過**。若滾輪沒反應，用 `↑` / `↓`。左鍵點擊已在真的 herdr popup 裡確認：herdr 會以 SGR press／release 轉給 popup，座標以 popup 內容區左上角為 1,1；點 popup 外面不會有事件。
- 開了 mouse reporting，在 viewer 裡用滑鼠拖曳選字會被 viewer 吃掉、選不到字。部分 terminal 按住 Shift 拖曳可以繞過，herdr popup 裡是否可行未驗證。
- 摘要在讀 transcript 時只留前 20 行、總寬度 8000 欄（夠在 400 欄寬的摘要欄折滿 20 行）；被截掉的部分在 `+N` 裡每個原始行算一行，原始行很長時實際會更多。
- 視窗窄時 tab 列只顯示選取的 tab 附近的編號（左右輪流往外加），哪一側有藏起來的 tab 就在那一側畫 magenta 的 `◀` / `▶`。左邊沒有藏起來的 tab 時 `◀` 的位置留空白，`◀` 出現時後面的編號不會位移；右邊沒有時不畫。選取的 tab 一定完整看得到：比剩下的寬度還寬時只截名稱（結尾 `…`），編號與狀態符號不截；窄到連摘要加上選取 tab 的編號、符號都放不下時，摘要讓位。整列寬度不會超過視窗寬度。
- setup 沒有 TOML parser，只做逐行文字處理：看不懂的寫法（多行字串等）會跳過或被 `herdr config check` 擋下（原檔完全沒動過，不需要還原），這時照 log 的片段手動貼。

## 開發

### 模式

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

### 測試

在 repo 目錄：

```sh
node --test 'test/*.test.mjs'
```

Node 22 的 `node --test` 只吃檔案或 glob，傳資料夾（`node --test test/`）會被當成要載入的 module 而失敗。pty 測試需要 util-linux 的 `script`，沒有就跳過（macOS 內建的是 BSD 的 `script`，參數不同，所以 macOS 上會跳過）；`herdr config check` 的測試在找不到 herdr 時跳過。

### 測 open action 不開 popup

`$HERDR_PLUGIN_STATE_DIR/dry-run` 存在（或 command 多帶 `--dry-run`）時，`open-action.mjs` 只把 context 與將要執行的指令寫進 `$HERDR_PLUGIN_STATE_DIR/open-action.log` 並印到 stdout，不開 popup。
