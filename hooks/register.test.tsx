import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-guard',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PROMPT = { text: 'hello', wait: false, origin: { kind: 'composer' } } as const

// Stands in for the engine: an in-memory $.store, the clock, and a 5-hour / 7-day reading.
function engine(on: Parameters<TestBody>[1], pct: number, stored: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(stored))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: pct, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 23 },
      ],
      cost: { usd: 1.5 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  return store
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('under the limit: the prompt goes through and the band shows the figures', async ($, on) => {
  engine(on, 42)
  await $.session.start(start)
  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Left before stop/ }))?.text).toContain('18%')
  expect((await term.find({ type: 'Text', text: /week/ }))?.text).toContain('23%')
  expect((await term.find({ type: 'Text', text: /Session cost/ }))?.text).toContain('$1.50')
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await desk.find({ type: 'Svg' }))).toContain('5-hour usage 42% (limit 60%), week 23%')
  expect(await desk.find({ type: 'Button', key: 'once' })).toBe(undefined)
  await desk.unmount()
})

test('at the limit: stopped, then "Let 1 through" lets exactly one prompt pass', async ($, on) => {
  engine(on, 61)
  await $.session.start(start)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('61%')

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desk.press({ key: 'once' })
  await desk.unmount()

  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('61%')
})

test('snooze lets prompts through; the old limit setting carries over', async ($, on) => {
  engine(on, 50, { limit: 45 })
  await $.session.start(start)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('limit 45%')

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desk.press({ key: 'snooze' })
  await desk.unmount()

  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
})

test('other use busy: this PC stops at its part, under the account limit', async ($, on) => {
  const now = Date.now()
  // This PC: $10 at 2%/$ = 20% earlier; the account rose 20 -> 40 in the last 20 min without it.
  const log = [
    { t: now - 60 * 60_000, tok: 1, out: 1, pct: 20, usd: 10 },
    { t: now - 60_000, tok: 1, out: 1, pct: 40, usd: 0 },
  ]
  engine(on, 40, { log, samples: [2, 2, 2] })
  await $.session.start(start)
  expect((await $.prompt.submit(PROMPT)).drop).toContain("this PC's part is 12%")
})
