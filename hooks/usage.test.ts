import { expect, test } from 'claude-code/testing'

import type { Sync } from '../types'
import { DEFAULT_PREFS, EMPTY_VIEW, asPrefs, blockReason, gaugeSvg, level, otherText, pace, plan, prune, rateFrom, sampleOf, sparkline, summarize } from './usage'
import { parseGist, pcName, sharesFor } from './sync'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const MIN = 60_000
const resetsAt = new Date(NOW + 2 * 60 * MIN).toISOString() // window began 3h ago
const P = { ...DEFAULT_PREFS, share: 70 }
const status = (over: Partial<Sync['pcs'][string]> = {}) => ({ t: NOW - 60 * MIN, busy: false, updated: NOW - MIN, mine: 0, resetsAt, samples: [], ...over })
const synced = (other: Partial<Sync['pcs'][string]>, shares = { A: 70, B: 30 }): Sync => ({
  me: 'A',
  error: null,
  at: NOW - MIN,
  shares,
  pcs: { A: status(), B: status(other) },
})

test('own usage: cost × rate, last 15 min, line over the window', async () => {
  const log = [
    { t: NOW - 60 * MIN, tok: 1000, out: 10, pct: 20, usd: 2 },
    { t: NOW - 10 * MIN, tok: 3000, out: 30, pct: 34, usd: 1 },
    { t: NOW - 2 * MIN, tok: 4000, out: 40, pct: 37, usd: 0.5 },
  ]
  const v = summarize(log, { pct: 37, resetsAt, week: 23 }, NOW, 1.25, 2)
  expect(v.mine).toBe(7)
  expect(v.mine15).toBe(3)
  expect(v.tokens15).toBe(7000)
  expect(v.week).toBe(23)
  expect(v.points.at(-1)).toEqual([0.6, 7])
  // no rate yet: the rise seen during the turn stands in
  expect(summarize([{ t: NOW - MIN, tok: 1, out: 1, pct: 5, d: 1.5, usd: 9 }], { pct: 5, resetsAt }, NOW).mine).toBe(1.5)
})

test('a window that already reset reads 0%', async () => {
  const old = new Date(NOW - MIN).toISOString()
  const v = summarize([{ t: NOW - 6 * 60 * MIN, tok: 5, out: 1, pct: 90, usd: 9 }], { pct: 90, resetsAt: old }, NOW, null, 2)
  expect(v.pct).toBe(0)
  expect(v.mine).toBe(0)
})

test('shares: 70 here means 30 there; this PC stops at its own share', async () => {
  expect(sharesFor('A', 70, ['B'])).toEqual({ A: 70, B: 30 })
  const v = { ...EMPTY_VIEW, pct: 40, resetsAt, mine: 30 }
  const s = synced({ t: NOW - 5 * MIN, mine: 10 })
  const pl = plan(v, P, s, NOW)
  expect(pl.share).toBe(70)
  expect(pl.cap).toBe(70)
  expect(pl.left).toBe(40)
  expect(pl.isLending).toBe(false)
  expect(pl.others[0]).toEqual({ name: 'B', share: 30, mine: 10, isWorking: false, isOnline: true, seenMs: MIN, idleMs: 5 * MIN })
  // at its share: stopped, even though the account has room
  expect(blockReason({ ...v, mine: 70 }, P, plan({ ...v, mine: 70 }, P, s, NOW), NOW)).toContain('its 70% share')
  // the synced share wins over the local setting
  expect(plan(v, P, synced({}, { A: 60, B: 40 }), NOW).share).toBe(60)
})

test('working now, idle, lending', async () => {
  const v = { ...EMPTY_VIEW, pct: 50, resetsAt, mine: 45 }
  // other PC working: no lending
  const working = plan(v, P, synced({ busy: true, updated: NOW - MIN, t: NOW - 40 * MIN }), NOW)
  expect(working.others[0]!.isWorking).toBe(true)
  expect(working.isLending).toBe(false)
  // a "working" flag 10 min old is stale: that PC closed mid-turn
  expect(plan(v, P, synced({ busy: true, updated: NOW - 10 * MIN, t: NOW - 40 * MIN }), NOW).others[0]!.isWorking).toBe(false)
  // idle 40 min with 5% used: this PC may go to 95%
  const lend = plan({ ...v, mine: 75 }, P, synced({ t: NOW - 40 * MIN, mine: 5 }), NOW)
  expect(lend.isLending).toBe(true)
  expect(lend.cap).toBe(95)
  expect(lend.left).toBe(20) // the account's room (100 - 80... pct 50) vs cap 95-75 = 20
  // idle only 10 min: no lending yet
  expect(plan(v, P, synced({ t: NOW - 10 * MIN }), NOW).isLending).toBe(false)
})

