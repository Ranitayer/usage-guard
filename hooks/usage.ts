import type { Prefs, View } from '../types'

/**
 * One finished turn on this PC: when, its tokens, the 5-hour % right after it,
 * what it cost (usd, main turns only), and the % rise seen during it (d, used until the PC is calibrated).
 */
export type Entry = { t: number; tok: number; out: number; pct: number | null; d?: number; usd?: number }
/** The last readings the API gave. */
export type Reading = { pct: number; resetsAt: string | null; week?: number | null }

export const FIVE_HOURS = 5 * 3600_000
export const SLICE = 15 * 60_000
export const RECENT = 30 * 60_000
export const SNOOZE = 15 * 60_000
/** Below this % in the last 30 minutes, other use counts as idle. */
export const IDLE = 0.5
/** While both sides work, neither gets less than this part of the limit, nor more than 1 minus it. */
export const FLOOR = 0.2

export const EMPTY_VIEW: View = {
  pct: null,
  resetsAt: null,
  week: null,
  pct15: 0,
  tokens15: 0,
  out15: 0,
  tokensWindow: 0,
  mine: 0,
  mine30: 0,
  other30: 0,
  isCalibrated: false,
  points: [],
  cost: null,
}
export const DEFAULT_PREFS: Prefs = { limit: 60, split: true, snoozeUntil: 0, onePass: false }

// $.store hands back unknown JSON: keep only well-formed values.
export const asEntries = (v: unknown): Entry[] =>
  Array.isArray(v) ? v.filter((x): x is Entry => typeof x?.t === 'number' && typeof x?.tok === 'number') : []

export const asReading = (v: unknown): Reading | null =>
  typeof (v as Reading)?.pct === 'number' ? (v as Reading) : null

export const asSamples = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0 && Number.isFinite(x)) : []

const isPct = (v: unknown): v is number => typeof v === 'number' && v >= 1 && v <= 100

/** Stored prefs, or the old single `limit` key from version 0.1. */
export function asPrefs(v: unknown, oldLimit?: unknown): Prefs {
  const p = (v ?? {}) as Partial<Prefs>
  return {
    limit: isPct(p.limit) ? p.limit : isPct(oldLimit) ? oldLimit : DEFAULT_PREFS.limit,
    split: p.split !== false,
    snoozeUntil: typeof p.snoozeUntil === 'number' ? p.snoozeUntil : 0,
    onePass: p.onePass === true,
  }
}

/** Drops entries older than one 5-hour window. */
export const prune = (log: Entry[], now: number) => log.filter(e => e.t >= now - FIVE_HOURS)

/**
 * % of the 5-hour window per dollar of this PC's usage, from turns measured first reply to last.
 * The lower quartile, since a turn that overlapped other use reads high.
 * shortcut: one rate for every model; if usage weights models differently than API prices do, the split drifts by that much.
 */
export function rateFrom(samples: number[]): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 4)] ?? null
}

/** A turn's rate sample, or null when the turn was too small to read through the 0.1% rounding. */
export const sampleOf = (dPct: number, dUsd: number) => (dPct >= 0.3 && dUsd >= 0.2 ? dPct / dUsd : null)

const round1 = (n: number) => Math.round(n * 10) / 10

