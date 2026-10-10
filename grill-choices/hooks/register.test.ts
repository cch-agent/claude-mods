import { test, expect } from 'claude-code/testing'

test('grill-with-docs 與其呼叫的 grilling 都被附加 AskUserQuestion 指示', async ($, on) => {
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const a = await $.skill.prompt({ skill: 'grill-with-docs', text: 'base' })
  expect(a.text).toContain('AskUserQuestion')
  const b = await $.skill.prompt({ skill: 'grilling', text: 'g' })
  expect(b.text).toContain('AskUserQuestion')
  const c = await $.skill.prompt({ skill: 'grilling', text: 'g' })
  expect(c.text).toBe('g')
})

test('單獨的 grill-me / grilling 不受影響', async ($, on) => {
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const r = await $.skill.prompt({ skill: 'grilling', text: 'g' })
  expect(r.text).toBe('g')
})
