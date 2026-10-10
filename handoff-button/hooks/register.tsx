import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffPhase } from '../types'

const THRESHOLD = 70
const DIR = '.claude/handoffs'

const percent = atom({ plugin: 'handoff-button', key: 'percent' } as const, 0)
const phase = atom({ plugin: 'handoff-button', key: 'phase' } as const, 'idle' as HandoffPhase)

const REQUEST = (path: string) => `請為這段對話寫一份「交接摘要」，讓全新的對話可以無縫接手。
- 你的最終回覆只放摘要本身（Markdown），不要前言、不要結語，也不要呼叫寫檔工具；我會自行存到 ${path}。
- 需要確認改過哪些檔案時，可以先用唯讀指令（如 git status、git diff --stat），不要修改任何東西。
- 依序包含這六個章節，沒有內容就寫「無」：
## 目前的目標
## 做完了什麼
## 還沒做的
## 改過哪些檔案
## 要注意的地方
## 可參考的檔案`

const OPENING = (path: string, summary: string) => `以下是上一段對話的交接摘要（已存於 ${path}），請依此接續工作，先簡述你的理解再繼續：

${summary}`

async function refresh($: EngineInterface) {
  const { context } = await $.session.usage()
  await update($, percent, () => Math.round(context.percent ?? 0))
}

export const register: Register = on => {
  let pendingPath: string | null = null

  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    if (pendingPath !== null && e.reason === 'answer' && e.answer.trim() !== '') {
      const path = pendingPath
      const summary = e.answer.trim()
      pendingPath = null
      await $.fs.write(path, summary + '\n')
      await update($, phase, () => 'clearing')

      // `command.run` is refused inside a hook the turn waits on, so it runs after this one returns.
      void (async () => {
        try {
          await $.clock.sleep(300)
          await $.command.run({ command: 'clear' })
          await $.prompt.submit({ text: OPENING(path, summary) })
          await update($, phase, () => 'idle')
        } catch {
          await update($, phase, () => 'idle')
          await $.prompt.fill({ text: OPENING(path, summary) })
          $.ui.toast(`自動清空失敗：摘要已存到 ${path}，並放進輸入框；請手動 /clear 後送出`)
        }
      })()
    } else if (pendingPath !== null) {
      pendingPath = null
      await update($, phase, () => 'idle')
      $.ui.toast('交接已中止：這一輪沒有產出摘要')
    }

    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [pct, current] = [await read($, percent), await read($, phase)]
    if (e.props.hasSurvey || (current === 'idle' && pct < THRESHOLD)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (current !== 'idle') {
      return (
        <Box>
          <Text dimColor>{current === 'writing' ? '交接：正在寫摘要…' : '交接：清空對話中…'}</Text>
        </Box>
      )
    }

    return (
      <Box>
        <Text dimColor>context 已用 {pct}%　</Text>
        <Button
          key="handoff"
          label="交接"
          isDisabled={e.props.isWorking}
          onPress={async () => {
            const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').slice(0, 15)
            const path = `${await $.session.cwd()}/${DIR}/handoff-${stamp}.md`
            pendingPath = path
            await update($, phase, () => 'writing')
            await $.prompt.submit({ text: REQUEST(path) })
          }}
        />
      </Box>
    )
  })
}
