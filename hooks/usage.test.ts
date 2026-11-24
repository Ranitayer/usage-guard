import { expect, test } from 'claude-code/testing'

import { DEFAULT_PREFS, EMPTY_VIEW, asPrefs, blockReason, gaugeSvg, level, pace, prune, rateFrom, room, sampleOf, sparkline, split, summarize } from './usage'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const MIN = 60_000
const resetsAt = new Date(NOW + 2 * 60 * MIN).toISOString() // window began 3h ago
const P = DEFAULT_PREFS // limit 60, no share

test('15-minute usage, this PC share, week and graph points', async () => {
  const log = [
    { t: NOW - 60 * MIN, tok: 1000, out: 10, pct: 20, d: 5 },
    { t: NOW - 20 * MIN, tok: 2000, out: 20, pct: 30, d: 2.5 },
    { t: NOW - 10 * MIN, tok: 3000, out: 30, pct: 34 },
    { t: NOW - 2 * MIN, tok: 4000, out: 40, pct: 37.5, d: 1 },
  ]
  const v = summarize(log, { pct: 37.5, resetsAt, week: 23 }, NOW, 1.234)
  expect(v.pct).toBe(37.5)
  expect(v.pct15).toBe(7.5)
  expect(v.tokens15).toBe(7000)
  expect(v.out15).toBe(70)
  expect(v.tokensWindow).toBe(10000)
  expect(v.mine).toBe(8.5)
  expect(v.week).toBe(23)
  expect(v.cost).toBe(1.234)
  expect(v.points[0]).toEqual([0, 0])
  expect(v.points.at(-1)).toEqual([0.6, 37.5])
})

test('a window that already reset reads 0% and drops older turns', async () => {
  const old = new Date(NOW - MIN).toISOString()
  const v = summarize([{ t: NOW - 6 * 60 * MIN, tok: 5, out: 1, pct: 90, d: 9 }], { pct: 90, resetsAt: old }, NOW)
  expect(v.pct).toBe(0)
  expect(v.tokensWindow).toBe(0)
  expect(v.mine).toBe(0)
})

test('pace forecast', async () => {
  const v = { ...EMPTY_VIEW, pct: 40, resetsAt, pct15: 5 }
  // 20% left at 5% per 15 min = 60 min, before the reset in 2h
  expect(pace(v, P, NOW)).toEqual({ text: 'stop in ~1h 0m', isSoon: false })
  expect(pace({ ...v, pct15: 10 }, P, NOW).isSoon).toBe(true)
  expect(pace({ ...v, pct15: 1 }, P, NOW).text).toBe('safe until reset')
  expect(pace({ ...v, pct15: 0 }, P, NOW).text).toBe('no use in 15 min')
  expect(pace(EMPTY_VIEW, P, NOW).text).toBe('waiting for first reply')
})

test('blocking: account limit, snooze; warning levels', async () => {
  const v = { ...EMPTY_VIEW, pct: 61, resetsAt }
  expect(blockReason(v, P, NOW)).toContain('61%')
  expect(blockReason(v, { ...P, snoozeUntil: NOW + MIN }, NOW)).toBe(null)
  expect(level({ ...v, pct: 47 }, P)).toBe(0)
  expect(level({ ...v, pct: 48 }, P)).toBe(1)
  expect(level({ ...v, pct: 60 }, P)).toBe(2)
})

test('split: idle other use gives the full limit; busy splits by work, 20..80', async () => {
  const v = { ...EMPTY_VIEW, pct: 30, resetsAt, mine: 25, mine30: 3 }
  expect(split({ ...v, other30: 0.2 }, P)).toEqual({ weight: 1, isOtherBusy: false })
  expect(split({ ...v, other30: 1 }, P).weight).toBe(0.75)
  expect(split({ ...v, other30: 30 }, P).weight).toBe(0.2)
  expect(split({ ...v, mine30: 30, other30: 1 }, P).weight).toBe(0.8)
  expect(split({ ...v, other30: 30 }, { ...P, split: false }).weight).toBe(1)
  // other busy, this PC's part is 12% of 60 and it used 25: stopped though the account is at 30
  expect(room({ ...v, other30: 30 }, P)).toEqual({ left: 0, cap: 12, isPartTighter: true })
  expect(blockReason({ ...v, other30: 30 }, P, NOW)).toContain("this PC's part is 12%")
  // other idle: only the account limit counts
  expect(room({ ...v, other30: 0 }, P).left).toBe(30)
})

test('rate: lower quartile of samples; tiny turns give none', async () => {
  expect(rateFrom([])).toBe(null)
  expect(rateFrom([4, 1, 3, 2, 10])).toBe(2)
  expect(sampleOf(0.2, 1)).toBe(null)
  expect(sampleOf(1, 0.5)).toBe(2)
})

test('cost-based mine, other use spread over the gap', async () => {
  // This PC: two turns 3h ago costing $2 each at 2%/$ = 8%. Then idle; account went 8 -> 28 over 2h50m while away.
  const log = [
    { t: NOW - 180 * MIN, tok: 1, out: 1, pct: 4, usd: 2 },
    { t: NOW - 175 * MIN, tok: 1, out: 1, pct: 8, usd: 2 },
    { t: NOW - 5 * MIN, tok: 1, out: 1, pct: 29, usd: 0.5 },
  ]
  const v = summarize(log, { pct: 29, resetsAt }, NOW, null, 2)
  expect(v.mine).toBe(9)
  expect(v.mine30).toBe(1)
  // 20% of other use over 170 min, 25 of them in the last 30 min
  expect(v.other30).toBe(2.9)
  expect(v.isCalibrated).toBe(true)
  // Uncalibrated, the turn's seen rise (d) stands in
  expect(summarize([{ t: NOW - MIN, tok: 1, out: 1, pct: 5, d: 1.5, usd: 9 }], { pct: 5, resetsAt }, NOW).mine).toBe(1.5)
})

test('stored prefs: bad values fall back, the old limit key carries over', async () => {
  expect(asPrefs(undefined)).toEqual(DEFAULT_PREFS)
  expect(asPrefs(undefined, 45).limit).toBe(45)
  expect(asPrefs({ limit: 'x', onePass: 'yes' })).toEqual(DEFAULT_PREFS)
  expect(asPrefs({ limit: 80, split: false }).split).toBe(false)
  expect(prune([{ t: NOW - 6 * 60 * MIN, tok: 1, out: 1, pct: 1 }], NOW)).toEqual([])
})

test('drawing: rings, limit line, usage line, sparkline', async () => {
  const empty = gaugeSvg(EMPTY_VIEW, P, NOW)
  expect(empty).not.toContain('class="k ')
  expect(empty).not.toContain('<polyline')
  const v = summarize([{ t: NOW - 30 * MIN, tok: 1, out: 1, pct: 50 }], { pct: 70, resetsAt, week: 40 }, NOW)
  const full = gaugeSvg(v, P, NOW)
  expect(full).toContain('class="k error"')
  expect(full).toContain('class="k wk"')
  expect(full).toContain('<polyline')
  expect(full).toContain('>0%</text>') // nothing left before stop
  expect(sparkline([[0, 0], [0.5, 50], [1, 100]], 4)).toBe('▁▄▄█')
})
