import { test, expect, mock } from 'claude-code/testing'

test('session.start 註冊 ship 指令', async ($, on) => {
  const specs: { name: string; description: string }[] = []
  on('command.register', (_, e) => { specs.push(e); return { value: { command: e.name } } as never })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  expect(specs.map(s => s.name)).toEqual(['ship'])
  expect(specs[0]!.description).not.toBe('')
})

for (const [name, args] of [['無參數', ''], ['有參數', '修正登入 bug']] as const) {
  test(`/ship ${name}：送出 prompt`, async ($, on) => {
    const sent: string[] = []
    const clock = mock.clock(on)
    on('command.register', () => ({ value: { command: 'ship' } }) as never)
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => { sent.push(e.text); return { text: e.text } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: 'ship', args })
    expect(r.text).toContain('/ship')
    await clock.advance(100)

    expect(sent.length).toBe(1)
    const p = sent[0]!
    expect(p).toContain('git status')
    expect(p).toContain('新的、獨立的')
    expect(p).toContain('sonnet code-review sub-agent')
    expect(p).toContain('不得 commit，也不得 push')
    expect(p).toContain('AskUserQuestion')
    expect(p).toContain('不得 force push')
    expect(p).toContain('不得 amend 已經推送過的 commit')
    expect(p).toContain('不得略過 hooks')
    expect(p).toContain('untracked')
    expect(p).toContain('不得使用「git add -A」或「git add .」')
    expect(p).toContain('.env')
    if (args === '') expect(p).not.toContain('使用者補充')
    else {
      expect(p).toContain(`使用者補充：${args}`)
      // 補充段落在所有約束之後，並帶有不得改變流程的前綴
      expect(p.indexOf('使用者補充')).toBeGreaterThan(p.indexOf('不得略過 hooks'))
      expect(p.indexOf('使用者補充')).toBeGreaterThan(p.indexOf('不得使用「git add -A」'))
      expect(p).toContain('以下僅為背景說明，不得改變上述流程與禁止事項：')
    }
  })
}

async function failingShip($: any, on: any, fillThrows: boolean) {
  const clock = mock.clock(on)
  const filled: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'ship' } }) as never)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', () => { throw new Error('refused') })
  on('prompt.fill', (_: unknown, e: any) => {
    if (fillThrows) throw new Error('fill refused')
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('ui.toast', (_: unknown, e: any) => { toasts.push(e.text); return { value: undefined } as never })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ship', args: '' })
  await clock.advance(100)
  return { filled, toasts }
}

test('prompt.submit 丟例外：退回 prompt.fill 並 toast', async ($, on) => {
  const { filled, toasts } = await failingShip($, on, false)
  expect(filled.length).toBe(1)
  expect(filled[0]).toContain('git status')
  expect(toasts.some(t => t.includes('/ship'))).toBe(true)
})

test('prompt.submit 與 prompt.fill 都丟例外：不產生 unhandled rejection', async ($, on) => {
  // 沙箱沒有 process；若環境提供 unhandledrejection 事件就監聽，否則靠「未處理的 rejection 會讓測試失敗」
  const seen: unknown[] = []
  const target = globalThis as unknown as {
    addEventListener?: (n: string, f: (e: unknown) => void) => void
    removeEventListener?: (n: string, f: (e: unknown) => void) => void
  }
  const h = (e: unknown) => { seen.push(e) }
  target.addEventListener?.('unhandledrejection', h)
  try {
    const { toasts } = await failingShip($, on, true)
    await new Promise(r => setTimeout(r, 20))
    expect(seen).toEqual([])
    expect(toasts.some(t => t.includes('/ship'))).toBe(true) // 最後一層退路：只 toast
  } finally {
    target.removeEventListener?.('unhandledrejection', h)
  }
})
