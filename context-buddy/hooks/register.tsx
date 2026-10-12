import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BuddyVerdict, HandoffPhase } from '../types'

// 每個「收尾段落且 context >= 此值」都詢問一次小模型（詢問中不重入）
const ASK_FROM_PERCENT = 50
const MODEL = 'haiku'
const MAX_ANSWER_CHARS = 800
const MAX_TIP_CHARS = 30
const BUTTON_FALLBACK_PERCENT = 75
const DIR = '.claude/handoffs'
const BUTTON_KEY = 'buddy-handoff'

const percent = atom({ plugin: 'context-buddy', key: 'percent' } as const, 0)
const tick = atom({ plugin: 'context-buddy', key: 'tick' } as const, 0)
const wrapUp = atom({ plugin: 'context-buddy', key: 'wrapUp' } as const, false)
const verdict = atom({ plugin: 'context-buddy', key: 'verdict' } as const, null as BuddyVerdict | null)
const phase = atom({ plugin: 'context-buddy', key: 'phase' } as const, 'idle' as HandoffPhase)
// 小模型詢問進行中：此時 verdict 尚未回來，不可套用後備規則顯示按鈕
const asking = atom({ plugin: 'context-buddy', key: 'asking' } as const, false)

export const REQUEST = (path: string) => `請為這段對話寫一份「交接摘要」，讓全新的對話可以無縫接手；只放必要的 context，不要流水帳。
- 你的最終回覆只放摘要本身（繁體中文 Markdown），不要前言、不要結語，也不要呼叫寫檔工具；我會自行存到 ${path}。
- 需要確認改過哪些檔案時，可以先用唯讀指令（如 git status、git diff --stat），不要修改任何東西。
- 依序包含這七個章節，沒有內容就寫「無」：
## 目前的目標
## 做完了什麼
## 還沒做的
## 改過哪些檔案
## 要注意的地方
## 可參考的檔案
## 建議的下一步`

export const OPENING = (path: string, summary: string) => `以下是上一段對話的交接摘要（已存於 ${path}），請依此接續工作，先簡述你的理解再繼續：

${summary}`

/** 按鈕顯示條件（不含主執行緒／isWorking／hasSurvey／phase，那些在渲染處判斷） */
export function shouldOfferButton(args: { verdict: BuddyVerdict | null; wrapUp: boolean; pct: number; asking: boolean }): boolean {
  if (args.verdict !== null) return args.verdict.restart
  if (args.asking) return false
  return args.wrapUp && args.pct >= BUTTON_FALLBACK_PERCENT
}

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

/** 收尾段落（呼叫端已確認）且 context 達門檻就詢問 */
export function shouldAsk(pct: number): boolean {
  return pct >= ASK_FROM_PERCENT
}