export function summarize(log: Entry[], reading: Reading | null, now: number, cost: number | null = null, rate: number | null = null): View {
  const resetMs = reading?.resetsAt ? Date.parse(reading.resetsAt) : NaN
  const isExpired = Number.isFinite(resetMs) && resetMs <= now
  // A window that has reset since the last reading is at 0 until the API says otherwise.
  const pct = reading === null ? null : isExpired ? 0 : reading.pct
  const resetsAt = reading === null || isExpired ? null : reading.resetsAt
  const windowStart = Number.isFinite(resetMs) && !isExpired ? resetMs - FIVE_HOURS : now - FIVE_HOURS
  const inWindow = log.filter(e => e.t >= windowStart && e.t <= now)
  const since = (ms: number) => Math.max(now - ms, windowStart)

  // The account's rise since a moment: from the last reading before it (0 if the window began after it).
  const riseSince = (ms: number) => {
    const start = since(ms)
    const before = inWindow.filter(e => e.t < start && e.pct !== null).at(-1)
    const base = start === windowStart ? 0 : (before?.pct ?? inWindow.find(e => e.t >= start && e.pct !== null)?.pct ?? null)
    return pct !== null && base !== null ? Math.max(0, round1(pct - base)) : 0
  }

  // This PC's own % per turn: cost × rate once calibrated, else the rise seen during the turn.
  const own = (e: Entry) => (rate !== null && e.usd !== undefined ? e.usd * rate : (e.d ?? 0))

  // Other use between two of this PC's readings is the rise this PC did not cause, spread evenly over that gap,
  // so a PC back from idle does not count hours of the other side's work as the last few minutes.
  let other30 = 0
  const recentStart = since(RECENT)
  let prev: { t: number; pct: number } = { t: windowStart, pct: 0 }
  for (const e of inWindow) {
    if (e.pct === null) continue
    const rise = e.pct - prev.pct - own(e)
    const overlap = Math.max(0, e.t - Math.max(prev.t, recentStart))
    if (rise > 0 && e.t > prev.t) other30 += (rise * overlap) / (e.t - prev.t)
    prev = { t: e.t, pct: e.pct }
  }

  const recent15 = inWindow.filter(e => e.t >= since(SLICE))
  const points: [number, number][] = [[0, 0]]
  // shortcut: readings come only from this PC's turns, so the line is straight across stretches this PC sat idle.
  for (const e of inWindow) if (e.pct !== null) points.push([(e.t - windowStart) / FIVE_HOURS, e.pct])
  if (pct !== null) points.push([Math.min(1, (now - windowStart) / FIVE_HOURS), pct])

  return {
    pct,
    resetsAt,
    week: reading?.week ?? null,
    pct15: riseSince(SLICE),
    tokens15: recent15.reduce((n, e) => n + e.tok, 0),
    out15: recent15.reduce((n, e) => n + e.out, 0),
    tokensWindow: inWindow.reduce((n, e) => n + e.tok, 0),
    mine: round1(inWindow.reduce((n, e) => n + own(e), 0)),
    mine30: round1(inWindow.filter(e => e.t >= recentStart).reduce((n, e) => n + own(e), 0)),
    other30: round1(other30),
    isCalibrated: rate !== null,
    points: points.slice(-120),
    cost,
  }
}

/** This PC's part of the limit (0..1) by recent work, and whether other use is active. */
export function split(v: View, p: Prefs): { weight: number; isOtherBusy: boolean } {
  if (!p.split || v.other30 < IDLE) return { weight: 1, isOtherBusy: false }
  const total = v.mine30 + v.other30
  return { weight: Math.min(1 - FLOOR, Math.max(FLOOR, v.mine30 / total)), isOtherBusy: true }
}

/** % this PC may still use: the account's room or this PC's part of the limit, whichever is less. */
export function room(v: View, p: Prefs): { left: number | null; cap: number; isPartTighter: boolean } {
  const cap = round1(p.limit * split(v, p).weight)
  if (v.pct === null) return { left: null, cap, isPartTighter: false }
  const account = p.limit - v.pct
  const part = cap - v.mine
  return { left: Math.max(0, round1(Math.min(account, part))), cap, isPartTighter: part < account }
}

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

export const fmtDur = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
}

export const resetsIn = (iso: string | null, now: number) => (iso === null ? '' : `resets in ${fmtDur(Date.parse(iso) - now)}`)

/** How much of what this PC may use is used, 0..1. */
export function used(v: View, p: Prefs): number {
  const { left } = room(v, p)
  if (left === null) return 0
  return Math.min(1, Math.max(0, 1 - left / p.limit))
}

/** 0 under, 1 past 80%, 2 at the stop. */
export function level(v: View, p: Prefs): 0 | 1 | 2 {
  const { left } = room(v, p)
  if (left === null) return 0
  return left <= 0 ? 2 : left <= p.limit * 0.2 ? 1 : 0
}

