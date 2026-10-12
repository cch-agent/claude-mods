import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chip } from '../types'
import { extract, fallbackLabel, parseLabels, type Candidate } from './extract'

const chips = atom({ plugin: 'action-chips', key: 'chips' } as const, [] as Chip[])

const MAX_CHIPS = 12

// 下層真的有畫東西才算；空 Box 或沒東西都視為無（與 context-buddy 相同判斷）
const isTree = (v: unknown): v is { type: string } => {
  if (typeof v !== 'object' || v === null) return false
  const { type, children } = v as { type?: unknown; children?: unknown }
  if (typeof type !== 'string') return false
  return type !== 'Box' || (Array.isArray(children) && children.length > 0)
}
const EXEC_RE = /\.(app|command|sh|bash|zsh|tool|terminal|workflow|scpt|applescript|pkg|dmg)\/?$/i

async function resolvePath($: EngineInterface, p: string, cwd: string): Promise<string | undefined> {
  let abs = p
  if (p.startsWith('~/')) {
    const home = await $.env.get('HOME')
    if (!home) return undefined
    abs = home + p.slice(1)
  }
  else if (!p.startsWith('/')) abs = cwd.replace(/\/$/, '') + '/' + p.replace(/^\.\//, '')
  try {
    const st = await $.fs.stat(abs)
    return st.kind === 'other' ? undefined : abs
  } catch {
    return undefined
  }
}

async function label($: EngineInterface, answer: string, items: Chip[]): Promise<string[] | undefined> {
  const list = items
    .map((c, i) => `${i + 1}. ${c.kind === 'copy' ? '指令' : '開啟'}：${c.target.slice(0, 300)}`)
    .join('\n')
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 400,
    timeoutMs: 4000, // 等標籤時 turn 尚未結束，逾時就用備用標籤
    effort: 'low',
    system:
      '你替對話中的檔案、網址與指令取極短的按鈕標籤，說明它「是什麼／做什麼」，不要寫檔名或路徑。' +
      '語言跟隨回覆（中文回覆就用繁體中文），每個標籤 2–8 個字或 1–3 個英文字，例如：web demo、mobile demo、配色比較頁、部署指令、進度紀錄。' +
      '只輸出一個 JSON 字串陣列，順序與數量和清單相同。',
    prompt: `回覆內容：\n${answer.slice(0, 6000)}\n\n清單：\n${list}`,
  })
  return r.isAnswered ? parseLabels(r.text, items.length) : undefined
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.isAborted) {
      await update($, chips, () => [])
      return result
    }

    const cwd = await $.session.cwd()
    const found: Chip[] = []
    for (const c of extract(e.answer) as Candidate[]) {
      if (found.length >= MAX_CHIPS) break
      let target = c.target
      if (c.isPath) {
        const abs = await resolvePath($, c.target, cwd)
        if (!abs) continue
        target = abs
      }
      if (found.some(f => f.kind === c.kind && f.target === target)) continue
      found.push({ kind: c.kind, target, label: fallbackLabel({ kind: c.kind, target }) })
    }

    // 先換上備用標籤（或清空），再請 haiku 補上描述性標籤
    await update($, chips, () => found)
    if (found.length > 0) {
      const labels = await label($, e.answer, found)
      if (labels) {
        await update($, chips, cur =>
          cur === undefined || cur.length !== found.length || cur.some((c, i) => c.target !== found[i]?.target)
            ? (cur ?? [])
            : cur.map((c, i) => ({ ...c, label: labels[i] || c.label })),
        )
      }
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // 下層（例如 context-buddy）照樣畫，小框框疊在它上面
    const below = await next(e)
    const list = e.props.isWorking ? [] : await read($, chips)
    if (list.length === 0) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const row = (
      <Box key="action-chips" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {list.map((c, i) => (
          <Button
            key={`chip-${i}`}
            onPress={async press => {
              if (c.kind === 'copy') {
                const r = await $.ui.copy({ text: c.target, surface: press.surface })
                $.ui.toast(r.isCopied ? `已複製：${c.label}` : '複製失敗')
              } else {
                // 可執行的檔案只在 Finder 顯示，不直接執行
                const argv = !c.target.startsWith('http') && EXEC_RE.test(c.target) ? ['open', '-R', c.target] : ['open', c.target]
                try {
                  const r = await $.process.run(argv)
                  if (r.exitCode !== 0) $.ui.toast(`無法開啟：${c.label}`)
                } catch {
                  $.ui.toast(`無法開啟：${c.label}`)
                }
              }
            }}
          >
            <Text dimColor>{c.kind === 'copy' ? '⧉ ' : '↗ '}</Text>
            {c.label}
          </Button>
        ))}
      </Box>
    )
    if (!isTree(below)) return row
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