export function buildPrompt(answer: string, pct: number): string {
  const tail = answer.length > MAX_ANSWER_CHARS ? answer.slice(-MAX_ANSWER_CHARS) : answer
  return `你是 context 管理助手。判斷使用者在這一段落結束後，是否該清空對話或開新 session。
準則：請根據答覆中提到的「下一步／待辦」，判斷下一份工作與目前脈絡是否相關。
- 下一份工作與目前脈絡高度相關，且 context 還不高：restart=false。
- 下一份工作是新主題、新模組（與目前脈絡不相關），或 context 已很高（約 75% 以上）：restart=true。
- 答覆未提及下一步／待辦時，無法判斷相關性：以 context 使用量為主，約 70% 以上傾向 true，否則 false。
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

/** 把所有跨 turn 的 atom 狀態歸零；單項失敗不影響其餘（session.end 只有很短的時限） */
async function resetAtoms($: EngineInterface) {
  try {
    if ((await read($, phase)) !== 'idle') await update($, phase, () => 'idle')
  } catch {
    /* 忽略 */
  }
  try {
    if ((await read($, asking)) !== false) await update($, asking, () => false)
  } catch {
    /* 忽略 */
  }
  try {
    await clearVerdict($)
  } catch {
    /* 忽略 */
  }
  try {
    if ((await read($, wrapUp)) !== false) await update($, wrapUp, () => false)
  } catch {
    /* 忽略 */
  }
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

// 下層（其他外掛的 AbovePrompt）真的有畫東西才算；空 Box 或沒東西都視為無
const isTree = (v: unknown): v is { type: string } => {
  if (typeof v !== 'object' || v === null) return false
  const { type, children } = v as { type?: unknown; children?: unknown }
  if (typeof type !== 'string') return false
  return type !== 'Box' || (Array.isArray(children) && children.length > 0)
}

async function failBack($: EngineInterface, path: string, summary: string, isSaved: boolean) {
  try {
    await update($, phase, () => 'idle')
  } catch {
    /* 忽略 */
  }
  try {
    await $.prompt.fill({ text: OPENING(path, summary) })
  } catch {
    /* fill 也失敗：只剩 toast 與已存檔的摘要 */
  }
  try {
    $.ui.toast(
      isSaved
        ? `自動清空失敗：摘要已存到 ${path}，並放進輸入框；請手動 /clear 後送出`
        : '存檔失敗：摘要已放進輸入框；請手動 /clear 後送出',
    )
  } catch {
    /* 忽略 */
  }
}

/** 存檔 → 之後（hook 返回後 detached）/clear → 送出接續工作 prompt；任何一步失敗退回 fill + toast */
async function handoff($: EngineInterface, path: string, summary: string) {
  let isSaved = true
  try {
    await $.fs.write(path, summary + '\n')
  } catch {
    isSaved = false
  }
  try {
    await update($, phase, () => 'clearing')
  } catch {
    /* phase 只影響顯示；後續流程照走 */
  }

  // `command.run` is refused inside a hook the turn waits on, so it runs after this one returns.
  void (async () => {
    try {
      if (!isSaved) throw new Error('save failed')
      await $.clock.sleep(300)
      await $.command.run({ command: 'clear' })
      await $.prompt.submit({ text: OPENING(path, summary) })
      await update($, phase, () => 'idle')
    } catch {
      await failBack($, path, summary, isSaved)
    }
  })()
}

export const register: Register = on => {
  let pendingPath: string | null = null
  let isAsking = false
  // 按鈕按下後、pendingPath 設定前的同步旗標，擋住連按（第一個 await 之前就要設）
  let isStarting = false
  // 世代：session 重啟或新一個 turn.complete 就 +1；詢問發出時記錄，回來不符就丟棄
  let generation = 0
  // 重置次數：只在 session 邊界 +1；舊詢問收尾時據此判斷是否還能動 isAsking／asking
  let epoch = 0

  // session 邊界（/clear、resume、熱重載後第一次 start）：atom 會跨熱重載保留、閉包變數不會，
  // 所以一律全部重置，不依賴 pendingPath。
  function resetLocal() {
    generation += 1
    epoch += 1
    pendingPath = null
    isAsking = false
  }

  on('session.start', async ($, e, next) => {
    resetLocal()
    await resetAtoms($)
    await pull($)
    return next(e)
  })

  // /clear 只觸發 session.end{reason:'clear'}、不觸發 session.start。整條鏈共用一個很短的時限，
  // 所以只做幾個 atom 寫入。detached 交接流程自己呼叫的 /clear 也會走到這裡：此時 phase 為
  // 'clearing'，重置成 idle 無害（OPENING 的 prompt.submit 不看 phase，之後 update(phase,'idle') 冪等）。
  on('session.end', async ($, e, next) => {
    resetLocal()
    await resetAtoms($)
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

    if (pendingPath !== null) {
      // 這一輪是交接摘要（或它失敗了）：處理完直接結束，不做段落判斷與詢問
      const path = pendingPath
      pendingPath = null
      const summary = e.reason === 'answer' ? e.answer.trim() : ''
      if (summary === '') {
        await update($, phase, () => 'idle')
        try {
          $.ui.toast('交接已中止：這一輪沒有產出摘要')
        } catch {
          /* toast 失敗不影響後續 */
        }
      } else {
        await handoff($, path, summary)
      }
      if ((await read($, wrapUp)) !== false) await update($, wrapUp, () => false)
      await pull($)
      return next(e)
    }

    await pull($)
    await update($, tick, n => n + 1)
    const done = isWrapUp(e)
    let ask: { answer: string; pct: number; epoch: number } | null = null
    if (done) {
      const pct = await read($, percent)
      if (!isAsking && shouldAsk(pct)) {
        isAsking = true
        ask = { answer: e.answer, pct, epoch }
        // asking 要在 wrapUp 之前（或同批）寫入，避免 verdict=null / asking=false / wrapUp=true 的過渡態讓按鈕閃現
        await update($, asking, () => true)
      }
    }
    if ((await read($, wrapUp)) !== done) await update($, wrapUp, () => done)

    if (ask !== null) {
      const { answer, pct, epoch: myEpoch } = ask
      // 不擋住這一輪的收尾；結果回來再寫入 atom
      void (async () => {
        try {
          const v = await askModel($, answer, pct)
          if (v !== null && generation === myGeneration) await update($, verdict, () => v)
        } catch {
          /* 退回本地規則 */
        } finally {
          // session 已重置過的話，旗標與 atom 都已由重置處理，不要動到新一輪的詢問
          if (epoch === myEpoch) {
            isAsking = false
            try {
              await update($, asking, () => false)
            } catch {
              /* 忽略 */
            }
          }
        }
      })()
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [pct, n, done, v, ph, isAsk] = await Promise.all([
      read($, percent),
      read($, tick),
      read($, wrapUp),
      read($, verdict),
      read($, phase),
      read($, asking),
    ])
    const { Box, Button, Text } = $.ui.resolve(e)

    const below = await next(e)
    const hasBelow = isTree(below)
    const maxRows = e.props.maxRows
    const budget = hasBelow ? maxRows - 1 : maxRows
    if (budget < 1) return below

    const working = e.props.isWorking
    const offer = ph === 'idle' && !working && shouldOfferButton({ verdict: v, wrapUp: done, pct, asking: isAsk })

    let text: string
    if (ph !== 'idle') text = ph === 'writing' ? '交接：正在寫摘要…' : '交接：清空對話中…'
    else if (working) text = '工作中…'
    else text = bubbleText({ pct, tick: n, wrapUp: done, verdict: v })
    const face = working || ph !== 'idle' ? 'ʕ•ᴥ•ʔ…' : pct >= 75 ? 'ʕ>ᴥ<ʔ' : pct >= 60 ? 'ʕ•ᴥ•ʔ' : 'ʕᵔᴥᵔʔ'

    const line = (
      <Text key="buddy-line" wrap="truncate-end">
        {face} 💬 {text}
      </Text>
    )
    const rows = [
      offer ? (
        <Box key="buddy-row">
          {line}
          <Text>{'　'}</Text>
          <Button
            key={BUTTON_KEY}
            label="換新 session"
            onPress={async () => {
              // 同步 guard：第一個 await 之前就設旗標，連按時第二次直接返回
              if (pendingPath !== null || isStarting) return
              isStarting = true
              try {
                if ((await read($, phase)) !== 'idle') return
                const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').slice(0, 15)
                const path = `${await $.session.cwd()}/${DIR}/handoff-${stamp}.md`
                pendingPath = path
                await update($, phase, () => 'writing')
                await $.prompt.submit({ text: REQUEST(path) })
              } catch {
                pendingPath = null
                try {
                  await update($, phase, () => 'idle')
                  $.ui.toast('交接失敗：無法送出摘要請求')
                } catch {
                  /* 忽略 */
                }
              } finally {
                isStarting = false
              }
            }}
          />
        </Box>
      ) : (
        line
      ),
    ]
    if (budget >= 2 && !working && ph === 'idle') {
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
