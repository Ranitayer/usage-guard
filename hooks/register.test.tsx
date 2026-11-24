import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-guard',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PROMPT = { text: 'hello', wait: false, origin: { kind: 'composer' } } as const
const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const MIN = 60_000

type Files = Record<string, string>

/**
 * Stands in for the engine and GitHub: an in-memory $.store, the clock, a 5-hour reading,
 * `hostname` and `gh auth token`, and a fake gist API holding `files`.
 */
function engine(on: Parameters<TestBody>[1], o: { pct: number; stored?: Record<string, unknown>; files?: Files; offline?: boolean; flaky?: boolean }) {
  let calls = 0
  const store = new Map<string, unknown>(Object.entries(o.stored ?? {}))
  const files: Files = { ...(o.files ?? {}) }
  const hasGist = { v: o.files !== undefined }
  const resetsAt = new Date(Date.now() + 3600_000).toISOString()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: undefined }))
  // Never fires: GitHub's timeout race is won by the fetch.
  on('clock.after', () => new Promise<never>(() => {}))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'hostname') return out('PCA\n')
    if (e.argv[0] === 'gh') return o.offline ? out('', 1) : out('test-token\n')
    return out('', 1)
  })
  on('http.fetch', (_, e) => {
    // A flaky network: two of every three requests never connect.
    if (o.flaky && ++calls % 3 !== 0) throw new Error('connect timeout')
    const reply = (body: unknown, status = 200) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })
    const method = e.init?.method ?? 'GET'
    if (e.url.endsWith('/gists?per_page=100')) return reply(hasGist.v ? [{ id: 'g1', description: 'usage-guard sync', created_at: '2026-01-01' }] : [])
    if (e.url.endsWith('/gists') && method === 'POST') {
      hasGist.v = true
      const body = JSON.parse(String(e.init?.body)) as { files: Record<string, { content: string }> }
      for (const [n, f] of Object.entries(body.files)) files[n] = f.content
      return reply({ id: 'g1' }, 201)
    }
    if (e.url.endsWith('/gists/g1') && method === 'PATCH') {
      const body = JSON.parse(String(e.init?.body)) as { files: Record<string, { content: string }> }
      for (const [n, f] of Object.entries(body.files)) files[n] = f.content
      return reply({ id: 'g1' })
    }
    if (e.url.endsWith('/gists/g1')) return reply({ files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, { content: c }])) })
    return reply({}, 404)
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: o.pct, resetsAt },
        { kind: 'seven_day', percentUsed: 23 },
      ],
      cost: { usd: 1.5 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { store, files }
}

const resetsAt = () => new Date(Date.now() + 3600_000).toISOString()
const otherPc = (over: Record<string, unknown>) =>
  JSON.stringify({ t: Date.now() - 5 * MIN, busy: false, updated: Date.now() - MIN, mine: 0, resetsAt: resetsAt(), samples: [], ...over })

// `/usage-share` waits for a full sync, so it settles what the session start began in the background.
const syncNow = ($: Parameters<TestBody>[0]) =>
  $.command.run({ command: 'usage-share', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

async function startSynced($: Parameters<TestBody>[0]) {
  await $.session.start(start)
  await syncNow($)
}

test('synced: the other PC working shows, shares add up to 100, the prompt goes through', async ($, on) => {
  const g = engine(on, {
    pct: 40,
    // This PC: $10 at 2%/$ = 20% of the window so far.
    stored: { prefs: { share: 70 }, samples: [2, 2, 2], log: [{ t: Date.now() - 30 * MIN, tok: 1, out: 1, pct: 30, usd: 10 }] },
    files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({ busy: true, mine: 12 }) },
  })
  await startSynced($)
  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
  await syncNow($)
  // This PC told the gist it is working.
  expect(JSON.parse(g.files['pc-PCA.json']!).busy).toBe(true)

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('● working')
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('12% of 30%')
  expect((await term.find({ type: 'Text', text: /Left before stop/ }))?.text).toContain('50%')
  expect((await term.find({ type: 'Text', text: /Account/ }))?.text).toContain('40%')
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await desk.find({ type: 'Svg' }))).toContain('This PC used 20% of the 5-hour window (may use 70%)')
  expect((await desk.find({ type: 'Text', text: /Limit/ }))?.text).toBe('Limit')
  await desk.unmount()
})

test("lowering the share here raises the other PC's in the gist", async ($, on) => {
  const g = engine(on, { pct: 10, stored: { prefs: { share: 70 } }, files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({}) } })
  await startSynced($)
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desk.press({ key: 'down' })
  await desk.unmount()
  expect(JSON.parse(g.files['shares.json']!).shares).toEqual({ PCA: 65, PCB: 35 })
})

test('at its share: stopped; "Let 1 through" lets exactly one prompt pass', async ($, on) => {
  engine(on, {
    pct: 50,
    stored: { prefs: { share: 30 }, samples: [2], log: [{ t: Date.now() - 20 * MIN, tok: 1, out: 1, pct: 45, usd: 16 }] },
    files: { 'shares.json': JSON.stringify({ shares: { PCA: 30, PCB: 70 } }), 'pc-PCB.json': otherPc({ busy: true }) },
  })
  await startSynced($)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('its 30% share')

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desk.press({ key: 'once' })
  await desk.unmount()
  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('its 30% share')
})

test('the other PC idle for 40 minutes lends its share', async ($, on) => {
  engine(on, {
    pct: 50,
    stored: { prefs: { share: 30 }, samples: [2], log: [{ t: Date.now() - 20 * MIN, tok: 1, out: 1, pct: 45, usd: 20 }] },
    files: { 'shares.json': JSON.stringify({ shares: { PCA: 30, PCB: 70 } }), 'pc-PCB.json': otherPc({ t: Date.now() - 40 * MIN, mine: 10 }) },
  })
  await startSynced($)
  // 40% used, over its 30% share, but the other PC is idle: it may go to 90%.
  expect((await $.prompt.submit(PROMPT)).drop).toBe(undefined)
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('lending to you')
  await term.unmount()
})

test("first sync creates the gist and claims this PC's share", async ($, on) => {
  const g = engine(on, { pct: 5, stored: { prefs: { share: 60 } } })
  await startSynced($)
  expect(JSON.parse(g.files['shares.json']!).shares).toEqual({ PCA: 60 })
  expect(g.files['pc-PCA.json']).toBeDefined()
})

test('GitHub unavailable: "not synced", the local share still stops this PC', async ($, on) => {
  engine(on, { pct: 50, offline: true, stored: { prefs: { share: 30 }, samples: [2], log: [{ t: Date.now() - 20 * MIN, tok: 1, out: 1, pct: 45, usd: 16 }] } })
  await startSynced($)
  expect((await $.prompt.submit(PROMPT)).drop).toContain('its 30% share')
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('not synced')
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('gh auth login')
  await term.unmount()
})

test('a flaky network: each GitHub call is retried, and the other PC still shows', async ($, on) => {
  engine(on, { pct: 10, flaky: true, stored: { prefs: { share: 70 } }, files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({ busy: true }) } })
  await startSynced($)
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('● working')
  await term.unmount()
})
