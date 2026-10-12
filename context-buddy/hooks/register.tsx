import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BuddyVerdict } from '../types'

const ASK_FROM_PERCENT = 50
const ASK_EVERY_SEGMENTS = 3
const HANDOFF_HINT_PERCENT = 70
const MODEL = 'haiku'
const MAX_ANSWER_CHARS = 800
const MAX_TIP_CHARS = 30

const percent = atom({ plugin: 'context-buddy', key: 'percent' } as const, 0)
const tick = atom({ plugin: 'context-buddy', key: 'tick' } as const, 0)
const wrapUp = atom({ plugin: 'context-buddy', key: 'wrapUp' } as const, false)
const verdict = atom({ plugin: 'context-buddy', key: 'verdict' } as const, null as BuddyVerdict | null)

// ---------- 純函式（可單測） ----------

export type Level = 0 | 1 | 2 | 3

export function levelOf(pct: number): Level {
  if (pct >= 75) return 3
  if (pct >= 60) return 2
  if (pct >= 40) return 1
  return 0
}

export const LINES: Record<Level, readonly string[]> = {
  0: ['一切順利，慢慢來。', '我在這裡陪你。', '空間很充裕，放心聊。'],
  1: ['進度過半了，記得留意範圍。', '已經聊了不少，可以想想收斂方向。', 'context 用掉一些了，別離題太遠。'],
  2: ['快滿了，這段做完就收尾吧。', '建議在這個段落結束後整理成交接。', 'context 偏高，別再開新題目了。'],
  3: ['已經很滿了，建議開新 session。', '再聊下去容易遺忘細節，換個新對話吧。', '請收尾並開新 session。'],
}

/** 確定性輪替：同一 (level, tick) 永遠同一句 */
export function lineFor(level: Level, n: number): string {
  const pool = LINES[level]
  return pool[((n % pool.length) + pool.length) % pool.length]
}

// 待辦語氣優先：只要出現就不算收尾（即使同時有「已完成」）
const OPEN_RE = /接下來|下一步|待辦|還需要|還要|尚未|未完成|沒完成|還沒|要不要|是否要|需要我|請問|要我|[?？]\s*$|\bTODO\b|\bnext steps?\b|\bwould you like\b/i
// 否定待辦（「沒有待辦」「無下一步」）不算待辦語氣
const NO_OPEN_RE = /沒有\s*(待辦|下一步|後續|未完成)|無\s*(待辦|下一步|後續|未完成)|\bno (todos?|next steps?)\b/gi

/** 「可結束的段落」：答覆結束且沒有待辦語氣 */
export function isWrapUp(e: { reason: string; answer: string }): boolean {
  if (e.reason !== 'answer') return false
  const text = e.answer.trim()
  if (text === '') return false
  return !OPEN_RE.test(text.replace(NO_OPEN_RE, ''))
}

export function shouldAsk(pct: number, segmentsSinceAsk: number): boolean {
  return pct >= ASK_FROM_PERCENT && segmentsSinceAsk >= ASK_EVERY_SEGMENTS
}

export function buildPrompt(answer: string, pct: number): string {
  const tail = answer.length > MAX_ANSWER_CHARS ? answer.slice(-MAX_ANSWER_CHARS) : answer
  return `你是 context 管理助手。判斷使用者在這一段落結束後，是否該清空對話或開新 session。
準則：下一個任務若與目前脈絡高度相關，就不建議重開；若是新主題、新模組，或 context 已很高，就建議重開。
目前 context 使用量：${Math.round(pct)}%
最後一則答覆（節錄）：
"""
${tail}
"""
只輸出嚴格 JSON，不要任何其他文字：{"restart": true或false, "tip": "30字內中文提示"}`
}

/** 解析模型回傳；壞資料回 null */
export function parseVerdict(text: unknown): BuddyVerdict | null {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { restart, tip } = raw as { restart?: unknown; tip?: unknown }
  if (typeof restart !== 'boolean' || typeof tip !== 'string') return null
  const clean = tip.replace(/\s+/g, ' ').trim()
  if (clean === '') return null
  return { restart, tip: Array.from(clean).slice(0, MAX_TIP_CHARS).join('') }
}

export function bubbleText(args: { pct: number; tick: number; wrapUp: boolean; verdict: BuddyVerdict | null }): string {
  const { pct, wrapUp: done, verdict: v } = args
  if (v !== null) return v.restart ? `${v.tip}（建議 /clear 或開新 session）` : v.tip
  const level = levelOf(pct)
  if (level === 2 && done) return '這段告一段落了，適合現在收尾。'
  if (level === 3 && done) return '段落已結束，建議現在開新 session。'
  return lineFor(level, args.tick)
}

// ---------- 引擎面 ----------

