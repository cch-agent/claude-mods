import type { Register } from 'claude-code'

export type Model = 'opus' | 'sonnet' | 'haiku'
export type QuestionId =
  | 'needs_architecture'
  | 'needs_deep_reasoning'
  | 'design_settled'
  | 'modifies_code'
  | 'lookup_or_chore'
export type Nouls = Record<QuestionId, number>

export const HIGH = 0.65
export const LOW = 0.35
export const API_URL = 'https://api.typesafe.ai/v1/systemone'
export const TIMEOUT_MS = 3000
export const PROMPT_LIMIT = 6000

const QUESTION_TEXT: Record<QuestionId, string> = {
  needs_architecture: '任務是否需要做架構設計，或在多個方案間做取捨決策？',
  needs_deep_reasoning: '任務是否需要深度分析或多步推理才能完成？',
  design_settled: '做法是否已定案，只需照著既定規格執行？',
  modifies_code: '任務是否需要撰寫或修改程式碼、測試，或審查程式碼？',
  lookup_or_chore: '任務是否只是查找資料、搜尋檔案、格式化輸出或重複性操作？',
}
const IDS = Object.keys(QUESTION_TEXT) as QuestionId[]

const uncertain = (v: number) => v > LOW && v < HIGH

/** 五題 Noul 答案 → model；null 代表不覆寫。判斷順序內只檢查該分支用到的題目是否落在不確定帶 (0.35, 0.65)。 */
export function decideModel(n: Nouls): Model | null {
  // opus 分支：max(needs_architecture, needs_deep_reasoning) 與 design_settled
  const arch = Math.max(n.needs_architecture, n.needs_deep_reasoning)
  if (uncertain(arch)) return null
  if (arch >= HIGH) {
    if (uncertain(n.design_settled)) return null
    if (n.design_settled < HIGH) return 'opus'
  }
  // haiku 分支：lookup_or_chore 與 modifies_code
  if (uncertain(n.lookup_or_chore)) return null
  if (n.lookup_or_chore >= HIGH) {
    if (uncertain(n.modifies_code)) return null
    if (n.modifies_code <= LOW) return 'haiku'
  }
  // sonnet 分支：modifies_code 或 design_settled 明確為是
  if (n.modifies_code >= HIGH || n.design_settled >= HIGH) return 'sonnet'
  return null
}

export function buildRequest(description: string, prompt: string) {
  const questions: Record<string, unknown> = {}
  for (const id of IDS) {
    questions[id] = {
      type: 'noul',
      instructions: { task: '`prompt`', question: QUESTION_TEXT[id] },
    }
  }
  return {
    model: 'jev-latest',
    state: { description, prompt: prompt.slice(0, PROMPT_LIMIT) },
    questions,
  }
}

/** 解析 API 回應；任何欄位缺漏或格式不對回 null。 */
export function parseNouls(text: string): Nouls | null {
  try {
    const answers = (JSON.parse(text) as { answers?: Record<string, { noul?: unknown }> }).answers
    if (!answers || typeof answers !== 'object') return null
    const out = {} as Nouls
    for (const id of IDS) {
      const v = answers[id]?.noul
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null
      out[id] = v
    }
    return out
  } catch {
    return null
  }
}

export function statusText(chosen: Model | null, original: string | undefined): string {
  if (chosen === null) return `system1: 保留 ${original ?? '未指定'}`
  return `system1: ${chosen}` + (chosen !== original ? `（原 ${original ?? '未指定'}）` : '')
}

export const register: Register = on => {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type === 'fork') return next(e)
    const key = await $.env.get('TYPESAFE_API_KEY')
    if (!key) return next(e)

    let chosen: Model | null = null
    const abort = new AbortController()
    // 使用者中斷（next.signal）時，逾時等待一起結束；fetch 本身無法取消，只是不再等它
    const onStop = () => abort.abort()
    if (next.signal.aborted) onStop()
    else next.signal.addEventListener('abort', onStop)
    try {
      const body = JSON.stringify(buildRequest(e.description, e.prompt))
      const call = $.http
        .fetch(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
        })
        .then(r => (r.ok ? parseNouls(r.text) : null))
      const timeout = $.clock.sleep(TIMEOUT_MS, { signal: abort.signal }).then(
        () => null,
        () => null,
      )
      const nouls = await Promise.race([call, timeout])
      call.catch(() => {})
      if (nouls) chosen = decideModel(nouls)
    } catch {
      chosen = null // 不記錄 headers／key
    } finally {
      abort.abort()
      next.signal.removeEventListener('abort', onStop)
    }

    $.ui.status(statusText(chosen, e.model))
    return chosen ? next({ ...e, model: chosen }) : next(e)
  }).catch(($, e, next) => next(e))
}
