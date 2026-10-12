# my-mods 進度與決策

## 2026-10-12
- 依 `history.jsonl` 統計常用指令（/exit、/model、/usage、/status、/clear、grill-with-docs、implement；
  自然語言：commit and push、code-review 後 commit、新 session 前先記錄進度）。
- 決定新增兩個 mod：
  - `claude-buddy`：輸入框上方的 Claude 娃娃，依 context % 說話；段落結束且 ≥50% 時以小模型判斷是否建議開新 session。
    省資源原則：不輪詢，只在 `session.measure` / `turn.complete` 更新；模型呼叫改為每個收尾且 ≥50% 的段落一次（詢問中不重入；原「每 3 段一次」已於 2026-10-12 取消）、失敗退回本地規則。
  - `ship`：`/ship` 指令，流程為獨立 sonnet code-review → 使用者確認 commit 訊息 → commit & push。
- 假設：API 只提供 `AbovePrompt` band，視為「usage bar 下方」的實際位置。
- 分工：兩個 sonnet 實作 agent 並行；實作完成後由另一個不同的 agent review，再 commit。
- 狀態：已實作並通過 review，待 commit；待實機驗證：/ship 的 detached prompt.submit、buddy 與 handoff-button 外掛順序。（已作廢：handoff-button 已移除）
- 命名：plugin 名稱因 `claude-` 為保留字而改為 `context-buddy`，資料夾已由 `claude-buddy/` 改名為 `context-buddy/`（上方 `claude-buddy` 為早期代稱）。
- review 修正已套用：isWrapUp 待辦語氣優先、generation 計數丟棄過期 verdict、verdict 僅對該段落有效、交接提示需下層有 key=`handoff` 按鈕、
  /ship prompt 納入 untracked 與 staging 限制、補充說明置於約束之後。

## 2026-10-12（context-buddy：換新 session 按鈕）
- context-buddy 由「只說話」改為段落結束且適合開新 session 時顯示按鈕（key=`buddy-handoff`）：按下 → 送 REQUEST（七章節，存 `.claude/handoffs/handoff-<stamp>.md`）→ turn.complete 存檔 → detached `/clear` → `$.prompt.submit` OPENING；失敗退回 `$.prompt.fill` + toast（fill 也包 try/catch）。
- 顯示條件：主執行緒、非 isWorking、非 hasSurvey、phase idle，且 `verdict.restart===true`；或 verdict 為 null 且 wrapUp 且 context≥75%（詢問進行中不套用後備，新增 atom `asking`）。
- haiku 判斷 prompt 強化：依答覆中的下一步／待辦判斷與目前脈絡是否相關；未提及時以 context% 為主。
- 新增 atom：`phase`（idle/writing/clearing）、`asking`；與 handoff-button 共存：下層出現「交接：」狀態文字時隱藏自己的按鈕，避免雙重交接。（已作廢：handoff-button 已移除）
- 待實機驗證：按鈕在 AbovePrompt 的排版（Box 內 Text + Button 同列）、detached `/clear` 後 `prompt.submit` 是否照常送出、與 handoff-button 同時存在時的外層／內層順序、detached `/clear` 觸發的 `session.end{reason:'clear'}` 會把 phase 重置為 idle（已確認不影響 OPENING 的 `prompt.submit`，之後 `update(phase,'idle')` 為冪等）。（已作廢：handoff-button 已移除）

## 2026-10-12（context-buddy：review 修正）
- `/clear` 只觸發 `session.end{reason:'clear'}`、不觸發 `session.start`（d.ts SessionEndInput、reference.md）。新增 `session.end` hook 與 `session.start` 共用同一套重置：generation/epoch+1、pendingPath=null、isAsking=false、phase→idle、asking→false、清 verdict、wrapUp=false。
- 熱重載後 atom 保留、閉包變數重置：重置不再依賴 pendingPath，phase 非 idle 一律改回 idle。
- `epoch` 計數只在 session 邊界 +1：重置前發出的舊詢問收尾時不再動 isAsking／asking，避免誤關新一輪詢問的旗標；舊 verdict 仍由 generation 丟棄。
- 按鈕連按：guard 通過後、第一個 await 前同步設 `isStarting`，finally 還原。
- turn.complete：asking=true 先於 wrapUp 寫入，避免 verdict=null/asking=false/wrapUp=true 過渡態讓按鈕閃現。
- 與 handoff-button 的反向重複觸發：buddy 進行中時狀態文字加註「（請勿再按『交接』）」；`hasText(below,'交接：')` 與其文案耦合（已於程式註解標明），handoff-button 未改。（已作廢：handoff-button 已移除）
- handoff() 的 `update(phase,'clearing')` 與空摘要 toast 包 try/catch，避免 phase 卡 writing。
- 設計取捨（S4，已解決，見下方「每個收尾段落都詢問」）：後備規則（verdict 為 null + wrapUp + ≥75%）與「每 3 個收尾段落才詢問」並存。詢問間隔內（及詢問失敗、模型回壞資料時）verdict 為 null，≥75% 且該段落收尾就會顯示按鈕；也就是 ≥75% 時按鈕不依賴模型判斷，可能在「下一份工作仍與脈絡相關」時提示換新 session。取捨：高 context 時寧可多提示一次，也不讓使用者因模型沒被問到而錯過；按鈕只是建議、不自動執行。
- 測試：47 項通過。變異驗證：移除 session.end 重置 → 3 項失敗；session.start 改回依賴 pendingPath → 1 項失敗；移除 isStarting → 雙擊測試失敗；移除 epoch 判斷 → 1 項失敗；移除交接分支 wrapUp 重置 → 1 項失敗。