test('other PC: working, online, offline; one failed check keeps the last state', async () => {
  const v = { ...EMPTY_VIEW, pct: 20, resetsAt, mine: 5 }
  const say = (s: Sync) => otherText(plan(v, P, s, NOW), s, NOW)
  expect(say(synced({ busy: true, updated: NOW - MIN })).value).toBe('● working')
  expect(say(synced({ updated: NOW - 2 * MIN, t: NOW - 12 * MIN }))).toEqual({ value: '● online', sub: 'idle 12m · 0% of 30%' })
  expect(say(synced({ updated: NOW - 90 * MIN, t: NOW - 95 * MIN }))).toEqual({ value: 'offline', sub: 'lending to you'.replace(/^/, 'idle 1h 35m · '), tone: 'warning' })
  expect(say(synced({ updated: NOW - 20 * MIN, t: NOW - 20 * MIN })).sub).toBe('seen 20m ago · 0% of 30%')
  // a failed check 1 min after a good read still shows the other PC
  expect(say({ ...synced({ busy: true }), error: 'GitHub not reachable' }).value).toBe('● working')
})

test('not synced: local share, no lending', async () => {
  const v = { ...EMPTY_VIEW, pct: 50, resetsAt, mine: 20 }
  const offline: Sync = { ...synced({ t: NOW - 3 * 60 * MIN }), error: 'GitHub not reachable', at: 0 }
  const pl = plan(v, P, offline, NOW)
  expect(pl.synced).toBe(false)
  expect(pl.isLending).toBe(false)
  expect(pl.cap).toBe(70)
  // stale sync data counts as not synced
  expect(plan(v, P, { ...synced({}), at: NOW - 20 * MIN }, NOW).synced).toBe(false)
})

test('pace, warning level', async () => {
  const s = synced({ t: NOW - 5 * MIN })
  const v = { ...EMPTY_VIEW, pct: 40, resetsAt, mine: 50, mine15: 5 }
  const pl = plan(v, P, s, NOW)
  expect(pace(v, pl, NOW)).toEqual({ text: 'stop in ~1h 0m', isSoon: false })
  expect(pace({ ...v, mine15: 1 }, pl, NOW).text).toBe('safe until reset')
  expect(pace(EMPTY_VIEW, plan(EMPTY_VIEW, P, s, NOW), NOW).text).toBe('waiting for first reply')
  expect(level({ ...v, mine: 55 }, plan({ ...v, mine: 55 }, P, s, NOW))).toBe(0)
  expect(level({ ...v, mine: 56 }, plan({ ...v, mine: 56 }, P, s, NOW))).toBe(1)
  expect(level({ ...v, mine: 70 }, plan({ ...v, mine: 70 }, P, s, NOW))).toBe(2)
})

test('rate: median of samples; whole-% readings need a 1% rise', async () => {
  expect(rateFrom([])).toBe(null)
  expect(rateFrom([4, 1, 3, 2, 10])).toBe(3)
  expect(rateFrom([2, 4])).toBe(3)
  expect(sampleOf(0.5, 1)).toBe(null)
  expect(sampleOf(2, 1)).toBe(2)
})

test('gist files: bad content is ignored, names are made safe', async () => {
  const g = parseGist({
    'shares.json': { content: JSON.stringify({ shares: { A: 70, B: 30, C: 500 } }) },
    'pc-A.json': { content: JSON.stringify({ t: 5, busy: true, updated: 6, mine: 12.5, resetsAt, samples: [2, -1, 'x'] }) },
    'pc-B.json': { content: 'not json' },
    'notes.txt': { content: 'hi' },
  })
  expect(g.shares).toEqual({ A: 70, B: 30 })
  expect(Object.keys(g.pcs)).toEqual(['A'])
  expect(g.pcs.A!.samples).toEqual([2])
  expect(pcName(' DESKTOP 7/Q \n')).toBe('DESKTOP-7-Q')
})

test('stored prefs: the old limit carries over as the share', async () => {
  expect(asPrefs(undefined)).toEqual(DEFAULT_PREFS)
  expect(asPrefs({ limit: 70, split: true }).share).toBe(70)
  expect(asPrefs({ share: 'x', onePass: 'yes' })).toEqual(DEFAULT_PREFS)
  expect(prune([{ t: NOW - 6 * 60 * MIN, tok: 1, out: 1, pct: 1 }], NOW)).toEqual([])
})

test('drawing: own ring, share line, sparkline', async () => {
  const s = synced({ busy: true, updated: NOW - MIN })
  const empty = gaugeSvg(EMPTY_VIEW, plan(EMPTY_VIEW, P, s, NOW), s, NOW)
  expect(empty).not.toContain('class="k ')
  expect(empty).toContain('● working')
  const v = summarize([{ t: NOW - 30 * MIN, tok: 1, out: 1, pct: 50, usd: 40 }], { pct: 70, resetsAt, week: 40 }, NOW, null, 2)
  const full = gaugeSvg(v, plan(v, P, s, NOW), s, NOW)
  expect(full).toContain('class="k error"')
  expect(full).toContain('>80%</text>')
  expect(full).toContain('<polyline')
  expect(sparkline([[0, 0], [0.5, 50], [1, 100]], 4)).toBe('▁▄▄█')
})
