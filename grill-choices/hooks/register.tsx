import type { Register } from 'claude-code'

const isGrillWithDocs = (skill: string) => skill === 'grill-with-docs' || skill.endsWith(':grill-with-docs')
const isGrilling = (skill: string) => skill === 'grilling' || skill.endsWith(':grilling')

const OVERRIDE = `

## 提問格式覆寫（grill-choices mod，優先於 grilling 的文字格式）

提問時**不要**用純文字的 ❓/➡️ 格式，改用 \`AskUserQuestion\` 工具，讓使用者以選擇題作答：
- 每一輪 frontier 的問題，一次呼叫 \`AskUserQuestion\` 送出（一次最多 4 題；超過就分批連續呼叫，同一輪內不要等使用者做決策以外的事）。
- 每題 2–4 個選項，互斥且具體；把你**建議的答案放第一個**，label 結尾加「(Recommended)」，description 說明理由與取捨。
- 不要自己加「其他」選項：工具會自動提供讓使用者自行輸入的 Other。
- \`header\` 用短標籤（≤12 字）；問題本身若無法歸納成選項（純開放式），仍用 AskUserQuestion，給 2 個你最有把握的選項即可。
- 該由你查證的事實仍然自己查，不要拿來問使用者。
- 使用者回答後照原本的 design tree 流程重算 frontier、進入下一輪。`

export const register: Register = on => {
  let pending = false

  on('skill.prompt', ($, e, next) => {
    if (isGrillWithDocs(e.skill)) {
      pending = true
      return next({ ...e, text: e.text + OVERRIDE })
    }
    if (pending && isGrilling(e.skill)) {
      pending = false
      return next({ ...e, text: e.text + OVERRIDE })
    }
    return next(e)
  })
}
