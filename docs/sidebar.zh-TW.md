# 側邊欄 sub agent 數量

[English](sidebar.md) | 繁體中文

herdr 側邊欄 claude 那一列底下，用一行顯示這個 session **還在跑**的 sub agent 有幾個：

```
<state_icon> <workspace> · <tab>
claude
● 3 running
```

- 只顯示數量：不列名稱，也沒有上限（12 個在跑就是 `● 12 running`）。`SubagentStart` 加一，但 resume 一個還算在數量裡的 sub（上一輪的 `SubagentStop` 沒收到，它的檔還在）時只換啟動時間，數字不變；`SubagentStop` 減一，之前沒看過 `SubagentStart` 的不影響數字。
- 沒收到 `SubagentStop` 就結束的 sub（例如因額度用完等 API 錯誤停下來），在它最後一次寫入 2 分鐘後、這個 session 的下一次 hook 事件時拿掉（例如主 session 下一次回合結束的 `Stop`；那一回合本身因 API 錯誤結束時是 `StopFailure`）。見[沒收到 SubagentStop 就結束的 sub](#沒收到-subagentstop-就結束的-sub)。
- pane 換 session（新的 `claude`、`/clear`、`/resume`）時，馬上換成新 session 的數量（`SessionStart`）；新 session 沒有跑中的 sub 就清空。
- 沒有任何跑中的 sub 時，那一行就消失，側邊欄只剩 claude 那一列。
- 側邊欄不留歷程：結束的 sub 和它做過什麼，用 popup viewer（`prefix+.`）看，見 [README](../README.zh-TW.md)。

## 原理

1. Claude Code 觸發 `SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure` hook，五個都是同一個 command：經 `bin/run.sh` 找到 node 後執行 `hooks/sidebar-hook.mjs`，payload 從 stdin 進來，用 `hook_event_name` 分辨事件。
2. hook 寫入或刪除這個 sub 自己的檔（每個跑中的 sub 一個檔，不用 lock），再數這個 session 的 sub 檔，呼叫 `herdr pane report-metadata` 把 `● N running` 寫進 pane token `sub1`（並清掉 `sub2`…`sub5`，見第 3 點）。
   - `SessionStart`：寫 pane 對照檔（標記成 session 開始時寫的，見下面），一定依這個 session 的 sub 檔重畫數量。
   - `SubagentStart`／`SubagentStop`：寫入／刪除這個 sub 的檔，並寫 pane 對照檔。
   - `Stop`（主 session 每一回合結束）與 `StopFailure`（回合改因 API 錯誤結束，例如額度用完）：只拿掉已經結束的 sub，有拿掉才重畫；不寫 pane 對照檔。
   - 每個事件都會先檢查這個 session 的其他 sub，拿掉已經結束的（見[下面](#沒收到-subagentstop-就結束的-sub)）。
3. `config.toml` 的 `rows_by_agent.claude` 多了 `$sub1` 一行；herdr 文件寫明沒回報的 token 會讓那一行整行消失，所以沒有 sub 在跑時看不到空行。
   - 舊版 setup 寫的是 `$sub1`…`$sub5` 五行（一個 sub 一行）。這種設定不重跑 setup 也照常運作：每次回報都會清掉 `sub2`…`sub5`，那四行一樣整行消失，只有 `$sub1` 顯示數量。想整理掉見 [setup 會加什麼](#setup-會加什麼)。

### hook 輸入（2026-10-10 用 `claude -p` 2.1.296 實測）

| 欄位 | SessionStart | SubagentStart | SubagentStop | Stop |
| --- | --- | --- | --- | --- |
| `hook_event_name`、`session_id`、`transcript_path`、`cwd` | ✓ | ✓ | ✓ | ✓ |
| `source`（`startup`、`resume`） | ✓ | | | |
| `seconds_since_last_response`、`context_tokens`、`prompt_cache_likely_expired`、`estimated_cache_write_usd` | 只有 `resume` | | | |
| `prompt_id` | | ✓ | ✓ | ✓ |
| `agent_id`（例：`a12e8c491ce2f7f4a`，沒有 `agent-` 前綴） | | ✓ | ✓ | |
| `agent_type`（例：`general-purpose`） | | ✓ | ✓ | |
| `permission_mode`、`effort`、`stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons` | | | ✓ | ✓ |
| `agent_transcript_path` | | | ✓ | |

- `SessionStart`：官方 [hooks 文件](https://code.claude.com/docs/en/hooks) 列的 `source` 有 `startup`、`resume`（`--resume`、`--continue`、`/resume`）、`clear`（`/clear`）、`compact`、`fork`，另外可能有 `model`、`agent_type`（`claude --agent <name>` 時）、`session_title`。實測只有 `startup` 與 `resume`（用 `-p`）；互動式 session 裡打 `/clear`、`/resume` 沒辦法用 `-p` 測，**本機未實測**。認不得的 `source` 記成 `unknown`。`--resume <id>` 沿用同一個 `session_id`。`startup` 時 hook 執行的當下 transcript 還不存在，第一個 prompt 之後才寫出來。
- `Stop`：官方文件說 Claude 回應結束時觸發；回合因 API 錯誤結束時改觸發 `StopFailure`。
- `StopFailure`：**本機未實測**（要真的遇到 API 錯誤）；欄位照官方文件（[StopFailure input](https://code.claude.com/docs/en/hooks#stopfailure-input)）：共通的 `session_id`、`transcript_path`、`cwd`、`hook_event_name`，加上 `error`（`rate_limit`、`overloaded`、`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`、`cloud_credential_error` 或 `unknown`；`matcher` 也是比對這個欄位）、選填的 `error_details` 與 `last_assistant_message`（內容是 API 錯誤訊息本身）。Claude Code 不理會它的輸出與 exit code。這個 hook 只用共通欄位，所以每種錯誤都一樣處理。
- `SubagentStop`：`last_assistant_message` 在當天第一次實測時沒有、後來一次（前景 sub）有。這個 hook 用不到它。

hook process 繼承 Claude Code 的環境變數：實測 `HERDR_PANE_ID`（例 `w8:pV`）、`HERDR_BIN_PATH`、`XDG_RUNTIME_DIR` 都在。範例 payload 在 `test/fixtures/sidebar/`。

### 寫出的檔案（`$XDG_RUNTIME_DIR/subagent-watch/`，tmpfs，重開機就清）

- `sub-<sessionId>-<agentId>.json`：一個跑中的 sub 一個檔，內容 `{ sessionId, id, agentType, startedAtMs }`。`SubagentStart` 寫入，`SubagentStop`（或下面的清除）刪掉，所以資料夾裡只有跑中的 sub；從沒開過 sub 的 session 不會留下任何檔案。
  - 內容的 `sessionId`、`id` 要跟檔名對得上才算：某個 session id 剛好是另一個 session id 加上「-…」時，檔名前綴會混在一起。壞掉或對不上的檔略過。
  - 同一個 sub 的檔還在又收到 `SubagentStart`（resume 時上一輪的 `SubagentStop` 沒收到）時直接覆寫，啟動時間換成這一次的；已經刪掉後再收到它的 `SubagentStart`（resume）也一樣重新寫。啟動時間是判斷結束訊號屬於哪一輪的依據（見下一節）。
  - 舊版的 `session-<sessionId>.json` 與 `.lock`：見下面的[從舊版升級](#從舊版升級)。
- `pane-<HERDR_PANE_ID>.json`：給 popup viewer 讀的對照檔：`{"sessionId","transcriptPath","cwd","updatedAtMs"}`，這個 session 的 `SessionStart` 寫的檔案另外帶 `"sessionStartSource"`（那次 `SessionStart` 的 `source`，例 `"startup"`）。**四個欄位固定**；viewer 只把 `sessionStartSource` 當標記用（見 internals 的[怎麼找到 pane 對應的 session](internals.zh-TW.md#怎麼找到-pane-對應的-session)）。
  - 同一個 session 的 `SubagentStart`／`SubagentStop` 重寫時留著標記；別的 session 的事件寫的檔案不帶標記，因為不一定收到過那個 session 的 `SessionStart`。
  - `Stop`／`StopFailure` 不寫這個檔案。

寫之前先檢查 `subagent-watch` 資料夾：必須是自己 uid 的、不是 symlink、權限 `0700`，不符合就什麼都不寫（`XDG_RUNTIME_DIR` 本身不存在時也不會幫它建）。

sub 檔與 pane 對照檔都用「寫暫存檔再 `rename`」，viewer 與別的 hook 不會讀到寫一半的 JSON；暫存檔名是隨機的、用 `wx` 建立，不會跟著預先放好的 symlink 寫到別的檔案。

### 平行的 hook 不用 lock

每個 hook 只寫／刪自己那個 sub 的檔，平行的 hook 不會改到同一個檔；最後顯示哪一筆由 herdr 的 `--seq` 決定：

- 每個事件的順序：寫 pane 對照檔 → 搬舊版狀態檔（有的話）→ 寫／刪自己的 sub 檔 → 判斷並刪掉已經結束的 sub（下一節）→ **取 seq** → readdir 這個 session 的 sub 檔、數有幾個 → 呼叫 herdr。
- herdr 對同一個 pane、同一個 source 只收 seq 比上次收下的還大的回報（實測：小於或等於就忽略，exit 0、沒有訊息），所以側邊欄最後顯示的是 seq 最大的那一筆，跟送達的先後無關。seq 在改完檔之後、readdir 之前取：改檔的 hook 取 seq 時改動已經完成，seq 比它大的回報一定是之後才 readdir，看得到這個改動；在改動完成之前就 readdir 的回報，seq 一定比較小，會被忽略。所以不管怎麼交錯，最後顯示的一定包含每一個改動。
- 兩個 hook 可能拿到一樣的 seq：8 個 hook 同時觸發時，不同核心上的 process 偶爾會在同一個 ns 讀時鐘（平行測試連跑 30 次撞了 4 次）。herdr 收先到的那筆、忽略後到的，這不會出錯：一樣的 seq 代表兩邊在同一個 ns 取號，那時兩邊自己的改動都已經完成、也都還沒 readdir（readdir 要幾 µs），所以兩筆都包含 seq 不大於它的每一個改動；之後才完成的改動，那個 hook 是改完才取號，seq 一定比較大，它的回報會蓋過這兩筆。那 30 次側邊欄最後都等於檔案狀態；另有測試讓一個 hook 在另一個 hook 取 seq 的當下拿到一樣的 seq，檢查兩筆都正確。毫秒的 seq 不一樣：同一毫秒內別的 hook 還來得及改完檔，被忽略的那筆可能是唯一看到改動的（見下面的 POC）。撞號無害的前提是時鐘的 tick 比「讀時鐘到 readdir」之間的時間短。開發機的 clocksource 是 `tsc`（ns 等級，看 `/sys/devices/system/clocksource/clocksource0/current_clocksource`）；退到 `hpet`、`acpi_pm`（tick 約 70–280 ns）推測仍成立（未驗證）；退到 `jiffies`（1/HZ，ms 等級）就跟毫秒 seq 一樣會漏（未驗證）。
- 沒改任何檔的事件（`Stop`／`StopFailure` 沒有要清的 sub、`SubagentStop` 找不到自己的檔）不取 seq、不呼叫 herdr；`SessionStart` 一定重畫。
- 清除結束的 sub 時，判斷之後別的 hook 可能剛好 resume 了它（重寫了它的檔）。先讀再刪的話，兩步中間換上的新檔會被刪掉，所以先把檔 `rename` 到隨機的暫存名「拿走」，讀拿到的那一份，啟動時間跟判斷時一樣才刪；不一樣（resume 的新一輪）就用 `link` 放回去（路徑上已經有更新的檔就不放，`link` 不會覆蓋）。拿走到放回之間別的 hook readdir 會看不到它，所以放回也算改動，之後一定取 seq、重畫。
- POC（真的 herdr，8 個 hook 同時觸發、20 輪×3 種情境：同時 start、同時 stop、start 後馬上 stop；一般、`taskset -c 0`、再加 4 或 6 個吃滿 CPU 的 process）：這個做法 0 次漏掉；seq 用毫秒時撞號漏 22/60，在寫檔之前取 seq 漏 1–2/60，不帶 seq 漏 10–19/60。
- 跟 lock 版比（假 herdr 每次 30 ms、5 個跑中的 sub 各有約 1 MB 的 transcript、main transcript 約 3 MB；時間含 node 啟動）：
  - 單一 `SubagentStart`：兩版一樣，約 75 ms，CPU 約 39 ms（大部分是 node 啟動）；鎖在 1 個 CPU、旁邊 4 個吃滿 CPU 的 process 時約 255 ms。
  - 8 個同時觸發：一般情況每個 hook 中位數約 76 ms、最多約 90 ms（lock 版約 203 ms、最多約 630 ms）；鎖在 1 個 CPU 加 4 個吃滿 CPU 的 process 時中位數約 545 ms、最多約 650 ms（lock 版約 665 ms、最多約 1.3 秒）。
  - 兩版都沒有漏掉更新（一般 15 輪、很忙時 16 輪，每輪 3 種情境）。

### 從舊版升級

舊版每個 session 一個 `session-<sessionId>.json`，用 `session-<sessionId>.json.lock` 串起讀改寫。

- 新版每個事件都看一下自己 session 的舊檔（不存在只多一次 open 失敗），把裡面還在跑的 sub 搬成 sub 檔（已經有的不蓋；`status` 是 `"done"` 的是更舊版本留下的已結束項目，不搬），再刪掉舊檔。所以升級時正在跑的 sub 不會從側邊欄消失，之後照常由它的 `SubagentStop` 或清除拿掉；搬過來的若其實已經結束，同一次事件的清除就會判斷。
- 舊版留下的 `.lock`、`.break-*` 不理也不刪：新版不讀它們，跟其他檔案一樣在 tmpfs 上，重開機（或登出時 `XDG_RUNTIME_DIR` 被清掉）就沒了。活著的 process 名下的 lock 也擋不到新版。
- 升級那一刻還在跑的舊版 hook 若在搬完之後才寫回舊檔，下一次事件會再搬一次；舊檔裡已經沒有、sub 檔卻還在的 sub 不會因此被刪，要等清除拿掉。
- 升級那一刻有兩種情況會讓已經停掉的 sub 又被算進去：上面說的舊檔被寫回，以及兩個新版 hook 同時搬同一個舊檔。見已知限制。

### 沒收到 SubagentStop 就結束的 sub

只靠 `SubagentStop` 移除的話，因 API 錯誤停下來的 sub 會一直留在清單裡：2026-10-10 一個額度用完的 sub（transcript 最後一行是 `isApiErrorMessage: true` 的 assistant 紀錄）在側邊欄卡了好幾個小時；Claude Code 為什麼沒觸發它的 `SubagentStop` 未驗證。所以每次 hook 事件（`SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure`）都會檢查這個 session 每個 sub 檔對應的 transcript，刪掉已經結束的 sub 的檔：

- 位置：`<main transcript 去掉 .jsonl>/subagents/agent-<id>.jsonl` 與旁邊的 `agent-<id>.meta.json`；task notification 從 main transcript（事件的 `transcript_path`）讀。main transcript 不存在或路徑不是絕對路徑時什麼都不拿：sub 的路徑不能信。
- 每個 transcript（含 main transcript）只讀最後 64 KB，切到一半的第一行丟掉。
- 清除只是 `SubagentStop` 漏掉時的安全網，三個條件都成立才拿掉：
  1. sub transcript 最後一筆有效紀錄（`user`／`assistant`）是結束訊號，種類：
     - popup viewer 的規則（見 [internals](internals.zh-TW.md#資料來源與結束判斷)，同一份 `lib/subagent-state.mjs`）：`SubagentHandback`（後面只能接它自己的 tool_result）、非 background sub 的 `end_turn`。viewer 的「10 分鐘沒寫入」不用在這裡；
     - main transcript 裡 `completed`／`killed`／`failed` 的 `<task-notification>`：只看 `enqueue` 那一行的時間，要不早於最後一筆有效紀錄；最後一筆是新送進來的指令（不是 tool_result 的 `user`，例如 resume 送進來的）時不信。`remove`（出列）的時間不用：出列可能晚於 resume 或 sub 之後的紀錄，本機一個 sub 在 `SubagentHandback` 之後因排隊的訊息繼續跑 Bash，那則通知的出列時間比當時最後一筆紀錄晚；
     - API 錯誤（`isApiErrorMessage: true`）。本機 3 個遇到 API 錯誤的 sub 都停在這一筆，之後沒有任何紀錄；
     - `[Request interrupted by user…]`。本機 3 個這樣結尾的都是被中斷的背景 sub，main transcript 同一刻都記了 `killed`（那則通知可能已經不在最後 64 KB 裡）；
  2. 結束訊號不早於這一輪的 `SubagentStart`（不留誤差）。resume 的 sub 在寫出新紀錄之前，transcript 尾端還是上一輪的結束訊號，所以每次 `SubagentStart`（包括清單裡已經有這個 sub 的情況）都把啟動時間換成這次事件的時間；
  3. 現在距離最後一筆紀錄、transcript 的 mtime（task notification 則是通知的時間）都已經 2 分鐘以上（`quietAfterEndSignalMs`）。resume 之後、新一輪寫出紀錄之前的那幾秒不會被清：本機 21 次 resume，`SendMessage` 到新一輪第一筆紀錄最多約 5 秒、到第一筆 assistant 回應最多約 10 秒。
- `SubagentStart` 之後 2 分鐘 transcript 還不存在也拿掉（實測 `SubagentStart` 之後約 0.1 秒就出現）。
- 沒有結束訊號的 sub 一直留著，不管多久沒寫入。舊版另有「60 分鐘沒寫入就清」，已經拿掉：本機 2 個 sub 在同一輪內 7 小時、23 小時沒寫入之後繼續跑（推測是電腦睡眠，未驗證），會被誤刪。
- 代價：`SubagentStop` 漏掉的 sub 不會馬上消失，要等最後一次寫入 2 分鐘後的下一次 hook 事件（主 session 回合結束、別的 sub 開始或結束、session 開始）。
- 為什麼這樣定：用本機 210 個 sub（231 輪，其中 21 次 resume）的真實時間軸模擬，hook 時間點取 main transcript 的回合結束與同 session 其他 sub 的開始、結束。舊規則（訊號不早於 `SubagentStart` 前 2 秒就清，resume 時沿用舊的啟動時間，加上 60 分鐘規則）誤刪 4 次，這套規則 0 次（每秒取樣也是 0 次）；漏掉 `SubagentStop`、因 API 錯誤停下的那個 sub，每秒取樣時在最後一筆紀錄 120 秒後拿掉。
- 正在處理的那個事件的 sub，這次不判斷（`SubagentStop` 的本來就會被拿掉；`SubagentStart` 的可能是 resume，transcript 還停在上一輪）。
- 耗時：5 個 sub、真實 transcript（每個 0.5–1.8 MB，main transcript 3.4 MB），整個 hook process 約 42 ms（15 次的中位數，其中 node 啟動約 18 ms）。判斷本身約 10 ms，8 個 hook 同時跑最多約 22 ms（5 個 sub、真實 transcript 每個 1.4–2.4 MB，main transcript 3.7 MB）。判斷最多做 100 ms（8 個 hook 擠在 1 個 CPU 上時會碰到），這次事件自己的回報不會被拖太久；剩下的 sub 先留著，下一次事件再檢查。
- 拿本機 210 個 sub transcript（2026-10-11）的現況跑過這套規則：208 個判定結束（`SubagentHandback` 165、`end_turn` 32、task notification `completed` 5、API 錯誤 3、中斷 3）。留下的 2 個：一個是跑這個檢查的 sub 自己；一個 background sub 以 `end_turn` 結尾，它的 `completed` 通知已經不在 main transcript（約 10 MB）的最後 64 KB 裡（見已知限制；當時的 hook 讀得到）。

### herdr 回報

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token "sub1=● 2 running" \
  --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
```

最後一個跑中的 sub 結束時，`sub1` 也用 `--clear-token sub1` 清掉，五個 token 全清。`sub2`…`sub5` 每次回報都清：舊版 setup 寫的設定還有那幾行，舊版留在 pane 上的樹狀行也會在第一次回報時清掉。

- `SessionStart` 一定回報，pane 一換 session，上一個 session 的數量就換掉（或清空）。`SubagentStart`／`SubagentStop` 在清單有變時回報，`Stop`／`StopFailure` 只在有拿掉 sub 時回報；其他時候不呼叫 herdr。
- 只用一個 source `subagent.watch`：herdr 每個 pane 一生最多 32 個 sequenced source，清掉也不會還。
- `--seq` 是「開機時刻（`/proc/stat` 的 `btime`，秒）× 10⁹ ＋ monotonic 時鐘（ns，`process.hrtime`）」，用 BigInt 算、以字串傳給 herdr（herdr 的上限是 u64，超過會 exit 1）。
  - monotonic 時鐘所有 process 共用、解析度到 ns，平行的 hook 很少撞號，撞號也不會出錯（見[平行的 hook 不用 lock](#平行的-hook-不用-lock)）；用毫秒的話常常撞號，而且會漏掉更新（見上面的 POC）。
  - monotonic 時鐘重開機會歸零；加上開機時刻後跨重開機也一直遞增（herdr 重開機後還記不記得舊的 seq 未驗證）。
  - 現在的值約 1.79×10¹⁸，比舊版的毫秒 seq（約 1.79×10¹²）大得多，升級後的第一筆回報不會被忽略。
  - 讀不到 `btime`（沒有 `/proc`）時改用固定的 10¹⁷ ＋ monotonic：一樣到 ns、一樣比舊版大，只是重開機後從小的值重來。
- `agent_type` 不會送給 herdr：那一行只有數量。hook 仍然先拿掉它的控制字元（`\p{Cc}`）和格式字元（`\p{Cf}`，例如 bidi 控制、零寬字元），因為拿掉之後是空字串的 `agent_type` 代表 Claude Code 內部 agent，要略過。
- herdr 路徑用 `HERDR_BIN_PATH`，沒有才找 PATH 上的 `herdr`，而且只看 PATH 裡的絕對路徑：空項目和 `node_modules/.bin` 這類相對路徑是相對於目前資料夾，也就是使用者正在開的 repo，裡面放的 `herdr` 不能被執行。`open-action.mjs`、`scripts/setup.mjs`、`bin/run.sh` 的通知都用同一套規則。
- `bin/run.sh` 更進一步：在跑任何其他指令之前，先把 PATH 的空項目和相對路徑項目拿掉再 export，所以 `dirname`、`sed`、`sort`、`tail`、`cut` 和它 `exec` 的 `node` 也不會從目前資料夾拿。一個都不剩時改用 `/usr/bin:/bin`，因為 bash（Fedora 系的 `sh`）會把空的 PATH 當成目前資料夾。

### 不干擾 Claude session 的設計

這個 hook 是全域的，套用到所有 Claude session：

- 永遠 exit 0、stdout 不輸出（herdr 的輸出也導到 `ignore`），整體預算 1500 ms，不含 node 啟動（herdr 逾時直接 `SIGKILL`）；`settings.json` 的 timeout 是 5 秒當保險。
  - 預算是上限，平常碰不到：8 個 hook 同時觸發（假 herdr 每次 30 ms、5 個跑中的 sub 各有約 1 MB 的 transcript，含 node 啟動）每個 hook 最多約 90 ms；鎖在 1 個 CPU、旁邊有 4 個吃滿 CPU 的 process 時最多約 650 ms。
  - 沒有 lock 之後不會再等別的 hook，預算仍然留 1.5 秒：herdr 呼叫的 timeout 就是剩下的預算，herdr 被砍掉等於漏掉一次更新，調小只會讓很忙時更容易漏，平常又碰不到上限。
- 沒有 `HERDR_PANE_ID`、沒有 `XDG_RUNTIME_DIR`、找不到 herdr 執行檔 → 什麼都不寫，直接結束。
- `bin/run.sh` 找不到 Node.js 22+ 時，對這個 hook 一律安靜地 exit 0（其他入口才印錯誤）。
- `agent_type` 是空字串的 `SubagentStart`／`SubagentStop` 略過：Claude Code 內部 agent（prompt suggestion、`/btw`）也會觸發 `SubagentStop`。
- 沒看過 `SubagentStart` 的 `SubagentStop` 略過。
- `Stop` 每個 session 每一回合都會觸發（回合因 API 錯誤結束時改觸發 `StopFailure`）。這個 session 沒有跑中的 sub 時只列一次資料夾、不呼叫任何東西（整個 process 約 29 ms，大部分是 node 啟動）；有跑中的 sub 但都還沒結束時，多讀它們的 transcript，但不取 seq、不呼叫 herdr。
- `subagent-watch` 資料夾不是自己的、是 symlink、或權限不是 `0700` → 什麼都不寫。
- 同一個 pane 裡別的 Claude session 的事件略過（例如 pane 裡的 claude 用 Bash 跑 `claude -p`）：子 process 繼承同一個 `HERDR_PANE_ID`，不擋的話會蓋掉主 session 的側邊欄那一行和對照檔。五種事件都用同一套判斷：
  - 先數祖先 process 裡有幾組 `claude`。直接父子相鄰的 `claude` 只算一組，所以名為 claude、沒有 `exec` 的 wrapper script 仍然是一組；Bash tool 跑的指令一定隔著一層 shell，巢狀的 `claude -p` 會算第二組。
  - 一組（或沒有）→ 直接收，不問 herdr。
  - 兩組以上 → 問 `herdr pane get <pane>` 的 `agent_session`（herdr 的 claude integration 回報）：跟 payload 的 `session_id` 一樣才更新；不一樣、是別的 agent 的 session、或沒拿到就略過。最多等 300 ms，而且不會吃掉回報 herdr 的最低預算。
  - 單憑 herdr 的 `agent_session` 不會擋掉任何事件，因為它可能是舊的（見已知限制）。

### 已知限制

- 加 hook 時（或升級後重跑 setup 之前）已經在跑的 session 沒收到過 `SessionStart`：在它重開、`/resume`、`/clear` 或 compact 之前，pane 對照檔沒有標記，換 session 時數量也不會馬上重畫。官方文件說設定檔裡 hook 的修改通常會被 file watcher 讀到；已經在跑的 session 之後會不會觸發新加的 `Stop`／`StopFailure` hook 未驗證。
- `claude` 在還有 sub 跑中時結束、這個 pane 也沒有開新 session，它們會一直算在數量裡（沒接 `SessionEnd`）。pane 不再跑 Claude Code 之後 herdr 還會不會顯示 claude 的 rows 未驗證。
- 沒收到 `SubagentStop` 就結束的 sub，要等它最後一次寫入 2 分鐘後、這個 session 的下一次 hook 事件才拿掉。依官方文件，回合因 API 錯誤結束時不觸發 `Stop`、改觸發 `StopFailure`；額度用完、主 session 那一回合也跟著結束時，`StopFailure` 若在 sub 最後一次寫入後 2 分鐘內觸發（兩者相隔多久未驗證），它會一直算在數量裡，直到下一個回合、下一次 sub 事件或下一次 session 開始。`StopFailure` 本身本機未實測。
- 清除只讀 transcript 最後 64 KB：結束訊號之後又寫了超過 64 KB 的其他紀錄、或 task notification 已經不在 main transcript 最後 64 KB 裡時看不到，那個 sub 會一直算在數量裡，直到 pane 換 session。之後的 Claude Code 版本若搬動 sub transcript 的位置，每個 sub 在開始 2 分鐘後的第一次 hook 事件就會被 2 分鐘的規則拿掉。
- 沒有結束訊號的 sub 不會被拿掉：Claude Code process 被砍掉、什麼訊號都沒留下的 sub，會一直算在數量裡，直到 pane 換 session。
- Claude Code 寫出 API 錯誤紀錄之後會不會讓 sub 繼續跑未驗證（本機 3 個都沒有）。如果會，而且隔了 2 分鐘以上才繼續、中間剛好有 hook 事件，它會被提早從數量拿掉。
- herdr 的 `agent_session` 可能是舊的：herdr server 重啟後，它可能停在重啟前（從 session.json 還原）的 session，之後 Claude Code 的 `startup` 回報不會覆寫它（herdr 0.9.3 實測；同一次測試裡 `resume` 回報也沒有覆寫，原因不明）。所以 hook 不靠它判斷哪個是 pane 的主 session，只有祖先 process 掃到兩組以上 `claude` 時才問 herdr。仍然擋不到的：
  - 巢狀的 `claude -p --resume`／`claude -p -c`：herdr 若接受它的回報、把它當成 pane 的 `agent_session`，它的事件會被當成主 session。
  - `exec claude -p`，或只跑這一個指令的 `sh -c 'claude -p …'`（例如 hook command 本身就是 `claude -p …`；sh 會 exec 成 claude）：巢狀的 claude 直接接在主 claude 底下，跟主 claude 算成同一組而被當成主 session，事件會被收。Claude Code 實際怎麼起 hook 的 process 未驗證。
  - 用 npm 安裝的 Claude Code 若 process 名稱是 `node` 而不是 `claude`，祖先掃描算到 0 組，所有事件（包括巢狀的）都會被收（未驗證）。
  - 現在也接了 `SessionStart`、`Stop` 與 `StopFailure`，漏網的巢狀 session 影響比以前大：它每次開始，`SessionStart` 都會用標記改寫 pane 對照檔（popup 跟著它走），並依它自己的 session 重畫數量，通常會把主 session 的那一行清掉。以前只有它的 sub 事件會漏進來。
- hook command 開頭的 `sh` 是 Claude Code 在 `bin/run.sh` 執行之前照使用者的 PATH 找的，`bin/run.sh` 清 PATH 管不到這一步。
- seq 的開機時刻是「系統時間 − 開機後經過的時間」，取到秒（無條件捨去）：系統時間被往回調（手動改時間、NTP 直接跳的 step）時開機時刻跟著變小，又因為只取到秒，就算只往回調幾 ms，seq 也可能退約 1 秒。在時間追上之前，seq 可能比調整前送出的小，那段時間的回報都會被 herdr 忽略，所以往回調多久，側邊欄就可能凍結多久（再加最多 1 秒），不只是幾秒。舊版是同一個 session 上次的 seq＋1，在同一個 session 裡不受影響，這點是小退步。依 Linux timekeeping 的算法，睡眠與 NTP 慢慢校正（slew）不會改變它（未實測）。
- 降回舊版：舊版送的是毫秒 seq（約 1.79×10¹²），herdr 已經記住這個 pane 新版的 seq（約 1.79×10¹⁸），舊版的回報全部會被忽略（exit 0、沒有訊息），側邊欄不再更新。要重開 herdr server 才會恢復（herdr 的存檔沒有記 seq，推論如此，未實測）。
- 只在升級後頭幾次事件附近：hook B（Y 的 `SubagentStart`）讀了舊版的 `session-<sessionId>.json` 之後、link 成 sub 檔之前，hook A（X 的 `SubagentStop`）整個跑完（搬了同一個舊檔、刪掉舊檔、刪掉 X 的檔），B 接著把 X 的檔放回來並回報，已經停掉的 X 又被算進數量。升級那一刻還在跑的舊版 hook 把含有 X 的舊檔寫回時也一樣（見[從舊版升級](#從舊版升級)）。X 要等清除（結束訊號 2 分鐘後）才拿掉。
- hook 改完檔之後、送到 herdr 之前被砍掉（例如 herdr 卡住超過預算），這次改動要等同一個 session 的下一次回報才會顯示。
- 清除時把檔拿走到放回的那幾微秒內，若剛好收到同一個 sub 的 `SubagentStop`，它找不到檔，放回來的 sub 要等清除（結束訊號 2 分鐘後）才從數量拿掉。
- `●` 是 ambiguous width 字元，實際寬度看終端機設定。

## setup 會加什麼

由 `subagent.watch.setup` action（或 `sh bin/run.sh scripts/setup.mjs`）寫入，規則與衝突處理見 [internals](internals.zh-TW.md#setup-細節) 的「setup 細節」。

`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `hooks` 底下（其他設定不動）：

```json
"SubagentStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "sh \"<plugin 目錄>/bin/run.sh\" \"<plugin 目錄>/hooks/sidebar-hook.mjs\"",
        "timeout": 5
      }
    ]
  }
],
"SubagentStop": [ 同上 ],
"SessionStart": [ 同上 ],
"Stop": [ 同上 ],
"StopFailure": [ 同上 ]
```

沒有 `matcher`，所以 `SessionStart` 每種 `source` 都會跑，`StopFailure` 每種錯誤都會跑。你原本就有自己的 `SessionStart`／`Stop`／`StopFailure` hook 的話，這一筆加在它們後面，原本的不動。

從只加 `SubagentStart`／`SubagentStop` 的舊版升級：再跑一次 setup。每個 event 各自檢查，缺的三個補上，原本的兩個不動（`unchanged`），不會重複；已經有其他組合的也一樣，缺哪個補哪個。補上之前 popup 用舊的方式找 session；沒收到 `SubagentStop` 就結束的 sub，要等同一個 session 另一個 sub 的 `SubagentStart`／`SubagentStop`（在它最後一次寫入 2 分鐘以後）才從數量拿掉：清除每個事件都會跑，但只接了這兩種事件。

`<plugin 目錄>` 是 setup 執行當下 plugin 的絕對路徑（`herdr plugin install` 的 managed checkout 或 `herdr plugin link` 的資料夾）。node 不寫進 command，由 `bin/run.sh` 每次找。

setup／remove 認自己的 hook 是比對整個 `command`：必須正好是上面這種寫法（`run.sh` 與 `hooks/sidebar-hook.mjs` 在同一個絕對路徑的 plugin 目錄底下），或是有 launcher 之前手動加的舊寫法 `<node 絕對路徑> <絕對路徑>/hooks/sidebar-hook.mjs`（setup 會原地升級成新寫法）。別的工具的 hook 只是檔名剛好叫 `sidebar-hook.mjs` 不會被改或刪。Claude Code 官方 hooks 文件列的 hook 欄位裡沒有可以放識別資訊的，所以只能比對 command。

寫檔方式：

- 兩個檔案改動前都備份成同資料夾的 `<檔名>.subagent-watch.bak`，**只備份第一次**：`.bak` 已經存在就不覆寫，保留最早的原始檔（想重新備份就自己刪掉舊的 `.bak`）。
- 設定檔是 symlink（例如指向 dotfiles repo）時，寫到它指向的真實檔案，symlink 本身留著；指向不存在的檔案就報錯、不改。只看設定檔本身：路徑上的資料夾是 symlink（例如 Bazzite 的 `/home` → `/var/home`）不會被當成 symlink 提示。
- `config.toml` 的新內容先寫成真實檔案旁邊的暫存檔，用 `HERDR_CONFIG_PATH` 指向它跑 `herdr config check`，通過才 `rename` 過去；沒通過就刪掉暫存檔，原檔完全沒動過，不需要還原。
- `settings.json` 照原檔的縮排、換行字元（CRLF 寫回仍是 CRLF）與結尾換行寫回；remove 沒有東西可拿掉時不寫檔。

`config.toml`（`$HERDR_CONFIG_PATH`，沒設就是 `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`）新增，每段都包在 `# >>> subagent.watch` ／ `# <<< subagent.watch` 之間：

```toml
[[keys.command]]
key = "prefix+."
type = "plugin_action"
command = "subagent.watch.open"
description = "sub agent viewer"

[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$sub1", bold = true, dim = false }],
]
```

前兩行是 herdr 文件裡的預設 rows。`rows_by_agent` 會整個取代 `rows`，不是接在後面，所以預設的兩行要寫進來；如果你在 `[ui.sidebar.agents]` 自訂過 `rows`，claude 那一列會改回這兩行（setup 會提醒）。

`$sub1` 用 inline style table，一律 `bold`：那一行只算跑中的 sub，不用區分狀態。

- 不指定 `fg`：顏色全部跟著 herdr theme，換 theme 也不用改這一行。
- `dim = false`：herdr 文件寫明沒寫的欄位沿用 token 的 contextual style，明確寫 `false` 才會拿掉那個修飾，這裡確保那一行不會被畫成 dim。

舊版 setup 寫的是 `$sub1`…`$sub5` 五行，一個 sub 一行。重跑 setup **不會**改寫它們：setup 看到 claude rows 已經有 `$sub1` 就當成設定好，跟其他已經存在的設定一樣不改寫。不改也沒關係：hook 每次回報都清掉 `sub2`…`sub5`，那四行永遠不會出現。想整理就自己刪掉 `$sub2`…`$sub5` 那四行，或（在 marker 裡的話）先跑 remove 再跑 setup，會寫成上面的一行。

更舊版的 setup 每行還多寫了 `rules = [{ contains = "✓", bold = false }]`。現在不會再出現 `✓`，那條 rule 留著也沒有作用。setup 看到 claude rows 已經有 `$sub1` 就當成設定好，不會改寫；想拿掉就自己刪，或（在 marker 裡的話）先跑 remove 再跑 setup。

## 怎麼移除

1. 跑 `herdr plugin action invoke subagent.watch.remove`（或 `sh bin/run.sh scripts/setup.mjs --remove`）：拿掉 `settings.json` 裡本 plugin 的 hook（認法見「setup 會加什麼」）與 `config.toml` 裡 marker 之間的內容，然後 `herdr server reload-config`。
2. 沒有 marker、手動加的設定要自己刪：`settings.json` 刪掉 `SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure` 底下 `command` 指向 `sidebar-hook.mjs` 的那幾筆（陣列空了就把整個 key 拿掉）；`config.toml` 刪掉 `prefix+.` 那段 `[[keys.command]]` 和 `claude` rows 裡的 `$sub1`（舊版 setup 是 `$sub1`…`$sub5`），再 `herdr server reload-config`。
3. 清掉 pane 上殘留的 token（每個有 claude 的 pane 各跑一次）：

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

   不要帶 `--seq`：herdr 會忽略不比上次收下的大的 seq，hook 送的 seq（約 1.79×10¹⁸）比手動帶的 `$(date +%s%3N)`（毫秒，約 1.79×10¹²）大得多，帶了反而清不掉。沒帶 `--seq` 的回報一律會被接受，也不會重設上次的 seq。

4. 狀態檔在 `$XDG_RUNTIME_DIR/subagent-watch/`，重開機會自動清掉，也可以手動刪掉這個資料夾。

## 測試

```
node --test test/sidebar*.test.mjs test/security-*.test.mjs
```

涵蓋 payload 解析（含實測的 `SessionStart` startup／resume 與 `Stop` payload）、sub 檔（stop 刪檔、沒看過 start 的 stop 略過、resume 換新啟動時間、內容要跟檔名對得上、壞掉的檔略過也不算進數量）、從舊版升級（還在跑的搬成 sub 檔、`done` 項目不搬、不蓋掉已經有的 sub 檔、舊的 lock 不理、只有搬舊檔的 `Stop` 也會回報）、`SessionStart`（pane 對照檔的標記、同一個 session 的 sub 事件留著標記、別的 session 不帶、換 session 時重畫或清空數量）、`Stop` 與 `StopFailure`（不寫 pane 對照檔、有拿掉 sub 才呼叫 herdr；`StopFailure` 用官方文件的 payload，會拿掉因 API 錯誤停下的 sub，也走同一套巢狀 `claude` 判斷）、清除沒收到 `SubagentStop` 就結束的 sub（實測的 API 錯誤與中斷 transcript 尾端、沿用 viewer 的規則、只看最後一筆有效紀錄、結束訊號後 2 分鐘沒寫入才清、resume 前的結束訊號不算（不留誤差）、resume 時啟動時間換新、review E2E 時間軸：上一輪結束 2 秒內 resume 不會被清、task notification 只看 `enqueue` 時間、最後一筆是新指令時不信通知、沒有結束訊號的 sub 不管多久沒寫入都留著、transcript 不存在的 2 分鐘規則、只讀最後 64 KB、預放的 FIFO 不會卡住、時間預算、transcript 都在取 seq 之前讀、只刪中間沒被別的 hook 改過的、resume 的檔放回且照樣重畫、沒有要清的 `Stop` 不取 seq 也不呼叫 herdr）、側邊欄那一行（start 兩個 → `● 2 running` → stop 一個 → `● 1 running` → 全部 stop 全清、沒有上限、只算跑中、每次回報都清掉 `sub2`…`sub5`、`agent_type` 不送給 herdr、它的 bidi／零寬字元拿掉）、seq（BigInt、開機時刻＋monotonic、跨重開機遞增、比舊版的毫秒 seq 大、讀不到 `btime` 的退路、在改完檔之後與 readdir 之前取）、非 herdr 環境靜默、沒有 `HERDR_BIN_PATH` 時改找 PATH 上的 herdr（相對路徑的 PATH 項目不算）、`bin/run.sh` 不執行相對路徑 PATH 項目裡的任何指令、判斷 pane 的 session（祖先只有一組 `claude` 時 herdr 回報舊的 `agent_session` 也照常更新、名為 claude 的 wrapper 照常更新、巢狀 `claude -p` 除非 herdr 回報的就是它的 session 否則略過，用真的 process 樹測）、狀態資料夾檢查（symlink、權限、owner、預放的 symlink）、不用 lock 的平行更新（用真的 process 讓 8 個 hook 同時 start、同時 stop、start 後馬上 stop、start 與 stop 交錯，假 herdr 照 herdr 的規則、依送達的先後只收比較大的 seq，最後顯示的一定等於檔案狀態；seq 可以撞號，但帶著這個階段最大 seq 的每一筆都要等於檔案狀態；一個 hook 在另一個 hook 取 seq 的當下拿到一樣的 seq，兩筆都正確；把另一個 hook 插進取 seq 或回報的當下的各種組合，以及隨機的巢狀交錯；舊版留下的各種 lock 旁邊 8 個 hook 同時觸發也不掉）、整體預算不超過 `settings.json` timeout 的一半，以及用假的 herdr 執行檔實際跑 script（檢查 exit 0、stdout 空、1 秒內結束）。
