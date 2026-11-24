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
 * `hostname`, and a fake git: `files` is the sync repo on GitHub, `local` this PC's clone of it.
 */
function engine(on: Parameters<TestBody>[1], o: { pct: number; stored?: Record<string, unknown>; files?: Files; offline?: boolean; flaky?: boolean }) {
  const store = new Map<string, unknown>(Object.entries(o.stored ?? {}))
  const files: Files = { 'README.md': '# sync', ...(o.files ?? {}) }
  let local: Files | null = null
  // Files outside the clone (the lock), by full path.
  const outside: Files = {}
  let calls = 0
  const net = { writesDown: false }
  const resetsAt = new Date(Date.now() + 3600_000).toISOString()
  const base = (path: string) => path.split('/').pop()!
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.list', () => ({ value: Object.keys(local ?? {}).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('.lock')) return e.path in outside ? { value: outside[e.path]! } : { deny: 'ENOENT' }
    return { value: (local ?? {})[base(e.path)] ?? '' }
  })
  on('fs.write', (_, e) => {
    if (e.path.endsWith('.lock')) outside[e.path] = e.text
    else if (local) local[base(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const down = () => out('', 128, 'fatal: unable to access: Connection timed out')
    const argv = e.argv.filter(a => !a.startsWith('credential.helper') && a !== '-c')
    if (argv[0] === 'hostname') return out('PCA\n')
    if (argv[0] !== 'git') return out('', 1)
    const args = argv[1] === '-C' ? argv.slice(3) : argv.slice(1)
    const cmd = args.join(' ')
    const isNetwork = /^(clone|fetch|push)/.test(cmd)
    // A flaky network: two of every three network calls never connect.
    if (isNetwork && (o.offline || (o.flaky && ++calls % 3 !== 0))) return o.offline ? out('', 128, 'fatal: could not read Username for https://github.com') : down()
    if (cmd === 'remote get-url origin') return out('https://github.com/Ranitayer/usage-guard.git\n')
    if (cmd === 'pull --ff-only') return out('Already up to date.')
    if (cmd.startsWith('rev-parse')) return local ? out('true') : out('', 128)
    if (cmd.startsWith('clone')) return (local = { ...files }), out('')
    if (cmd.startsWith('config') || cmd.startsWith('add') || cmd.startsWith('commit') || cmd.startsWith('fetch')) return out('')
    if (cmd.startsWith('reset')) return (local = { ...files }), out('')
    if (cmd.startsWith('diff')) return out('', JSON.stringify(local) === JSON.stringify(files) ? 0 : 1)
    if (cmd.startsWith('push')) {
      if (net.writesDown) return down()
      Object.assign(files, local)
      return out('')
    }
    return out('', 1)
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
  on('session.repo', () => ({ value: { root: '/home/me/code/my-app', remote: null, internal: false, name: 'my-app' } }))
  on('session.cwd', () => ({ value: '/home/me/code/my-app' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { store, files, net, outside }
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

test("first sync claims this PC's share in the sync repo", async ($, on) => {
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

test('a flaky network: git calls are retried, and the next sync recovers what one missed', async ($, on) => {
  engine(on, { pct: 10, flaky: true, stored: { prefs: { share: 70 } }, files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({ busy: true }) } })
  await startSynced($)
  const said = await syncNow($)
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(said.text).toContain('PCB')
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('● working')
  await term.unmount()
})

test('a limit change GitHub missed is sent again on the next sync', async ($, on) => {
  const g = engine(on, { pct: 10, stored: { prefs: { share: 75 } }, files: { 'shares.json': JSON.stringify({ shares: { PCA: 75, PCB: 25 } }), 'pc-PCB.json': otherPc({}) } })
  await startSynced($)
  // GitHub takes no writes: the change to 80 stays unsaved, but this PC keeps showing it.
  g.net.writesDown = true
  await $.command.run({ command: 'usage-share', args: '80', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(JSON.parse(g.files['shares.json']!).shares.PCA).toBe(75)
  expect((g.store.get('pendingShare') as { share: number }).share).toBe(80)
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /^80%$/ }))?.text).toBe('80%')
  await desk.unmount()
  // GitHub is back: the next sync saves it.
  g.net.writesDown = false
  await syncNow($)
  expect(JSON.parse(g.files['shares.json']!).shares).toEqual({ PCA: 80, PCB: 20 })
  expect(JSON.parse(g.files['shares.json']!).by).toBe('PCA')
  expect(g.store.get('pendingShare')).toBe(undefined)
})

test('the History pane shows projects, both PCs per day, and hours', async ($, on) => {
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const hours = Array<number>(24).fill(0)
  hours[today.getHours()] = 6
  engine(on, {
    pct: 20,
    stored: { prefs: { share: 70 }, samples: [2], days: { [key]: { pct: 6, hours } }, log: [{ t: Date.now() - 10 * MIN, tok: 1, out: 1, pct: 20, usd: 3, proj: 'my-app' }] },
    files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({ days: { [key]: 4 } }) },
  })
  await startSynced($)
  await $.command.run({ command: 'usage-history', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const pane = { plugin: 'usage-guard', component: 'Pane', requestId: 'usage-history', props: { title: 'Usage history', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
  const desk = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(JSON.stringify(await desk.find({ type: 'Svg' }))).toContain('my-app 6%')
  await desk.unmount()
  const term = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /my-app/ }))?.text).toContain('6%')
  expect((await term.find({ type: 'Text', text: /PCB/ }))?.text).toBeDefined()
  await term.unmount()
})

test('an old limit kept by another session never overwrites a newer one; every session follows GitHub', async ($, on) => {
  const now = Date.now()
  const g = engine(on, {
    pct: 10,
    // This session started with 70 and has an unsent change to 90 from 10 minutes ago...
    stored: { prefs: { share: 70 }, pendingShare: { share: 90, at: now - 10 * MIN } },
    // ...but 65 was set 1 minute ago (by another session or the other PC).
    files: { 'shares.json': JSON.stringify({ shares: { PCA: 65, PCB: 35 }, at: now - MIN, by: 'PCA' }), 'pc-PCB.json': otherPc({}) },
  })
  await startSynced($)
  expect(JSON.parse(g.files['shares.json']!).shares).toEqual({ PCA: 65, PCB: 35 })
  expect(g.store.get('pendingShare')).toBe(undefined)
  expect((g.store.get('prefs') as { share: number }).share).toBe(65)
})

test('another session on this PC syncing right now: skipped, not shown as an error', async ($, on) => {
  const g = engine(on, { pct: 10, stored: { prefs: { share: 70 } }, files: { 'shares.json': JSON.stringify({ shares: { PCA: 70, PCB: 30 } }), 'pc-PCB.json': otherPc({ busy: true }) } })
  await startSynced($)
  g.outside['/home/me/.claude/usage-guard-sync.lock'] = JSON.stringify({ owner: 'someone-else', t: Date.now() })
  const said = await syncNow($)
  expect(said.text).not.toContain('Not synced')
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Other PC/ }))?.text).toContain('● working')
  await term.unmount()
})
