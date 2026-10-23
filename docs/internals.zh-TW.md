# herdr-subagent-watch 內部細節

[English](internals.md) | 繁體中文

給想了解 plugin 怎麼運作、或想參與開發的人。安裝與日常使用見 [README](../README.zh-TW.md)；側邊欄另有一頁 [`sidebar.zh-TW.md`](sidebar.zh-TW.md)。

## setup 細節

`subagent.watch.setup` 會改兩個使用者自己的設定檔，結果用 herdr 通知顯示，細節（包含要手動貼的片段）在 `herdr plugin log list --plugin subagent.watch`：

1. Claude Code：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `hooks.SubagentStart`、`hooks.SubagentStop`、`hooks.SessionStart`、`hooks.Stop`、`hooks.StopFailure` 各加一筆，五個都是同一個 command：`sh "<plugin 目錄>/bin/run.sh" "<plugin 目錄>/hooks/sidebar-hook.mjs"`（timeout 5 秒）。
   - 本 plugin 之前加的 hook（plugin 目錄換過也算），或手動加的舊寫法 `<node 絕對路徑> <絕對路徑>/hooks/sidebar-hook.mjs`，會原地換成新的寫法，不重複加；別的工具的 hook 只是檔名剛好叫 `sidebar-hook.mjs` 不算。
   - 其他 hook 一個都不動；你自己的 `SessionStart`／`Stop`／`StopFailure` hook 留著，本 plugin 的加在它們後面。
   - **用舊版 setup 過**（只有 `SubagentStart`／`SubagentStop`）：再跑一次 setup，會補上 `SessionStart`、`Stop` 與 `StopFailure`，原本的兩個不動。每個 event 各自檢查，缺哪個補哪個，不會重複。補上之前 popup 照舊版的方式找 session；沒收到 `SubagentStop` 就結束的 sub，要等同一個 session 另一個 sub 的 `SubagentStart`／`SubagentStop`（在它最後一次寫入 2 分鐘以後）才從數量拿掉：清除每個事件都會跑，但只接了這兩種事件。已經在跑的 Claude Code session 要等它下一次 `SessionStart`（重開、`/resume`、`/clear` 或 compaction）才會寫 session 對照。