/** Why a prompt is stopped now, or null. Snooze lets everything through; one-pass is the caller's. */
export function blockReason(v: View, p: Prefs, now: number): string | null {
  if (now < p.snoozeUntil) return null
  const { left, cap, isPartTighter } = room(v, p)
  if (left === null || left > 0) return null
  const reset = v.resetsAt ? `, ${resetsIn(v.resetsAt, now)}` : ''
  if (isPartTighter) return `Stopped: other use is busy too, so this PC's part is ${cap}% of the ${p.limit}% limit and it has used ${v.mine}%${reset}.`
  return `Stopped: you're at ${v.pct}% of your 5-hour usage (limit ${p.limit}%${reset}).`
}

/** "stop in ~1h 20m" at the last 15 minutes' pace, or why there is no forecast. */
export function pace(v: View, p: Prefs, now: number): { text: string; isSoon: boolean } {
  const { left } = room(v, p)
  if (left === null) return { text: 'waiting for first reply', isSoon: false }
  if (left <= 0) return { text: v.resetsAt ? resetsIn(v.resetsAt, now) : 'limit reached', isSoon: true }
  if (v.pct15 <= 0) return { text: 'no use in 15 min', isSoon: false }
  const ms = (left / v.pct15) * SLICE
  if (v.resetsAt && now + ms >= Date.parse(v.resetsAt)) return { text: 'safe until reset', isSoon: false }
  return { text: `stop in ~${fmtDur(ms)}`, isSoon: ms < 3600_000 }
}

export const toneOf = (frac: number) => (frac >= 1 ? 'error' : frac >= 0.8 ? 'warning' : 'success')

type Col = { label: string; value: string; sub: string; tone?: 'success' | 'warning' | 'error' }

