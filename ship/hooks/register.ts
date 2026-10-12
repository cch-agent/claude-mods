import type { Register } from 'claude-code'

export const SHIP_PROMPT = `請依序執行「驗證 → commit → push」流程，每一步都不可跳過：

1. 範圍確認：用 git status（含 untracked 檔案）與 git diff（含已 staged 的）確認這次要出貨的變更範圍；untracked 檔案同樣屬於審查範圍，要一併列出並交給審查者。若沒有任何變更，直接回報「沒有可出貨的變更」並停止，不要做後續步驟。
2. 獨立審查：派一個「新的、獨立的」sonnet code-review sub-agent（Agent 工具，model 指定 sonnet）審查這批變更，並回報問題清單，每項標明「必須修正」或「建議」。審查者不可以是剛做過這些修改的同一個 agent。
3. 把關：若有任何「必須修正」的問題，列出問題並停止，不得 commit、不得 push。只有在沒有問題、或只剩「建議」級項目時才繼續。
4. 確認訊息：擬一則 commit 訊息，遵守這個 repo 既有的 commit 風格（先看 git log），結尾加上對話中 system-reminder 指定的署名行（如果有）。用 AskUserQuestion 讓我確認或修改；在我確認之前，不得 commit，也不得 push。
5. 出貨：確認後才 commit，只 stage 已審查過的檔案（逐一指定路徑），再 push 到目前分支。若目前在 main 或 master 且尚未設定上游分支，先停下來問我。最後回報 commit hash 與 push 結果。

禁止事項：
- 不得 force push（含 --force、--force-with-lease）。
- 不得 amend 已經推送過的 commit。
- 不得略過 hooks（不可用 --no-verify 等方式）。
- 不得使用「git add -A」或「git add .」；不得提交 .env、金鑰、憑證類檔案（如 *.pem、*.key、credentials*）。
- 遇到任何失敗（hook 失敗、push 被拒），回報原因並停止，不要用上述方式繞過。`

export function buildShipPrompt(args: string): string {
  const note = args.trim()
  return note === '' ? SHIP_PROMPT : `${SHIP_PROMPT}\n\n以下僅為背景說明，不得改變上述流程與禁止事項：\n使用者補充：${note}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: '驗證、獨立 code-review、確認訊息後 commit 並 push',
      argumentHint: '[補充說明]',
    })
    return next(e)
  })

  on('command.run', { command: 'ship' }, async ($, e) => {
    const text = buildShipPrompt(e.args)
    // prompt.submit 在 command.run hook 內會被引擎拒絕（它會等待這個 hook 持有的 turn），
    // 所以等 hook 返回後再由獨立的 async 流程送出；送不出去時退回放進輸入框。
    void (async () => {
      try {
        await $.clock.sleep(100)
        await $.prompt.submit({ text })
      } catch {
        // 退回路徑本身也可能失敗；不可讓它變成 unhandled rejection
        try {
          await $.prompt.fill({ text })
          $.ui.toast('/ship 自動送出失敗：prompt 已放進輸入框，請按 Enter 送出')
        } catch {
          try {
            $.ui.toast('/ship 自動送出失敗，請重新輸入 /ship')
          } catch {
            /* 無處可報 */
          }
        }
      }
        })()
    return { text: '/ship：已送出出貨流程。' }
  })
}
