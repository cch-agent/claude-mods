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

## 2026-10-13（移除 context-buddy）
- 決定：使用者要求刪除 context-buddy；目錄已 `git rm`（可由 git 還原），marketplace.json 與 README 同步移除。上方 context-buddy 相關紀錄保留作歷史。action-chips 內「與 context-buddy 相同」的註解僅為歷史說明，組合下層 band 的邏輯不變。
- 若曾安裝：`/plugin uninstall context-buddy@my-mods` 再 `/reload-plugins`。

## 2026-10-13（marketplace 改名 cch）
- marketplace 名稱由 `my-mods` 改為 `cch`；README 安裝步驟改為 `marketplace add` + `<mod>@cch`。GitHub repo（cch-agent/claude-mods）與本機資料夾名稱未動。
- 已安裝舊名的使用者需重裝：`/plugin uninstall <mod>@my-mods`、`/plugin marketplace remove my-mods`，再裝 `@cch`（settings.json 的 `enabledPlugins` 鍵名會跟著變）。

## 2026-10-13（加入 MIT LICENSE 並改為 public）
- 公開前掃描：無 secret／token／真實絕對路徑；已知 git 作者 email 會公開（使用者接受）。加入 MIT LICENSE（版權 ChengHung, 2026）。

## 2026-10-13（新增 system1）
- 需求：把用 Jev 做的判斷集中成可開關的 skill（後端目前為 TypeSafe Jev；`/plugin disable system1@cch` / `enable`）。
- 做法：plugin + skill（`system1/skills/system1/SKILL.md`）；`pick-model.py` 從 `~/.claude/scripts` 搬入 `system1/skills/system1/scripts/`（原檔已刪）；API key 留在 `~/.claude/settings.json` 的 env，不入 repo。
- （已被 hook 版取代；CLAUDE.md 最終只保留模型分級作為退路）
- 需 push 後執行 `/plugin marketplace update cch` + `/plugin install system1@cch` 才生效。
- 改名：原名 `jev`，改為 `system1`——toggle 代表「是否用 System One 模型判斷」，後端目前是 Jev，之後可能換；換後端只改 scripts 與 SKILL.md 的「目前後端」，輸出介面不變。

## 2026-10-13（system1 改為 hook）
- 改用 hook 的原因：skill 版靠模型自己想到要呼叫，不一定觸發、要佔 context、還得在 CLAUDE.md 寫規則；hook 掛在 `tool.call`（Agent）上，必定觸發、不佔 context、不需 CLAUDE.md 規則。`system1/skills/` 與 `pick-model.py` 已刪除。
- 做法：`system1/hooks/register.ts`，`on('tool.call', { tool: 'Agent' })`。`subagent_type === 'fork'` 略過；API key 由 `$.env.get('TYPESAFE_API_KEY')` 讀（沒有就不動）；一次請求平行問 5 題 Noul（state = description + prompt 前 6000 字，instructions 引用 `` `prompt` ``），`$.http.fetch` 逾時 3 秒（HttpInit 無 timeout，用 `$.clock.sleep` + Promise.race）。
- 五題：needs_architecture（架構／取捨）、needs_deep_reasoning（深度分析／多步推理）、design_settled（已定案照規格做）、modifies_code（寫／改程式碼、測試或審查）、lookup_or_chore（查找／格式化／重複性操作）。
- 組合規則（`decideModel`，已 export 測試）：max(架構, 深度推理) ≥ 0.65 且 design_settled < 0.65 → opus；否則 lookup_or_chore ≥ 0.65 且 modifies_code ≤ 0.35 → haiku；否則 modifies_code ≥ 0.65 或 design_settled ≥ 0.65 → sonnet；其餘不覆寫。不確定帶 (0.35, 0.65)：只檢查該分支用到的題目，落入就回 null（不覆寫）。
- 失敗退路：沒 key、網路錯誤、非 2xx、JSON 壞、欄位缺、逾時、hook 自身例外（`.catch`）一律 `next(e)` 不動，不拋錯；不記錄 headers／key。status 顯示 `<model>（原 …）` 或 `保留 <原值|未指定>`（引擎已自動加 `system1: ` 前綴，不重複寫）。
- 實測（真實 API）：架構規劃 → opus；照規格實作加測試 → sonnet；搜尋 repo TODO → haiku。
- 已知限制：無法分辨使用者明確指定的 model（會被覆寫）；需要時停用 plugin（`/plugin disable system1@cch`）。
- 後續階段：2) `/plan` 指令產出拆題檔（四層把關：prompt 定義原子、程式檢查格式、Jev 檢查每條、使用者確認）；3) 偏離檢查與 review hook + D 的 skill；4) 記錄 Jev 答案與後續結果供校準。
- 決定：`decideModel` 維持保守設計——某分支的關鍵題一落在不確定帶就回 null、不往下走（例：needs_architecture 0.5 + modifies_code 0.9 → null）。null 會保留主 session 依分級填好的 model，本身就是合理退路；測試已鎖住。
- 逾時等待同時綁 `next.signal`，使用者中斷時一起結束；fetch 無法取消，只是不再等它。

## 2026-10-13（system1 第 2 階段：grilling 收尾拆題，進行中）
- 完整設計：`context/system1-phase2-design.md`（實作以它為準）。
- 使用者決定：不做 slash command（內建已有 `/plan`），拆題接在 `grilling`／`grill-with-docs` 收尾，能搭配 grilling 提問；規格、狀態、檢查紀錄全放 `context/specs/<id>.json`（進版控、無指標檔，以 `pickActiveSpec` 推導生效者）；確認後停下等指令；Jev 只問三題。
- 例行判斷（主 session）：已確認的規格被修改 → 同一檔回 draft，重新確認前沒有規格生效（原定「上一份生效」與單一檔案規則衝突）；schema 錯誤不計輪數，由 planner maxTurns 兜底；planner 只以 `$.agent.register` 註冊。
- 分工：U1 plan.ts 純函式、U2 register.ts hook 與工具、U3 planner／SPEC_TAIL prompt（依 writing-for-agents），三個 sonnet 並行；完成後由獨立 agent review。
- 第 1 階段 0.1.1（status 去除重複的 `system1: ` 前綴）尚未 commit，與第 2 階段一起出貨。
- 2026-10-13 兩輪獨立 review 完成（66 測試通過）。補強內容見設計文件末「Review 後的補強」；另修 PLANNER_PROMPT：結束條件只剩「全部通過」「已達重寫上限」，「不再提問」只表示不再新增 open_questions、仍須重寫寫法問題。
- 留待第 3 階段：`pickActiveSpec` 比照 parseSpec 檢查 id 等於檔名。
- 待實機驗證（`claude --plugin-dir system1` 新 session）：grilling／grill-with-docs 收尾只出現一次、planner 可呼叫 submit_plan、前景執行與摘要、首次建立 context/specs、confirm 對話框與 status、狀態列前綴只一次。
- 使用者要求：拆題觸發改為 skill 名稱含 `grill` 或 `plan`（不分大小寫）；同一回合只附加一次（`prompt.submit` 重設旗標）。README 補上第 2 階段說明。