## 2026-10-12（移除 handoff-button，併入 context-buddy）
- 決定：只留 context-buddy 的「換新 session」按鈕；`handoff-button/` 目錄已 `git rm`（可由 git 還原），marketplace.json 與 README 同步移除。
- context-buddy 移除與 handoff-button 共存的耦合：`hasKey(...,'handoff')`、`hasText(...,'交接：')`、「可按『交接』」提示、「（請勿再按『交接』）」註記、`otherBusy`、`HANDOFF_HINT_PERCENT` 及對應測試（刪 2 項：清空中文字不附加、handoff-button 進行中隱藏按鈕；改寫 1 項：共存提示）；共存測試改為通用的「下層 AbovePrompt 被保留並組合」。仍保留 `next(e)` 組合與 isTree 判斷。按鈕顯示條件與交接流程未變。
- 使用者端待辦：執行 `/plugin uninstall handoff-button@my-mods`（本 repo 不改使用者 settings.json）。
- 「與 handoff-button 外掛順序」的待實機驗證項目作廢。

- context-buddy 版本升為 0.2.0（功能大幅變更，避免快取的 0.1.0 不更新）。
- 建議補測（低優先）：phase≠idle 時 onPress 直接返回（目前拿掉該行測試仍全過）。

## 2026-10-12（context-buddy：每個收尾段落都詢問）
- 需求：「到一個段落，且目前 context＋下一份工作適合開新 session，才顯示按鈕」。原「每 3 個收尾段落詢問一次」使其餘段落只靠後備規則（不評估下一份工作），50–74% 的中間段落完全無判斷。
- 改動：移除 `ASK_EVERY_SEGMENTS` 與 `segmentsSinceAsk` 計數器；`shouldAsk(pct)` 只看 `pct >= 50`，呼叫端以 `isWrapUp` 把關，每個「收尾且 ≥50%」段落詢問一次。`isAsking` 防重入、`generation` 丟棄過期結果、`epoch`（舊詢問收尾不動新旗標）、session.end/start 重置、`asking` atom 皆保留。
- 後備規則（verdict=null + wrapUp + ≥75% + 非詢問中）語意不變，現在只在模型失敗／回壞資料／逾時／結果被丟棄時才會生效。S4 取捨因此解決。
- 已知殘餘：詢問進行中又到來的收尾段落會被略過（不重入），該段落若舊詢問結果被 generation 丟棄，則只剩後備規則（≥75%）；成本控制優先，維持現狀。
- 成本控制未變：僅主執行緒 turn.complete、<50% 與非收尾段落不問、交接回合不問、不輪詢；haiku／effort low／maxTokens 200／timeout 20s。

## 2026-10-13（新增 action-chips）
- 需求：回覆後在輸入框上方顯示小框框；要使用者開啟的檔案／網址點了開啟，指令點了複製；每次回覆後更新或清空；依回覆順序由左至右、過長換行；標籤寫「這是什麼」而非檔名（例：web demo、mobile demo）。
- 做法：`turn.complete`（只看主執行緒）從 `e.answer` 抽取 → 路徑需 `$.fs.stat` 存在才收 → 先放備用標籤（檔名／指令開頭），再用 haiku（effort low、timeout 4s）寫描述性標籤；逾時或失敗就留備用標籤。最多 12 個。
- 抽取規則：sh/bash/zsh/shell/console 的 code fence 整塊算一個指令；無語言的 fence 需第一行像指令；行內只收 `! ` 開頭的指令（一般的 `pnpm test` 不收，避免把提到的指令名都做成框）；網址只收 ASCII、括號平衡；路徑去掉 `:12-20`、`#L5`、`#章節`。
- 安全：可執行副檔名（.app/.command/.sh…）用 `open -R` 只在 Finder 顯示。
- 中斷（isAborted）清空；回覆進行中（isWorking）隱藏；與 context-buddy 相同以 `next(e)` 組合下層 band，小框框在上。
- 獨立 sonnet review 的高／中項已修；未做：兩輪 target 完全相同時舊標籤可能套用到新結果（影響小）、未閉合 code fence、巢狀 fence。
- 測試 4 項通過。
- 0.1.1：使用者回報 code fence 裡的 `/plugin install …` 沒出現框框。修正：slash command（斜線開頭且帶參數）在無語言 fence 與行內都算指令；只有一個字的 `/clear` 仍不收，以免把路由名稱（如 `/events`）誤當指令。
