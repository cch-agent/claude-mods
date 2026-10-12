# my-mods 進度與決策

## 2026-10-12
- 依 `history.jsonl` 統計常用指令（/exit、/model、/usage、/status、/clear、grill-with-docs、implement；
  自然語言：commit and push、code-review 後 commit、新 session 前先記錄進度）。
- 決定新增兩個 mod：
  - `claude-buddy`：輸入框上方的 Claude 娃娃，依 context % 說話；段落結束且 ≥50% 時以小模型判斷是否建議開新 session。
    省資源原則：不輪詢，只在 `session.measure` / `turn.complete` 更新；模型呼叫最多每 3 個段落一次、失敗退回本地規則。
  - `ship`：`/ship` 指令，流程為獨立 sonnet code-review → 使用者確認 commit 訊息 → commit & push。
- 假設：API 只提供 `AbovePrompt` band，視為「usage bar 下方」的實際位置。
- 分工：兩個 sonnet 實作 agent 並行；實作完成後由另一個不同的 agent review，再 commit。
- 狀態：已實作並通過 review，待 commit；待實機驗證：/ship 的 detached prompt.submit、buddy 與 handoff-button 外掛順序。
- 命名：plugin 名稱因 `claude-` 為保留字而改為 `context-buddy`，資料夾已由 `claude-buddy/` 改名為 `context-buddy/`（上方 `claude-buddy` 為早期代稱）。
- review 修正已套用：isWrapUp 待辦語氣優先、generation 計數丟棄過期 verdict、verdict 僅對該段落有效、交接提示需下層有 key=`handoff` 按鈕、
  /ship prompt 納入 untracked 與 staging 限制、補充說明置於約束之後。