async function setPercent($: EngineInterface, pct: number) {
  const value = Math.round(pct)
  if ((await read($, percent)) !== value) await update($, percent, () => value)
}

async function clearVerdict($: EngineInterface) {
  if ((await read($, verdict)) !== null) await update($, verdict, () => null)
}

async function refresh($: EngineInterface, pct: number) {
  await setPercent($, pct)
  if (Math.round(pct) < 40) await clearVerdict($)
}

async function pull($: EngineInterface) {
  try {
    const { context } = await $.session.usage()
    await refresh($, context.percent ?? 0)
  } catch {
    /* 取不到就維持原值 */
  }
}

async function askModel($: EngineInterface, answer: string, pct: number): Promise<BuddyVerdict | null> {
  try {
    const r = await $.model.complete({
      model: MODEL,
      prompt: buildPrompt(answer, pct),
      effort: 'low',
      maxTokens: 200,
      timeoutMs: 20000,
    })
    if (!r.isAnswered) return null
    return parseVerdict(r.text)
  } catch {
    return null
  }
}

// 下層（例如 handoff-button）真的有畫東西才算；空 Box 或沒東西都視為無
const isTree = (v: unknown): v is { type: string } => {
  if (typeof v !== 'object' || v === null) return false
  const { type, children } = v as { type?: unknown; children?: unknown }
  if (typeof type !== 'string') return false
  return type !== 'Box' || (Array.isArray(children) && children.length > 0)
}

/** 下層樹裡是否有指定 key 的元素（key 可能在節點上或 props 上） */
export function hasKey(tree: unknown, key: string, depth = 0): boolean {
  if (depth > 20 || typeof tree !== 'object' || tree === null) return false
  if (Array.isArray(tree)) return tree.some(c => hasKey(c, key, depth + 1))
  const node = tree as { key?: unknown; props?: { key?: unknown; children?: unknown }; children?: unknown }
  if (node.key === key || node.props?.key === key) return true
  return hasKey(node.children, key, depth + 1) || hasKey(node.props?.children, key, depth + 1)
}

export const register: Register = on => {
  let segmentsSinceAsk = ASK_EVERY_SEGMENTS // 第一個符合條件的段落即可詢問
  let isAsking = false
  // 世代：session 重啟或新一個 turn.complete 就 +1；詢問發出時記錄，回來不符就丟棄
  let generation = 0

  on('session.start', async ($, e, next) => {
    generation += 1
    await clearVerdict($)
    await pull($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e.context.percent ?? 0)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    // verdict 只對發出詢問的那個段落有效：新段落一開始就作廢
    generation += 1
    const myGeneration = generation
    await clearVerdict($)

    await pull($)
    await update($, tick, n => n + 1)
    const done = isWrapUp(e)
    if ((await read($, wrapUp)) !== done) await update($, wrapUp, () => done)

    if (done) {
      segmentsSinceAsk += 1
      const pct = await read($, percent)
      if (!isAsking && shouldAsk(pct, segmentsSinceAsk)) {
        isAsking = true
        segmentsSinceAsk = 0
        const answer = e.answer
        // 不擋住這一輪的收尾；結果回來再寫入 atom
        void (async () => {
          try {
            const v = await askModel($, answer, pct)
            if (v !== null && generation === myGeneration) await update($, verdict, () => v)
          } catch {
            /* 退回本地規則 */
          } finally {
            isAsking = false
          }
        })()
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [pct, n, done, v] = await Promise.all([read($, percent), read($, tick), read($, wrapUp), read($, verdict)])
    const { Box, Text } = $.ui.resolve(e)

    const below = await next(e)
    const hasBelow = isTree(below)
    const maxRows = e.props.maxRows
    const budget = hasBelow ? maxRows - 1 : maxRows
    if (budget < 1) return below

    const working = e.props.isWorking
    let text = working ? '工作中…' : bubbleText({ pct, tick: n, wrapUp: done, verdict: v })
    if (!working && hasBelow && pct >= HANDOFF_HINT_PERCENT && hasKey(below, 'handoff')) text += '　可按『交接』'
    const face = working ? 'ʕ•ᴥ•ʔ…' : pct >= 75 ? 'ʕ>ᴥ<ʔ' : pct >= 60 ? 'ʕ•ᴥ•ʔ' : 'ʕᵔᴥᵔʔ'

    const rows = [
      <Text key="buddy-line" wrap="truncate-end">
        {face} 💬 {text}
      </Text>,
    ]
    if (budget >= 2 && !working) {
      rows.push(
        <Text key="buddy-meter" dimColor wrap="truncate-end">
          {'　'}context {pct}%
        </Text>,
      )
    }

    const buddy = <Box flexDirection="column">{rows}</Box>
    if (!hasBelow) return buddy
    return (
      <Box flexDirection="column">
        {below}
        {buddy}
      </Box>
    )
  })
}
