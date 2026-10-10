import { test, expect } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 5, columns: 80 } as never

for (const [name, percent, shown] of [['70% 以下不出現', 69, false], ['70% 起出現', 70, true]] as const) {
  test(`交接按鈕：${name}`, async ($, on) => {
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, percent }, rateLimits: [] } }) as never)
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'handoff-button', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect((await ui.find({ key: 'handoff' })) !== undefined).toBe(shown)
    await ui.unmount()
  })
}