/** The text the rings and columns say, shared by the SVG and the terminal row. */
export function figures(v: View, p: Prefs, now: number) {
  const { left } = room(v, p)
  const { weight, isOtherBusy } = split(v, p)
  const forecast = pace(v, p, now)
  const mine = Math.round(weight * 100)
  const splitText = !p.split ? 'split off' : isOtherBusy ? `split ${mine}/${100 - mine}` : 'other idle · full'
  const cols: Col[] = [
    { label: 'Left before stop', value: left === null ? '—' : `${left}%`, sub: forecast.text, tone: toneOf(used(v, p)) },
    { label: 'Last 15 min', value: `+${v.pct15}%`, sub: `${fmtTokens(v.tokens15)} tok · ${fmtTokens(v.out15)} out` },
    { label: v.isCalibrated ? 'This PC' : 'This PC · learning', value: `${v.mine}%`, sub: splitText },
    { label: 'Session cost', value: v.cost === null ? '—' : `$${v.cost.toFixed(2)}`, sub: `${fmtTokens(v.tokensWindow)} tokens / 5h` },
  ]
  return {
    center: v.pct === null ? '—' : `${v.pct}%`,
    week: v.week === null ? '—' : `${Math.round(v.week)}%`,
    reset: v.resetsAt ? resetsIn(v.resetsAt, now) : '',
    isSoon: forecast.isSoon,
    cols,
  }
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif`
// The image cannot read the app's theme, so it follows the system's (as ponytail's band does).
const STYLE = `.k{fill:none!important}.l,.s{fill:#87867f;font:12px ${FONT}}.cw{fill:#87867f;font:600 10px ${FONT}}.v,.c{fill:#1f1e1d;font:600 17px ${FONT}}.c{font-size:15px}.t,.d{stroke:#1f1e1d;stroke-opacity:.12}.g{fill:none;stroke:#87867f;stroke-width:1.5}.lim{stroke:#c62828;stroke-opacity:.6;stroke-dasharray:3 3}.success{fill:#2e7d32;stroke:#2e7d32}.warning{fill:#a86400;stroke:#a86400}.error{fill:#c62828;stroke:#c62828}.wk{stroke:#6a5acd}@media (prefers-color-scheme:dark){.v,.c{fill:#ecebe6}.t,.d{stroke:#fff;stroke-opacity:.14}.g{stroke:#b5b3aa}.lim{stroke:#ef6a5a}.success{fill:#6abf69;stroke:#6abf69}.warning{fill:#e3a03d;stroke:#e3a03d}.error{fill:#ef6a5a;stroke:#ef6a5a}.wk{stroke:#9d8cff}}`

const ring = (cx: number, cy: number, r: number, w: number, frac: number, cls: string) => {
  const circ = 2 * Math.PI * r
  let s = `<circle class="t" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${w}"/>`
  if (frac > 0) {
    s += `<circle class="k ${cls}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${(Math.min(1, frac) * circ).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
  }
  return s
}

/** The 5-hour ring, the weekly ring, four stat columns and the window's usage line, as one SVG. */
export const GAUGE_W = 860
export const GAUGE_H = 76

export function gaugeSvg(v: View, p: Prefs, now: number, width = GAUGE_W): string {
  const h = GAUGE_H
  const f = figures(v, p, now)
  const frac = used(v, p)
  const tone = toneOf(frac)

  let body = ring(38, 38, 30, 7, frac, tone)
  body += `<text class="c" x="38" y="44" text-anchor="middle">${f.center}</text>`
  body += ring(104, 32, 17, 5, (v.week ?? 0) / 100, 'wk')
  body += `<text class="cw" x="104" y="36" text-anchor="middle">${f.week}</text>`
  body += `<text class="s" x="104" y="68" text-anchor="middle">week</text>`

  const graphW = 150
  const x0 = 140
  const colW = (width - x0 - graphW) / f.cols.length
  f.cols.forEach((c, i) => {
    const x = x0 + i * colW + (i === 0 ? 0 : 14)
    if (i > 0) body += `<line class="d" x1="${x0 + i * colW}" y1="16" x2="${x0 + i * colW}" y2="${h - 12}"/>`
    body += `<text class="l" x="${x}" y="24">${c.label}</text>`
    body += `<text class="v${c.tone ? ` ${c.tone}` : ''}" x="${x}" y="46">${c.value}</text>`
    body += `<text class="s${i === 0 && f.isSoon ? ' warning' : ''}" x="${x}" y="63">${c.sub}</text>`
  })

  // Usage line over the 5-hour window, scaled so the limit line sits in view.
  const gx = width - graphW + 14
  const gw = graphW - 14
  const top = 32
  const bottom = h - 10
  const max = Math.max(p.limit, ...v.points.map(([, y]) => y), 1)
  const y = (pct: number) => bottom - (pct / max) * (bottom - top)
  body += `<line class="d" x1="${width - graphW}" y1="16" x2="${width - graphW}" y2="${h - 12}"/>`
  body += `<text class="l" x="${gx}" y="24">${f.reset ? `5h · ${f.reset}` : '5h window'}</text>`
  body += `<line class="lim" x1="${gx}" y1="${y(p.limit).toFixed(1)}" x2="${gx + gw}" y2="${y(p.limit).toFixed(1)}"/>`
  body += `<line class="d" x1="${gx}" y1="${bottom}" x2="${gx + gw}" y2="${bottom}"/>`
  if (v.points.length > 1) {
    const pts = v.points.map(([t, pct]) => `${(gx + t * gw).toFixed(1)},${y(pct).toFixed(1)}`).join(' ')
    body += `<polyline class="g k" points="${pts}" stroke-linejoin="round"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><style>${STYLE}</style>${body}</svg>`
}

/** A quarter-step ring glyph and a block sparkline for the terminal. */
export const ringGlyph = (frac: number) => ['○', '◔', '◑', '◕', '●'][Math.round(Math.min(1, frac) * 4)]
export function sparkline(points: [number, number][], width = 16): string {
  if (points.length < 2) return ''
  const max = Math.max(...points.map(([, y]) => y), 1)
  const bars = '▁▂▃▄▅▆▇█'
  // The last reading at or before each slot of the window so far.
  const end = points.at(-1)![0]
  return Array.from({ length: width }, (_, i) => {
    const t = (end * (i + 1)) / width
    const y = [...points].reverse().find(([pt]) => pt <= t)?.[1] ?? 0
    return bars[Math.min(7, Math.floor((y / max) * 7.99))]
  }).join('')
}
