# 側邊欄 sub agent 樹狀行

[English](sidebar.md) | 繁體中文

herdr 側邊欄 claude 那一列底下，用最多 5 行顯示這個 session **還在跑**的 sub agent：

```
<state_icon> <workspace> · <tab>
claude
├─ Explore ●
├─ general-purpose ●
└─ Plan ●
```

- 只列跑中的（`●`），不帶編號。sub 一結束（`SubagentStop`）那一行就拿掉，其餘的重排，`├─`／`└─` 每次都重算。
- 沒收到 `SubagentStop` 就結束的 sub（例如因額度用完等 API 錯誤停下來），在這個 session 下一次 hook 事件時拿掉，最晚是主 session 這一回合結束（`Stop`；那一回合本身因 API 錯誤結束時是 `StopFailure`）時。見[沒收到 SubagentStop 就結束的 sub](#沒收到-subagentstop-就結束的-sub)。
- pane 換 session（新的 `claude`、`/clear`、`/resume`）時，馬上換成新 session 的樹（`SessionStart`）；新 session 沒有跑中的 sub 就清空。
- 沒有任何跑中的 sub 時，側邊欄只剩 claude 那一列。
- 側邊欄不留歷程：結束的 sub 和它做過什麼，用 popup viewer（`prefix+.`）看，見 [README](../README.zh-TW.md)。

## 原理

1. Claude Code 觸發 `SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure` hook，五個都是同一個 command：經 `bin/run.sh` 找到 node 後執行 `hooks/sidebar-hook.mjs`，payload 從 stdin 進來，用 `hook_event_name` 分辨事件。
2. hook 更新狀態檔，再呼叫 `herdr pane report-metadata` 把樹狀行寫進 pane token `sub1`…`sub5`。
   - `SessionStart`：寫 pane 對照檔（標記成 session 開始時寫的，見下面），一定依這個 session 的狀態重畫樹狀行。
   - `SubagentStart`／`SubagentStop`：加入／移除這個 sub，並寫 pane 對照檔。
   - `Stop`（主 session 每一回合結束）與 `StopFailure`（回合改因 API 錯誤結束，例如額度用完）：只拿掉已經結束的 sub，有拿掉才重畫；不寫 pane 對照檔。
   - 每個事件都會先檢查這個 session 的其他 sub，拿掉已經結束的（見[下面](#沒收到-subagentstop-就結束的-sub)）。
3. `config.toml` 的 `rows_by_agent.claude` 多了 `$sub1`…`$sub5` 五行；herdr 文件寫明沒回報的 token 會讓那一行整行消失，所以平常看不到空行。

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

- `session-<sessionId>.json`：`{ sessionId, lastSequence, subagents: [{ id, agentType, startedAtMs }] }`，`subagents` 只放跑中的。`SubagentStop`（或下面的清除）直接把那筆移除，檔案大小只跟同時在跑的 sub 數量有關，不會越長越大。有變動才寫檔，從沒開過 sub 的 session 不會留下檔案。
  - 舊版留下、`status` 是 `"done"` 的項目，下一次事件讀檔時就丟掉。
  - 同一個 sub 還在清單裡又收到 `SubagentStart` 時只留一筆（保留原本的啟動順序）；已經移除後再收到它的 `SubagentStart`（resume）就重新列在最後面。
- `pane-<HERDR_PANE_ID>.json`：給 popup viewer 讀的對照檔：`{"sessionId","transcriptPath","cwd","updatedAtMs"}`，這個 session 的 `SessionStart` 寫的檔案另外帶 `"sessionStartSource"`（那次 `SessionStart` 的 `source`，例 `"startup"`）。**四個欄位固定**；viewer 只把 `sessionStartSource` 當標記用（見 README 的[怎麼找到 pane 對應的 session](../README.zh-TW.md#怎麼找到-pane-對應的-session)）。
  - 同一個 session 的 `SubagentStart`／`SubagentStop` 重寫時留著標記；別的 session 的事件寫的檔案不帶標記，因為不一定收到過那個 session 的 `SessionStart`。
  - `Stop`／`StopFailure` 不寫這個檔案。

寫之前先檢查 `subagent-watch` 資料夾：必須是自己 uid 的、不是 symlink、權限 `0700`，不符合就什麼都不寫（`XDG_RUNTIME_DIR` 本身不存在時也不會幫它建）。

兩個檔案都用「寫暫存檔再 `rename`」，viewer 不會讀到寫一半的 JSON；暫存檔名是隨機的、用 `wx` 建立，不會跟著預先放好的 symlink 寫到別的檔案。

同一個 session 的 read-modify-write 用 `session-<id>.json.lock` 串起來，平行啟動多個 sub 也不會掉資料：

- lock 內容是持有者的 pid、啟動時間（`/proc/<pid>/stat` 第 22 欄）與建立時間。先寫暫存檔再 `link` 成 lock（跟 `wx` 一樣「不存在才建立」），別人讀不到沒寫完的內容。
- 判斷失效：`process.kill(pid, 0)` 查不到、process 是 zombie，或同一個 pid 但啟動時間不同（pid 被重用）。舊版留下的空 lock 沒有 pid，超過 2 秒才算失效；任何 lock 超過 10 秒都算失效（pid 查不準時的保險，hook 本身不到 1 秒就結束）。
- 認 lock 用 inode 加上內容（pid、啟動時間、建立時間）。只看 inode 不夠：ext4 這類檔案系統會把剛釋放的 inode 馬上給下一個新檔，失效 lock 被刪掉後別人新建的 lock 可能拿到同一個 inode。讀不到內容就不刪。
- 接管：先用 `link` 搶 `<lock>.break-<inode>` 這個名字，搶到而且從這個名字讀回來的還是判定失效的那個 inode 與內容才刪 lock，不會刪到別人剛建好的新 lock。搶到的 process 若在刪之前被砍掉，留下的 `.break-*` 超過 2 秒就清掉。
- 釋放時確認路徑上還是自己建的那個 inode 與內容才刪。
- lock 內只讀寫狀態檔、回報 herdr。判斷 sub 是否結束（下一節）要讀的 transcript 在拿 lock 之前讀：放在 lock 內的話，同一個 session 平行觸發的 hook 每個都要多等前面每一個讀完，等不到 lock 的就放棄（`lock-timeout`），放棄的若是 `SubagentStart`，那個 sub 永遠不會出現在側邊欄。
  - 拿到 lock 後重讀狀態檔，只拿掉仍在檔案裡、而且啟動時間跟判斷時一樣的 sub。中間被別的 hook 拿掉又重新啟動（resume）的那筆留著：判斷時讀的是上一輪的 transcript。
  - `Stop`／`StopFailure` 沒有要拿掉的 sub 時，不拿 lock 直接結束。
  - 實測（8 個 `SubagentStart` hook 同時啟動、假 herdr 每次 30 ms 才回應、5 個跑中的 sub 用真實 transcript，狀態檔與 transcript 在 btrfs 上，跑 20 輪）：持有 lock 約 36 ms（中位數），幾乎都是呼叫 herdr 的時間，跟還沒有清除 sub 這個功能時一樣。transcript 在 lock 內讀時約 47 ms；鎖在 1 個 CPU、旁邊另有 4 個吃滿 CPU 的 process 時，160 次更新掉了 46 次，改成 lock 外讀之後 640 次都沒掉。

### 沒收到 SubagentStop 就結束的 sub

只靠 `SubagentStop` 移除的話，因 API 錯誤停下來的 sub 會一直留在清單裡：2026-10-10 一個額度用完的 sub（transcript 最後一行是 `isApiErrorMessage: true` 的 assistant 紀錄）在側邊欄卡了好幾個小時；Claude Code 為什麼沒觸發它的 `SubagentStop` 未驗證。所以每次 hook 事件（`SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure`）都在拿 session lock 之前，檢查這個 session 狀態檔裡每個 sub 的 transcript，拿掉已經結束的：

- 位置：`<main transcript 去掉 .jsonl>/subagents/agent-<id>.jsonl` 與旁邊的 `agent-<id>.meta.json`；task notification 從 main transcript（事件的 `transcript_path`）讀。main transcript 不存在或路徑不是絕對路徑時什麼都不拿：sub 的路徑不能信。
- 每個 transcript（含 main transcript）只讀最後 64 KB，切到一半的第一行丟掉。
- 以下任一成立就算結束：
  1. popup viewer 的規則（見 [README](../README.zh-TW.md#資料來源與結束判斷)，同一份 `lib/subagent-state.mjs`）：`SubagentHandback`、非 background sub 的 `end_turn`、main transcript 裡 `completed`／`killed`／`failed` 的 `<task-notification>`。viewer 的「10 分鐘沒寫入」不用在這裡；
  2. 最後一筆 `user`／`assistant` 是 API 錯誤（`isApiErrorMessage: true`）。本機 3 個遇到 API 錯誤的 sub 都停在這一筆，之後沒有任何紀錄；
  3. 最後一筆 `user`／`assistant` 是 `[Request interrupted by user…]`。本機 3 個這樣結尾的都是被中斷的背景 sub，main transcript 同一刻都記了 `killed`（那則通知可能已經不在最後 64 KB 裡）；
  4. `SubagentStart` 之後 2 分鐘 transcript 還不存在（實測 `SubagentStart` 之後約 0.1 秒就出現）；
  5. 最後手段：沒有任何結束訊號，但 transcript（或 `SubagentStart`，取比較晚的）超過 60 分鐘沒寫入。用來接住 Claude Code process 被砍掉、什麼訊號都沒留下的 sub。門檻是 Bash tool 單次上限 10 分鐘的 6 倍，sub 等指令、等 API 回應不會被拿掉；前景 sub 卡在權限確認超過一小時沒人按的會被拿掉（見已知限制）。
- 早於這個 sub 的 `SubagentStart`（容許 2 秒誤差）的訊號不算：resume 的 sub 在寫出新紀錄之前，transcript 尾端還是上一輪的結束訊號。正在處理的那個事件的 sub，這次不判斷（`SubagentStop` 的本來就會被拿掉）。
- 耗時：5 個 sub、真實 transcript（每個 0.5–1.8 MB，main transcript 3.4 MB），整個 hook process 約 42 ms（15 次的中位數，其中 node 啟動約 18 ms）。判斷本身約 10 ms，8 個 hook 同時跑最多約 22 ms（5 個 sub、真實 transcript 每個 1.4–2.4 MB，main transcript 3.7 MB）。判斷最多做 100 ms（8 個 hook 擠在 1 個 CPU 上時會碰到），讓這次事件自己的更新還有時間等 lock（上限 200 ms 時，8 個 hook 擠在 1 個 CPU、旁邊另有 4 個吃滿 CPU 的 process，640 次更新掉了 5 次；100 ms 時 0 次）；剩下的 sub 先留著，下一次事件再檢查。
- 拿本機 195 個 sub transcript（2026-10-10）跑過這套規則：192 個判定結束（`SubagentHandback` 146、`end_turn` 33、task notification `completed` 7／`killed` 1、API 錯誤 3、中斷 2）。留下的 3 個：兩個當下還在寫（其中一個就是跑這個檢查的 sub），一個約 15 分鐘沒寫入，實際狀態未驗證。

### herdr 回報

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token sub1=├─ Explore ● --token sub2=└─ Plan ● \
  --clear-token sub3 --clear-token sub4 --clear-token sub5
```

最後一個跑中的 sub 結束時，五個 token 全部用 `--clear-token` 清掉。

- `SessionStart` 一定回報，pane 一換 session，上一個 session 的樹就換掉（或清空）。`SubagentStart`／`SubagentStop` 在清單有變時回報，`Stop`／`StopFailure` 只在有拿掉 sub 時回報；其他時候不呼叫 herdr。
- 只用一個 source `subagent.watch`：herdr 每個 pane 一生最多 32 個 sequenced source，清掉也不會還。
- `--seq` 用 `Date.now()`，同一毫秒連發時取「上一筆 + 1」，保證遞增（herdr 會忽略比較舊的 seq）。
- 排序：照啟動時間。跑中的超過 5 個時第 5 行改成 `└─ +N more`，N 只算跑中、沒列出來的。
- herdr token 上限 80 字、會移除控制字元。hook 先拿掉控制字元（`\p{Cc}`）和格式字元（`\p{Cf}`，例如 U+202A–202E、U+2066–2069 的 bidi 控制、U+200B–200F 的零寬字元），不讓 `agent_type` 把側邊欄的字反轉或藏起來；太長時截斷成 `…`，保證 `●` 留在行尾。
- herdr 路徑用 `HERDR_BIN_PATH`，沒有才找 PATH 上的 `herdr`，而且只看 PATH 裡的絕對路徑：空項目和 `node_modules/.bin` 這類相對路徑是相對於目前資料夾，也就是使用者正在開的 repo，裡面放的 `herdr` 不能被執行。`open-action.mjs`、`scripts/setup.mjs`、`bin/run.sh` 的通知都用同一套規則。
- `bin/run.sh` 更進一步：在跑任何其他指令之前，先把 PATH 的空項目和相對路徑項目拿掉再 export，所以 `dirname`、`sed`、`sort`、`tail`、`cut` 和它 `exec` 的 `node` 也不會從目前資料夾拿。一個都不剩時改用 `/usr/bin:/bin`，因為 bash（Fedora 系的 `sh`）會把空的 PATH 當成目前資料夾。

### 不干擾 Claude session 的設計

這個 hook 是全域的，套用到所有 Claude session：

- 永遠 exit 0、stdout 不輸出（herdr 的輸出也導到 `ignore`），整體預算 800 ms（herdr 逾時直接 `SIGKILL`）；`settings.json` 的 timeout 是 5 秒當保險。
- 沒有 `HERDR_PANE_ID`、沒有 `XDG_RUNTIME_DIR`、找不到 herdr 執行檔 → 什麼都不寫，直接結束。
- `bin/run.sh` 找不到 Node.js 22+ 時，對這個 hook 一律安靜地 exit 0（其他入口才印錯誤）。
- `agent_type` 是空字串的 `SubagentStart`／`SubagentStop` 略過：Claude Code 內部 agent（prompt suggestion、`/btw`）也會觸發 `SubagentStop`。
- 沒看過 `SubagentStart` 的 `SubagentStop` 略過。
- `Stop` 每個 session 每一回合都會觸發（回合因 API 錯誤結束時改觸發 `StopFailure`）。狀態檔裡沒有跑中的 sub 時只讀那個檔案、不呼叫任何東西（整個 process 約 30 ms，大部分是 node 啟動）；有跑中的 sub 但都還沒結束時，多讀它們的 transcript，但不拿 lock、不呼叫 herdr。
- `subagent-watch` 資料夾不是自己的、是 symlink、或權限不是 `0700` → 什麼都不寫。
- 同一個 pane 裡別的 Claude session 的事件略過（例如 pane 裡的 claude 用 Bash 跑 `claude -p`）：子 process 繼承同一個 `HERDR_PANE_ID`，不擋的話會蓋掉主 session 的樹和對照檔。五種事件都用同一套判斷：
  - 先數祖先 process 裡有幾組 `claude`。直接父子相鄰的 `claude` 只算一組，所以名為 claude、沒有 `exec` 的 wrapper script 仍然是一組；Bash tool 跑的指令一定隔著一層 shell，巢狀的 `claude -p` 會算第二組。
  - 一組（或沒有）→ 直接收，不問 herdr。
  - 兩組以上 → 問 `herdr pane get <pane>` 的 `agent_session`（herdr 的 claude integration 回報）：跟 payload 的 `session_id` 一樣才更新；不一樣、是別的 agent 的 session、或沒拿到就略過。最多等 300 ms，而且不會吃掉回報 herdr 的最低預算。
  - 單憑 herdr 的 `agent_session` 不會擋掉任何事件，因為它可能是舊的（見已知限制）。

### 已知限制

- 加 hook 時（或升級後重跑 setup 之前）已經在跑的 session 沒收到過 `SessionStart`：在它重開、`/resume`、`/clear` 或 compact 之前，pane 對照檔沒有標記，換 session 時樹狀行也不會馬上重畫。官方文件說設定檔裡 hook 的修改通常會被 file watcher 讀到；已經在跑的 session 之後會不會觸發新加的 `Stop`／`StopFailure` hook 未驗證。
- `claude` 在還有 sub 跑中時結束、這個 pane 也沒有開新 session，那幾行會留著（沒接 `SessionEnd`）。pane 不再跑 Claude Code 之後 herdr 還會不會顯示 claude 的 rows 未驗證。
- 沒收到 `SubagentStop` 就結束的 sub，要等這個 session 下一次 hook 事件才拿掉。依官方文件，回合因 API 錯誤結束時不觸發 `Stop`、改觸發 `StopFailure`；兩個都有接，所以額度用完、主 session 那一回合也跟著結束時，那一行在回合結束時拿掉。`StopFailure` 本身本機未實測，那個當下 sub 的 API 錯誤紀錄是否已經寫進它的 transcript 也未驗證；還沒寫進去的話，那一行會留到下一個回合、下一次 sub 事件或下一次 session 開始。
- 清除只讀 transcript 最後 64 KB：結束訊號之後又寫了超過 64 KB 的其他紀錄時看不到，只能等 60 分鐘的規則。之後的 Claude Code 版本若搬動 sub transcript 的位置，每個 sub 在開始 2 分鐘後的第一次 hook 事件就會被 2 分鐘的規則拿掉。
- 前景 sub 卡在權限確認超過 60 分鐘沒人按，會被 60 分鐘的規則拿掉，之後它的 `SubagentStop` 就略過。
- Claude Code 寫出 API 錯誤紀錄之後會不會讓 sub 繼續跑未驗證（本機 3 個都沒有）。如果會，而中間剛好有 hook 事件，那一行會被提早拿掉。
- herdr 的 `agent_session` 可能是舊的：herdr server 重啟後，它可能停在重啟前（從 session.json 還原）的 session，之後 Claude Code 的 `startup` 回報不會覆寫它（herdr 0.9.3 實測；同一次測試裡 `resume` 回報也沒有覆寫，原因不明）。所以 hook 不靠它判斷哪個是 pane 的主 session，只有祖先 process 掃到兩組以上 `claude` 時才問 herdr。仍然擋不到的：
  - 巢狀的 `claude -p --resume`／`claude -p -c`：herdr 若接受它的回報、把它當成 pane 的 `agent_session`，它的事件會被當成主 session。
  - `exec claude -p`，或只跑這一個指令的 `sh -c 'claude -p …'`（例如 hook command 本身就是 `claude -p …`；sh 會 exec 成 claude）：巢狀的 claude 直接接在主 claude 底下，跟主 claude 算成同一組而被當成主 session，事件會被收。Claude Code 實際怎麼起 hook 的 process 未驗證。
  - 用 npm 安裝的 Claude Code 若 process 名稱是 `node` 而不是 `claude`，祖先掃描算到 0 組，所有事件（包括巢狀的）都會被收（未驗證）。
  - 現在也接了 `SessionStart`、`Stop` 與 `StopFailure`，漏網的巢狀 session 影響比以前大：它每次開始，`SessionStart` 都會用標記改寫 pane 對照檔（popup 跟著它走），並依它自己的 session 重畫樹狀行，通常會把主 session 的那幾行清掉。以前只有它的 sub 事件會漏進來。
- hook command 開頭的 `sh` 是 Claude Code 在 `bin/run.sh` 執行之前照使用者的 PATH 找的，`bin/run.sh` 清 PATH 管不到這一步。
- `●`、`─` 是 ambiguous width 字元，實際寬度看終端機設定。

## setup 會加什麼

由 `subagent.watch.setup` action（或 `sh bin/run.sh scripts/setup.mjs`）寫入，規則與衝突處理見 [README](../README.zh-TW.md#安裝) 的「安裝」。

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

從只加 `SubagentStart`／`SubagentStop` 的舊版升級：再跑一次 setup。每個 event 各自檢查，缺的三個補上，原本的兩個不動（`unchanged`），不會重複；已經有其他組合的也一樣，缺哪個補哪個。補上之前一切照舊：popup 用舊的方式找 session，sub 那一行只有收到 `SubagentStop` 才拿掉。

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
  [{ token = "$sub2", bold = true, dim = false }],
  [{ token = "$sub3", bold = true, dim = false }],
  [{ token = "$sub4", bold = true, dim = false }],
  [{ token = "$sub5", bold = true, dim = false }],
]
```

前兩行是 herdr 文件裡的預設 rows。`rows_by_agent` 會整個取代 `rows`，不是接在後面，所以預設的兩行要寫進來；如果你在 `[ui.sidebar.agents]` 自訂過 `rows`，claude 那一列會改回這兩行（setup 會提醒）。

`$sub*` 用 inline style table，一律 `bold`：側邊欄只會出現跑中的 sub，不用區分狀態。

- 不指定 `fg`：顏色全部跟著 herdr theme，換 theme 也不用改這五行。
- `dim = false`：herdr 文件寫明沒寫的欄位沿用 token 的 contextual style，明確寫 `false` 才會拿掉那個修飾，這裡確保樹狀行不會被畫成 dim。

舊版 setup 每行多寫了 `rules = [{ contains = "✓", bold = false }]`。現在不會再出現 `✓`，那條 rule 留著也沒有作用。setup 看到 claude rows 已經有 `$sub1` 就當成設定好，不會改寫；想拿掉就自己刪，或（在 marker 裡的話）先跑 remove 再跑 setup。

## 怎麼移除

1. 跑 `herdr plugin action invoke subagent.watch.remove`（或 `sh bin/run.sh scripts/setup.mjs --remove`）：拿掉 `settings.json` 裡本 plugin 的 hook（認法見「setup 會加什麼」）與 `config.toml` 裡 marker 之間的內容，然後 `herdr server reload-config`。
2. 沒有 marker、手動加的設定要自己刪：`settings.json` 刪掉 `SessionStart`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure` 底下 `command` 指向 `sidebar-hook.mjs` 的那幾筆（陣列空了就把整個 key 拿掉）；`config.toml` 刪掉 `prefix+.` 那段 `[[keys.command]]` 和 `claude` rows 裡的 `$sub1`…`$sub5`，再 `herdr server reload-config`。
3. 清掉 pane 上殘留的 token（每個有 claude 的 pane 各跑一次）：

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch --seq "$(date +%s%3N)" \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

4. 狀態檔在 `$XDG_RUNTIME_DIR/subagent-watch/`，重開機會自動清掉，也可以手動刪掉這個資料夾。

## 測試

```
node --test test/sidebar*.test.mjs test/security-*.test.mjs
```

涵蓋 payload 解析（含實測的 `SessionStart` startup／resume 與 `Stop` payload）、狀態更新（stop 移除、沒看過 start 的 stop 略過、舊版 `done` 項目丟掉）、`SessionStart`（pane 對照檔的標記、同一個 session 的 sub 事件留著標記、別的 session 不帶、換 session 時重畫或清空樹狀行）、`Stop` 與 `StopFailure`（不寫 pane 對照檔、有拿掉 sub 才呼叫 herdr；`StopFailure` 用官方文件的 payload，會拿掉因 API 錯誤停下的 sub，也走同一套巢狀 `claude` 判斷）、清除沒收到 `SubagentStop` 就結束的 sub（實測的 API 錯誤與中斷 transcript 尾端、沿用 viewer 的規則、resume 前的結束訊號不算、2 分鐘與 60 分鐘的規則、只讀最後 64 KB、預放的 FIFO 不會卡住、時間預算、transcript 都在拿 lock 之前讀、只拿掉中間沒被別的 hook 改過的、沒有要拿掉的 `Stop` 不拿 lock）、樹狀行（start 兩個 → stop 一個剩 `└─` → 全部 stop 全清、`+N more` 只算跑中、80 字截斷、bidi／零寬字元拿掉）、seq 遞增、非 herdr 環境靜默、沒有 `HERDR_BIN_PATH` 時改找 PATH 上的 herdr（相對路徑的 PATH 項目不算）、`bin/run.sh` 不執行相對路徑 PATH 項目裡的任何指令、判斷 pane 的 session（祖先只有一組 `claude` 時 herdr 回報舊的 `agent_session` 也照常更新、名為 claude 的 wrapper 照常更新、巢狀 `claude -p` 除非 herdr 回報的就是它的 session 否則略過，用真的 process 樹測）、狀態資料夾檢查（symlink、權限、owner、預放的 symlink）、lock（失效判斷、接管與釋放不刪到別人的新 lock（拿到同一個 inode 也一樣）、多個 hook 搶同一個失效 lock 不掉資料）、平行啟動不掉資料，以及用假的 herdr 執行檔實際跑 script（檢查 exit 0、stdout 空、1 秒內結束）。