2. herdr：`$HERDR_CONFIG_PATH`，沒設就是 `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`。加的內容都包在 `# >>> subagent.watch` ／ `# <<< subagent.watch` 之間。
   - 快捷鍵：沒有任何東西用 `prefix+.` 才加 `[[keys.command]]`；已被別的動作佔用就跳過，log 裡附上可以改成別的鍵的片段。
   - 側邊欄：沒有 `[ui.sidebar.agents.rows_by_agent]` 就整段加上；有這個表但沒有 `claude =` 就插在表頭下一行；已經有自己的 `claude =` 而且沒有 `$sub1` 就不動，log 裡附上要自己貼進去的那一行。claude rows 已經有 `$sub1` 的（包括舊版 setup 寫的 `$sub1`…`$sub5` 五行）當成設定好，不改寫（見 [setup 會加什麼](sidebar.zh-TW.md#setup-會加什麼)）。
   - 新內容先寫成設定檔旁邊的暫存檔，跑 `herdr config check`：多出新的問題就刪掉暫存檔並回報錯誤（原檔完全沒動過，不需要還原）；通過才把暫存檔 `rename` 過去，再 `herdr server reload-config`。

- 兩個檔案改動前都備份成同資料夾的 `<檔名>.subagent-watch.bak`，**只備份第一次**：`.bak` 已經存在就不覆寫，保留最早的原始檔（想重新備份就自己刪掉舊的 `.bak`）。
- 跑幾次結果都一樣；已經設定好就不會再寫檔。
- 先看會改什麼：在 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs --dry-run`，只印出改動，不寫檔、不呼叫 herdr。
- 設定檔路徑看的是執行 setup 那個環境的 `CLAUDE_CONFIG_DIR`、`HERDR_CONFIG_PATH`、`XDG_CONFIG_HOME`；action 用的是 herdr server 的環境。路徑不對時，改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`。
- 用 `herdr plugin install` 重裝後 plugin 目錄可能換位置，再跑一次 setup 就會把 hook 指到新的位置。

## remove 細節

- 要先跑 remove 再 uninstall：uninstall 之後就沒有這個 action 了。
- remove 只拿掉 `settings.json` 裡本 plugin 的 hook（認法跟 setup 一樣；event 陣列空了就整個 key 拿掉）和 `config.toml` 裡 marker 之間的內容；備份與 `herdr config check` 的做法跟 setup 一樣，最後 `herdr server reload-config`。
- 不在 marker 裡、手動加的設定不會被刪，log 會列出行號。
- 你其他的 hook 與兩個檔案其餘的內容都不動。
- 側邊欄已經顯示的那一行會留到那個 pane 下次回報或 herdr 重開；要馬上清掉見 [`docs/sidebar.zh-TW.md`](sidebar.zh-TW.md#怎麼移除) 的「怎麼移除」。

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
  - 選取的 tab 是 `[<編號> <狀態> <名稱>]`，reverse video＋bold；`●` 跑中、`✓` 結束。其他 tab 只有編號：跑中 bold、結束 dim（不上色，只用文字屬性）。
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

## 側邊欄

herdr 側邊欄 claude 那一列底下，用一行顯示這個 session **還在跑**的 sub agent 有幾個：

```
claude
● 3 running
```

- 只顯示數量，不列名稱，也沒有上限。`SubagentStart` 加一，但 resume 一個還算在數量裡的 sub（上一輪的 `SubagentStop` 沒收到，它的檔還在）時只換啟動時間，數字不變；`SubagentStop` 減一，之前沒看過 `SubagentStart` 的不影響數字。
- 側邊欄不留歷程，sub 一結束就不算進數量；因 API 錯誤（例如額度用完）等原因沒收到 `SubagentStop` 的 sub，在它最後一次寫入 2 分鐘後的下一次 hook 事件拿掉（例如主 session 下一次回合結束的 `Stop`；那一回合本身因 API 錯誤結束時是 `StopFailure`），這只是安全網：沒有結束訊號的 sub（或 resume 後新一輪還沒寫紀錄的）不管多久沒寫入都留著。
- pane 換 session（新的 `claude`、`/clear`、`/resume`）時側邊欄馬上換成新 session 的數量。
- 沒有任何跑中的 sub 時，那一行消失，側邊欄只剩 claude 那一列。
- 結束的 sub 和它做過的事在 popup 看（結束的 tab 會留著）。

細節見 [`docs/sidebar.zh-TW.md`](sidebar.zh-TW.md)。

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

1. **herdr**：`agent_session`（herdr 的 claude integration 會回報，實測 `{"agent":"claude","kind":"id","source":"herdr:claude","value":"<session-id>"}`）。用 session id 在 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/` 找 `<session-id>.jsonl`。herdr 的回報可能過期：實測 herdr server 重啟後，在同一個 pane 開新的 Claude Code，herdr 仍回報重啟前的 session（原因未知）。
2. **pane map**：sidebar hook 寫的 `$XDG_RUNTIME_DIR/subagent-watch/pane-<paneId>.json`（macOS 沒有 `XDG_RUNTIME_DIR` 時是 `$TMPDIR/subagent-watch/`，見[寫出的檔案](sidebar.zh-TW.md#寫出的檔案)）（`sessionId`、`transcriptPath`、`cwd`、`updatedAtMs`）。hook 在 `SessionStart` 時就寫，所以 session 一開始、resume 或 clear 之後就指向這個 pane 現在的 session，檔案裡另外帶 `sessionStartSource` 當標記（同一個 session 的 sub 事件重寫時會留著）。沒有標記的（只在 `SubagentStart`／`SubagentStop` 時寫：舊版 setup 還沒重跑，或加 hook 之前就開的 session）在開下一個 sub 之前可能還指向上一個 session。
3. **猜**（herdr 和 pane map 都沒有 session 時才用）：用 pane 的 cwd 對到 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd 的 / 換成 ->/`，取最新修改的 `<session-id>.jsonl`。底部分隔線會標 `(guessed: latest session)`：同一個資料夾開多個 Claude Code 時可能猜錯。`/var/home/...` 與 `/home/...` 兩種寫法都會試（Fedora Atomic 的 home 在 `/var/home`）；另外也試把所有非英數字元換成 `-` 的寫法（未驗證 Claude Code 是否這樣編碼含 `.` 的路徑）。

**帶標記、而且 transcript 存在的 pane map 直接用**：不跟 herdr 比、不看寫入時間，pane map 改指別的 session 時 popup 就換過去（herdr 說法不同時，底部分隔線照樣標出 `herdr says session <id>, pane map says <id>`）。新 session 剛開時 transcript 還不存在（Claude Code 2.1.296 實測：第一個 prompt 之後才寫出來），出現之前照下面的規則。

沒有標記時，前兩個都可能過期，所以不固定哪一個優先。viewer 還沒有 session（或畫面上的 transcript 被刪掉）時，取 transcript 存在、而且最近寫入的那個 session（同時間取 herdr 的）：兩個都是這個 pane 專屬的，過期的值通常指向已經沒人在寫的舊 session。兩邊說的 session 不同時，底部分隔線會多一段 `herdr says session <id>, pane map says <id>`。兩個的 transcript 都還不存在時（session 剛開、還沒寫任何東西），等 herdr 回報的 session 出現（herdr 沒有就等 pane map 的），不會退回去猜。

問不到 herdr（找不到 herdr、`herdr pane get` 失敗）時，猜之前只剩 pane map；完全沒有 pane id 時跳過 pane map，只能用猜的（3）。都找不到時顯示 `No Claude Code session found for this pane` 和每一步失敗的原因。

找到 session 之後仍然每 2 秒重查一次，但之後不再只看寫入時間決定換不換。過期的值可能指向別的 pane 正在寫的 session（`claude -c`、`--resume` 沿用同一個 session id），兩個 transcript 會輪流變成最新的；跟著最新的走，popup 會每幾秒來回切一次，選取的 tab 與捲動位置都被清掉。所以 viewer 記住 herdr、pane map 各自上一次查詢成功時回報的 session，只有下面幾種情況才換掉畫面上的：

- 現在的是猜的，新的來自 herdr 或 pane map；
- 兩個都不是猜的，herdr 或 pane map 現在回報的 session 跟之前不同（值變了）、不是畫面上的那個、transcript 存在。兩個同一輪都變了，取寫得比較近的。某個來源第一次回報 session（例：herdr 一開始失敗、後來恢復）時，只有那個 transcript 比現在的寫得更近才換，而且只會發生這一次；
- 現在的 transcript 已經不存在（照上面的方式重選）；
- 兩個都是猜的，而且現在的 transcript 已經不存在。

所以 `/resume` 或重開 `claude` 之後，herdr 或 pane map 一回報新 session、它的 transcript 一出現，popup 就換過去（重建 tab、底部的 session 標籤跟著換）。查詢失敗不會改 viewer 記住的值，herdr 暫時失敗、或恢復後回報同一個過期的值，都不會跳回上一個 session。猜的不會取代來自 herdr 或 pane map 的 session，查不到也會留著畫面上的 session；同一個資料夾兩個 session 輪流寫入時，猜到的 session 留在原地，不會來回切換。已經顯示 session 時，查詢本身出錯的話，錯誤顯示在底部分隔線，下一次查詢成功就清掉。查詢是非同步、同時只跑一個，`herdr pane get` 3 秒逾時；herdr 卡住時 `q`／`Esc` 一樣立即關閉。

### 資料來源與結束判斷

- sub transcript：`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`，旁邊 `agent-<id>.meta.json`（`agentType`、`description`）。只讀新增的 bytes，一次最多 8 MB；壞掉或不完整的行、超過 64 MB 的單一行直接跳過。檔案變小時從頭重讀。格式是 Claude Code internal，升版可能改。
- 判斷 sub 結束（任一成立就 `✓`），依據是開發時看過的 154 個真實 sub transcript（含 meta）：
  1. sub JSONL 出現 `tool_use` `SubagentHandback`（117 個 sub 這樣結束，包含唯一的前景 sub）。
  2. assistant 的 `stop_reason` 是 `end_turn`，但只限非 background 的 sub：meta 有 `isFork: true`，或 `requestShape` 不是 `"background"`。31 個 `fork` sub 沒有 `SubagentHandback`，都是這樣結束。background sub 不看 `end_turn`：其中 6 個中途出現 `end_turn`，接著收到 `[handback-send-enforce]` 才補呼叫 `SubagentHandback`，把 `end_turn` 當結束會讓它們閃一下 `✓`。
  3. main transcript 出現 `<task-notification>`，`<task-id>` 是這個 agent、`<status>` 是 `completed`／`killed`／`failed`（被 kill 的 sub 只有這個訊號）。只認 content 以 `<task-notification>` 開頭的 `queue-operation` 行：樣本裡每則通知都是這樣寫的；user 訊息、排隊中的訊息、tool result 裡引用的同樣 tag 不算。
  4. 備案：transcript 超過 10 分鐘沒寫入。門檻對齊 Bash tool 單次最長 10 分鐘，避免把正在等指令的 sub 誤判。這時結束行顯示 `no writes for 10 min`，之後若又寫入會變回 `●`。
- 結束訊號比最後一筆 assistant 活動早時不算數：sub 被 resume 後會回到 `●`。
- 前景 sub：樣本只有一個（`"requestShape":"foreground"`），用 `SubagentHandback` 結束（規則 1）。規則 2（`end_turn`）對前景 sub 照樣適用；前景 sub 會不會中途出現 `end_turn` **未驗證**。

### 側邊欄數量

Claude Code 觸發 `SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure` hook（回合因 API 錯誤結束時改觸發 `StopFailure`，不觸發 `Stop`）；`hooks/sidebar-hook.mjs`（經 `bin/run.sh` 執行）寫入或刪除跑中的 sub 各自的小檔（不用 lock：平行的 hook 只動自己那個 sub 的檔，靠 herdr 的 `--seq` 留下最新的回報），再呼叫 `herdr pane report-metadata` 把 `● N running` 寫進 pane token `sub1`，由 setup 加的 `claude` rows 顯示（舊版用到的 `sub2`…`sub5` 每次回報都清掉）。上面第 2 步用的 pane map 也是這個 hook 寫的（`Stop` 與 `StopFailure` 以外的每個事件都寫）。每個事件也會拿掉這個 session 裡 transcript 以這一輪的結束訊號結尾（`SubagentHandback`、API 錯誤、中斷、task notification 等）、而且 2 分鐘沒寫入的 sub，因為有些 sub 永遠收不到 `SubagentStop`。這個 hook 套用到每個 Claude Code session，所以永遠 exit 0、不輸出任何東西，並在時間預算內結束。細節見 [`docs/sidebar.zh-TW.md`](sidebar.zh-TW.md)。

### Node 怎麼找

manifest 的 action／pane 與 Claude Code hook 都經過 `bin/run.sh`（POSIX sh），依序找第一個 ≥ 22 的 node：

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
  - sidebar hook 則安靜地 exit 0，不干擾 Claude session。
  - 要指定 node 就在啟動 herdr 與 Claude Code 的環境裡設 `SUBAGENT_WATCH_NODE`。
- **setup 寫到錯的設定檔**：action 用的是 herdr server 的環境；改在自己的 shell 進 plugin 目錄跑 `sh bin/run.sh scripts/setup.mjs`（見 [setup 細節](#setup-細節)）。
- **popup 顯示 `(guessed: latest session)`**：session 是用 pane 的 cwd 猜的，同一個資料夾開多個 Claude Code 時可能猜錯。猜的當下它是最新的，之後一直留著，直到 herdr 或 pane map 回報 session、或它的 transcript 被刪掉（見[怎麼找到 pane 對應的 session](#怎麼找到-pane-對應的-session)）。
- 開了新 session 之後 popup 還停在上一個 session：有 `SessionStart` hook 時，只會持續到新 session 的 transcript 出現（實測在第一個 prompt 之後）。沒有的話（舊版 setup 還沒重跑，或加 hook 之前就開的 session），herdr 與 pane map 都過期時（herdr 停在舊值、新 session 還沒開過 sub），要等第一個 sub 開始、hook 更新 pane map 才會換過去。popup 第一次選 session 時比的是寫入時間：過期的值若指向別的 pane 正在寫的 session，可能選到它。之後只有 herdr 或 pane map 回報的 session 跟它上一次回報的不同、或畫面上的 transcript 被刪掉，才會換（見「怎麼找到 pane 對應的 session」）。
- popup 換到從這個 pane 跑的 `claude -p`：只有 hook 分不出來的巢狀 `claude -p` 會這樣（見 [`docs/sidebar.zh-TW.md`](sidebar.zh-TW.md#已知限制) 的已知限制）。它的 `SessionStart` 會寫帶標記的 pane map，popup 跟著它走，直到這個 pane 自己的 session 再寫一次 pane map（下一次 sub 事件或 `SessionStart`）。
- popup 停在較舊的 session：只發生在 pane map 沒有 `SessionStart` 標記時。popup 開著時，照上面的規則有兩種情況會這樣：
  - herdr 的回報變回較舊的 session（例：herdr server 重啟後還原舊值）。這算值變了，popup 不比寫入時間就換過去，之後停在那裡，直到 herdr 或 pane map 回報跟上一次不同的 session。viewer 能不能撐過 herdr server 重啟未驗證。
  - herdr 或 pane map 第一次回報 session（例：popup 開啟時還沒有 pane map 檔，之後開 sub 時 hook 才寫入；或 herdr 一開始失敗、後來恢復），而別的 pane 剛好把舊 session 的 transcript 寫得一樣晚或更晚：popup 停在舊 session，之後這個來源不會再比寫入時間。
  - 兩種情況關掉 popup 再開，都會跟第一次開啟一樣照寫入時間重新選擇。
- `◀ ▶ ● ─ │ · … ↑ ↓` 是 East Asian ambiguous width 字元，terminal 設成 ambiguous = wide 時畫面會錯位。
- 只有 East Asian Width 為 W 或 F（Unicode 16.0）的字元算 2 格。有些 terminal 只在加了 variation selector 時才畫成 2 格的符號（例 `❤️`），量出來的寬度可能和 terminal 實際畫的不同。emoji ZWJ 序列量的是各部分加總（👨‍👩‍👧 算 6 格），terminal 把它合成一個字畫的話會比量的窄。
- herdr 會不會把滑鼠滾輪轉給 popup **沒驗證過**。若滾輪沒反應，用 `↑` / `↓`。左鍵點擊已在真的 herdr popup 裡確認：herdr 會以 SGR press／release 轉給 popup，座標以 popup 內容區左上角為 1,1；點 popup 外面不會有事件。
- 開了 mouse reporting，在 viewer 裡用滑鼠拖曳選字會被 viewer 吃掉、選不到字。部分 terminal 按住 Shift 拖曳可以繞過，herdr popup 裡是否可行未驗證。
- 摘要在讀 transcript 時只留前 20 行、總寬度 8000 欄（夠在 400 欄寬的摘要欄折滿 20 行）；被截掉的部分在 `+N` 裡每個原始行算一行，原始行很長時實際會更多。
- 視窗窄時 tab 列只顯示選取的 tab 附近的編號（左右輪流往外加），哪一側有藏起來的 tab 就在那一側畫 magenta 的 `◀` / `▶`。左邊沒有藏起來的 tab 時 `◀` 的位置留空白，`◀` 出現時後面的編號不會位移；右邊沒有時不畫。選取的 tab 一定完整看得到：比剩下的寬度還寬時只截名稱（結尾 `…`），編號與狀態符號不截；窄到連摘要加上選取 tab 的編號、符號都放不下時，摘要讓位。整列寬度不會超過視窗寬度。
- setup 沒有 TOML parser，只做逐行文字處理：看不懂的寫法（多行字串、inline table 形式的 `rows_by_agent` 等）會跳過或被 `herdr config check` 擋下（原檔完全沒動過，不需要還原），這時照 log 的片段手動貼。
- plugin 目錄路徑含 `"`、`$`、`` ` ``、`\` 時 setup 不會寫 hook（會破壞 shell command），要手動設定。
- macOS：沒有 `XDG_RUNTIME_DIR` 時狀態檔放在 `$TMPDIR/subagent-watch/`，macOS 會清掉 `$TMPDIR` 裡 3 天沒存取的檔。pane 閒置 3 天後 pane map 可能已經不在，popup 會退回用 pane 的 cwd 猜 session，直到下一次 `SessionStart` 或 sub 事件重新寫入。hook 與 popup 要拿到同一個 `TMPDIR`（或同一個 `XDG_RUNTIME_DIR`），不然 popup 找不到 pane map、只能猜。
- macOS：hook 用 `ps -A -o pid=,ppid=,comm=` 的 process 名稱分辨巢狀的 `claude -p`。native 版 Claude Code 在這裡顯示成什麼還沒在 Mac 真機確認；不是 `claude` 的話，祖先掃描找不到 `claude`，所有事件（包括巢狀的）都會被收（見 [`docs/sidebar.zh-TW.md`](sidebar.zh-TW.md#已知限制) 的已知限制）。

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
