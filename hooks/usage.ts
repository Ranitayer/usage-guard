import type { History, PcStatus, Prefs, Sync, View } from '../types'

/**
 * One finished turn on this PC: when, its tokens, the 5-hour % right after it,
 * what it cost (usd, main turns only), and the % rise seen during it (d, used until a rate is known).
 */
export type Entry = { t: number; tok: number; out: number; pct: number | null; d?: number; usd?: number; proj?: string }
/** The last readings the API gave. */
export type Reading = { pct: number; resetsAt: string | null; week?: number | null }

export const FIVE_HOURS = 5 * 3600_000
export const SLICE = 15 * 60_000
export const SNOOZE = 15 * 60_000
/** The other PC counts as idle, and lends its share, after this long without a turn. */
export const IDLE_AFTER = 30 * 60_000
/** A "working" flag older than this is stale (that PC closed mid-turn). */
export const BUSY_STALE = 5 * 60_000
/** Synced data older than this is not trusted for lending. */
export const SYNC_STALE = 10 * 60_000
/** A PC that sent a status within this long has Claude open. */
export const ONLINE_FOR = 5 * 60_000

export const EMPTY_VIEW: View = {
  pct: null,
  resetsAt: null,
  week: null,
  tokens15: 0,
  out15: 0,
  tokensWindow: 0,
  mine: 0,
  mine15: 0,
  isCalibrated: false,
  points: [],
  cost: null,
}
export const DEFAULT_PREFS: Prefs = { share: 50, snoozeUntil: 0, onePass: false }

// $.store hands back unknown JSON: keep only well-formed values.
export const asEntries = (v: unknown): Entry[] =>
  Array.isArray(v) ? v.filter((x): x is Entry => typeof x?.t === 'number' && typeof x?.tok === 'number') : []

export const asReading = (v: unknown): Reading | null =>
  typeof (v as Reading)?.pct === 'number' ? (v as Reading) : null

export const asSamples = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0 && Number.isFinite(x)) : []

const isShare = (v: unknown): v is number => typeof v === 'number' && v >= 1 && v <= 100

/** Stored prefs; older versions kept the number as `limit`. */
export function asPrefs(v: unknown): Prefs {
  const p = (v ?? {}) as Partial<Prefs> & { limit?: unknown }
  return {
    share: isShare(p.share) ? p.share : isShare(p.limit) ? p.limit : DEFAULT_PREFS.share,
    snoozeUntil: typeof p.snoozeUntil === 'number' ? p.snoozeUntil : 0,
    onePass: p.onePass === true,
  }
}

/** Drops entries older than one 5-hour window. */
export const prune = (log: Entry[], now: number) => log.filter(e => e.t >= now - FIVE_HOURS)

/**
 * % of the 5-hour window per dollar, the median of every PC's per-turn samples.
 * shortcut: one rate for every model; if usage weights models differently than API prices do, own usage drifts by that much.
 */
export function rateFrom(samples: number[]): number | null {
  if (samples.length === 0) return null
  const s = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** A turn's rate sample, or null when the turn was too small to read through the whole-% readings. */
export const sampleOf = (dPct: number, dUsd: number) => (dPct >= 1 && dUsd >= 0.3 ? dPct / dUsd : null)

const round1 = (n: number) => Math.round(n * 10) / 10

export function summarize(log: Entry[], reading: Reading | null, now: number, cost: number | null = null, rate: number | null = null): View {
  const resetMs = reading?.resetsAt ? Date.parse(reading.resetsAt) : NaN
  const isExpired = Number.isFinite(resetMs) && resetMs <= now
  // A window that has reset since the last reading is at 0 until the API says otherwise.
  const pct = reading === null ? null : isExpired ? 0 : reading.pct
  const resetsAt = reading === null || isExpired ? null : reading.resetsAt
  const windowStart = Number.isFinite(resetMs) && !isExpired ? resetMs - FIVE_HOURS : now - FIVE_HOURS
  const inWindow = log.filter(e => e.t >= windowStart && e.t <= now)
  const recent = inWindow.filter(e => e.t >= Math.max(now - SLICE, windowStart))

  // This PC's own % per turn: cost × rate once known, else the rise seen during the turn.
  const own = (e: Entry) => (rate !== null && e.usd !== undefined ? e.usd * rate : (e.d ?? 0))

  const points: [number, number][] = [[0, 0]]
  let sum = 0
  for (const e of inWindow) {
    // This PC can never have used more than the whole account had at that moment: the cost estimate is capped by it.
    sum = Math.min(sum + own(e), e.pct ?? Infinity)
    points.push([(e.t - windowStart) / FIVE_HOURS, round1(sum)])
  }
  if (inWindow.length > 0) points.push([Math.min(1, (now - windowStart) / FIVE_HOURS), round1(sum)])

  return {
    pct,
    resetsAt,
    week: reading?.week ?? null,
    tokens15: recent.reduce((n, e) => n + e.tok, 0),
    out15: recent.reduce((n, e) => n + e.out, 0),
    tokensWindow: inWindow.reduce((n, e) => n + e.tok, 0),
    mine: round1(pct === null ? sum : Math.min(sum, pct)),
    mine15: round1(recent.reduce((n, e) => n + own(e), 0)),
    isCalibrated: rate !== null,
    points: points.slice(-120),
    cost,
  }
}

/** Another PC as this one sees it through the gist. */
export type Other = { name: string; share: number; mine: number; isWorking: boolean; isOnline: boolean; seenMs: number; idleMs: number | null }

/** Every PC but this one; usage from a window that has since reset counts as 0. */
export function othersOf(s: Sync, myShare: number, now: number): Other[] {
  const names = Object.keys(s.pcs).filter(n => n !== s.me)
  return names.map(name => {
    const st: PcStatus = s.pcs[name]!
    const windowOver = st.resetsAt !== null && Date.parse(st.resetsAt) <= now
    return {
      name,
      share: s.shares[name] ?? Math.round((100 - myShare) / names.length),
      mine: windowOver ? 0 : st.mine,
      // Judged at the last good read, so this PC's own network trouble does not make the other PC look offline.
      isWorking: st.busy && s.at - st.updated < BUSY_STALE,
      // Claude open there: it sends a status every 2 minutes.
      isOnline: s.at - st.updated < ONLINE_FOR,
      seenMs: now - st.updated,
      idleMs: st.t > 0 ? now - st.t : null,
    }
  })
}

// A failed check does not drop the other PC at once: the last good read counts for SYNC_STALE.
export const isSynced = (s: Sync, now: number) => s.at > 0 && now - s.at < SYNC_STALE

export type Plan = {
  share: number
  /** % this PC may reach: its share, or more while the others are idle and lend theirs. */
  cap: number
  left: number | null
  isLending: boolean
  synced: boolean
  others: Other[]
}

/** Where this PC stands: its share, what it may use, and what is left. */
export function plan(v: View, p: Prefs, s: Sync, now: number): Plan {
  const synced = isSynced(s, now)
  const share = (synced && s.me !== null ? s.shares[s.me] : undefined) ?? p.share
  const others = synced ? othersOf(s, share, now) : []
  // Lend when every other PC is known and either has Claude closed (offline) or has had no turn for a while.
  const isLending = others.length > 0 && others.every(o => !o.isWorking && (!o.isOnline || o.idleMs === null || o.idleMs >= IDLE_AFTER))
  const cap = round1(isLending ? 100 - others.reduce((n, o) => n + o.mine, 0) : share)
  const left = v.pct === null ? null : Math.max(0, round1(Math.min(cap - v.mine, 100 - v.pct)))
  return { share, cap, left, isLending, synced, others }
}

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

export const fmtDur = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
}

export const resetsIn = (iso: string | null, now: number) => (iso === null ? '' : `resets in ${fmtDur(Date.parse(iso) - now)}`)

/** How much of what this PC may use is used, 0..1. */
export const used = (v: View, pl: Plan) => (pl.cap <= 0 ? 1 : Math.min(1, Math.max(0, v.mine / pl.cap)))

/** 0 under, 1 past 80% of what this PC may use, 2 at the stop. */
export function level(v: View, pl: Plan): 0 | 1 | 2 {
  if (pl.left === null) return 0
  return pl.left <= 0 ? 2 : used(v, pl) >= 0.8 ? 1 : 0
}

/** Why a prompt is stopped now, or null. Snooze lets everything through; one-pass is the caller's. */
export function blockReason(v: View, p: Prefs, pl: Plan, now: number): string | null {
  if (now < p.snoozeUntil || pl.left === null || pl.left > 0) return null
  const reset = v.resetsAt ? ` (${resetsIn(v.resetsAt, now)})` : ''
  if (v.pct !== null && v.pct >= 100) return `Stopped: the account's 5-hour usage is used up${reset}.`
  return `Stopped: this PC used ${v.mine}% of the 5-hour window, its ${pl.isLending ? 'limit while the other PC is idle' : `${pl.share}% share`}${reset}.`
}

/** "stop in ~1h 20m" at this PC's last 15 minutes' pace, or why there is no forecast. */
export function pace(v: View, pl: Plan, now: number): { text: string; isSoon: boolean } {
  if (pl.left === null) return { text: 'waiting for first reply', isSoon: false }
  if (pl.left <= 0) return { text: v.resetsAt ? resetsIn(v.resetsAt, now) : 'limit reached', isSoon: true }
  if (v.mine15 <= 0) return { text: 'no use in 15 min', isSoon: false }
  const ms = (pl.left / v.mine15) * SLICE
  if (v.resetsAt && now + ms >= Date.parse(v.resetsAt)) return { text: 'safe until reset', isSoon: false }
  return { text: `stop in ~${fmtDur(ms)}`, isSoon: ms < 3600_000 }
}

export const toneOf = (frac: number) => (frac >= 1 ? 'error' : frac >= 0.8 ? 'warning' : 'success')

/** The other PC's state in a few words. */
export function otherText(pl: Plan, s: Sync, now: number): { value: string; sub: string; tone?: 'success' | 'warning' } {
  if (!pl.synced) return { value: 'not synced', sub: s.at === 0 ? (s.error ?? 'connecting…') : `${s.error ?? 'GitHub unreachable'} · retrying` }
  const o = pl.others[0]
  if (!o) return { value: 'not seen yet', sub: s.error ?? 'install it on the other PC' }
  // The latest sync failed: show the last good read, and how old it is.
  const usedText = s.error !== null ? `synced ${fmtDur(now - s.at)} ago · retrying` : `${o.mine}% of ${o.share}%`
  const idle = o.idleMs === null ? 'idle' : `idle ${fmtDur(o.idleMs)}`
  if (o.isWorking) return { value: '● working', sub: usedText, tone: 'success' }
  const value = o.isOnline ? '● online' : 'offline'
  if (pl.isLending) return { value, sub: `${idle} · lends you`, tone: 'warning' }
  return { value, sub: o.isOnline ? `${idle} · ${usedText}` : `seen ${fmtDur(o.seenMs)} ago · ${usedText}` }
}

type Col = { label: string; value: string; sub: string; tone?: 'success' | 'warning' | 'error' }

/** The text the rings and columns say, shared by the SVG and the terminal row. */
export function figures(v: View, pl: Plan, s: Sync, now: number) {
  const forecast = pace(v, pl, now)
  const other = otherText(pl, s, now)
  const cols: Col[] = [
    {
      // While lending, the room is more than this PC's own limit: say so, and what its own limit alone would leave.
      label: pl.isLending ? 'Left · with lent share' : 'Left before stop',
      value: pl.left === null ? '—' : `${pl.left}%`,
      sub: pl.isLending && pl.left !== null ? `own limit: ${Math.max(0, round1(pl.share - v.mine))}% left` : forecast.text,
      tone: toneOf(used(v, pl)),
    },
    { label: v.isCalibrated ? 'Last 15 min' : 'Last 15 min · learning', value: `+${v.mine15}%`, sub: `${fmtTokens(v.tokens15)} tok · ${fmtTokens(v.out15)} out` },
    { label: 'Other PC', value: other.value, sub: other.sub, tone: other.tone },
    { label: 'Account', value: v.pct === null ? '—' : `${v.pct}%`, sub: v.cost === null ? 'both PCs' : `$${v.cost.toFixed(2)} this session` },
  ]
  return {
    center: `${v.mine}%`,
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

export const GAUGE_W = 860
export const GAUGE_H = 76

/** This PC's ring (its own usage toward what it may use), the weekly ring, four columns and its usage line, as one SVG. */
export function gaugeSvg(v: View, pl: Plan, s: Sync, now: number, width = GAUGE_W): string {
  const h = GAUGE_H
  const f = figures(v, pl, s, now)
  const frac = used(v, pl)
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

  // This PC's usage over the 5-hour window, with the line it stops at.
  const gx = width - graphW + 14
  const gw = graphW - 14
  const top = 32
  const bottom = h - 10
  const max = Math.max(pl.cap, ...v.points.map(([, y]) => y), 1)
  const y = (pct: number) => bottom - (pct / max) * (bottom - top)
  body += `<line class="d" x1="${width - graphW}" y1="16" x2="${width - graphW}" y2="${h - 12}"/>`
  body += `<text class="l" x="${gx}" y="24">${f.reset ? `5h · ${f.reset}` : '5h window'}</text>`
  body += `<line class="lim" x1="${gx}" y1="${y(pl.cap).toFixed(1)}" x2="${gx + gw}" y2="${y(pl.cap).toFixed(1)}"/>`
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

/** A local calendar day, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export const HISTORY_DAYS = 14

/** This PC's own usage per day: total % and % per hour of day. */
export type Days = Record<string, { pct: number; hours: number[] }>

export function asDays(v: unknown): Days {
  const out: Days = {}
  for (const [d, x] of Object.entries((v ?? {}) as Record<string, { pct?: unknown; hours?: unknown }>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || typeof x?.pct !== 'number') continue
    const hours = Array.isArray(x.hours) && x.hours.length === 24 ? x.hours.map(h => (typeof h === 'number' ? h : 0)) : Array<number>(24).fill(0)
    out[d] = { pct: x.pct, hours }
  }
  return out
}

/** Adds one turn's % at `ms`, keeping the last HISTORY_DAYS days. */
export function addToDays(days: Days, ms: number, pct: number): Days {
  const key = dayKey(ms)
  const day = days[key] ?? { pct: 0, hours: Array<number>(24).fill(0) }
  const hours = [...day.hours]
  hours[new Date(ms).getHours()]! += pct
  const next = { ...days, [key]: { pct: day.pct + pct, hours } }
  // Keep the HISTORY_DAYS days up to the newest one recorded (YYYY-MM-DD sorts by date).
  const newest = Object.keys(next).sort().at(-1)!
  const [y, m, dd] = newest.split('-').map(Number)
  const cutoff = dayKey(new Date(y!, m! - 1, dd! - (HISTORY_DAYS - 1)).getTime())
  return Object.fromEntries(Object.entries(next).filter(([d]) => d >= cutoff))
}

/** This PC's % per project in the current 5-hour window, largest first. */
export function projectsOf(log: Entry[], reading: Reading | null, now: number, rate: number | null): [string, number][] {
  const resetMs = reading?.resetsAt ? Date.parse(reading.resetsAt) : NaN
  const windowStart = Number.isFinite(resetMs) && resetMs > now ? resetMs - FIVE_HOURS : now - FIVE_HOURS
  const by = new Map<string, number>()
  for (const e of log) {
    if (e.t < windowStart || e.t > now) continue
    const own = rate !== null && e.usd !== undefined ? e.usd * rate : (e.d ?? 0)
    by.set(e.proj ?? 'other', (by.get(e.proj ?? 'other') ?? 0) + own)
  }
  return [...by].filter(([, n]) => n > 0).map(([p, n]) => [p, round1(n)] as [string, number]).sort((a, b) => b[1] - a[1])
}

/** Everything the history pane shows: this PC's projects and hours, and every PC's days. */
export function historyOf(days: Days, s: Sync, me: string, projects: [string, number][], now: number): History {
  const keys = Array.from({ length: HISTORY_DAYS }, (_, i) => dayKey(now - (HISTORY_DAYS - 1 - i) * 86_400_000))
  const perPc: History['days'] = { [me]: Object.fromEntries(keys.map(k => [k, round1(days[k]?.pct ?? 0)])) }
  for (const [name, st] of Object.entries(s.pcs)) {
    if (name !== me) perPc[name] = Object.fromEntries(keys.map(k => [k, round1(st.days[k] ?? 0)]))
  }
  const hours = Array<number>(24).fill(0)
  for (const k of keys) days[k]?.hours.forEach((h, i) => (hours[i]! += h))
  return { projects, days: perPc, hours: hours.map(round1) }
}

/** The last HISTORY_DAYS days' % for publishing in this PC's status. */
export const daysForStatus = (days: Days): Record<string, number> => Object.fromEntries(Object.entries(days).map(([d, x]) => [d, round1(x.pct)]))

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The history pane as one SVG: projects this window, % per day per PC, this PC by hour. */
export function historySvg(h: History, me: string): string {
  const W = 440
  const pcs = Object.keys(h.days)
  const colorOf = (pc: string) => (pc === me ? 'me' : 'other')
  let y = 22
  let body = `<text class="h" x="0" y="${y}">This 5-hour window by project (this PC)</text>`
  y += 10
  const top = h.projects.slice(0, 6)
  const maxP = Math.max(1, ...top.map(([, n]) => n))
  if (top.length === 0) body += `<text class="s" x="0" y="${(y += 18)}">No usage yet this window</text>`
  for (const [name, n] of top) {
    y += 20
    const w = Math.max(2, (n / maxP) * 200)
    body += `<text class="s" x="0" y="${y}">${esc(name.slice(0, 22))}</text><rect class="me" x="150" y="${y - 10}" width="${w.toFixed(1)}" height="12" rx="2"/><text class="v" x="${(156 + w).toFixed(1)}" y="${y}">${n}%</text>`
  }

  y += 40
  body += `<text class="h" x="0" y="${y}">Last ${HISTORY_DAYS} days, % of a 5-hour window per day</text>`
  const days = Object.keys(h.days[me] ?? {})
  const totals = days.map(d => pcs.reduce((n, pc) => n + (h.days[pc]?.[d] ?? 0), 0))
  const maxD = Math.max(1, ...totals)
  const chartH = 90
  const base = y + 16 + chartH
  const bw = (W - 20) / Math.max(1, days.length)
  days.forEach((d, i) => {
    let top2 = base
    for (const pc of pcs) {
      const v = h.days[pc]?.[d] ?? 0
      const bh = (v / maxD) * chartH
      if (bh > 0) body += `<rect class="${colorOf(pc)}" x="${(i * bw).toFixed(1)}" y="${(top2 - bh).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${bh.toFixed(1)}"/>`
      top2 -= bh
    }
    if (i % 2 === days.length % 2 || i === days.length - 1) body += `<text class="xs" x="${(i * bw + (bw - 3) / 2).toFixed(1)}" y="${base + 12}" text-anchor="middle">${d.slice(8)}</text>`
  })
  body += `<line class="d" x1="0" y1="${base}" x2="${W - 20}" y2="${base}"/>`
  body += `<text class="xs" x="${W - 20}" y="${base - chartH - 4}" text-anchor="end">top ${round1(maxD)}%</text>`
  y = base + 30
  pcs.forEach((pc, i) => {
    body += `<rect class="${colorOf(pc)}" x="${i * 150}" y="${y - 9}" width="10" height="10" rx="2"/><text class="s" x="${i * 150 + 15}" y="${y}">${esc(pc === me ? `${pc} (this PC)` : pc).slice(0, 24)}</text>`
  })

  y += 40
  body += `<text class="h" x="0" y="${y}">This PC by hour of day, last ${HISTORY_DAYS} days</text>`
  const maxH = Math.max(1, ...h.hours)
  const hb = y + 16 + 60
  const hw = (W - 20) / 24
  h.hours.forEach((v, i) => {
    const bh = (v / maxH) * 60
    if (bh > 0) body += `<rect class="me" x="${(i * hw).toFixed(1)}" y="${(hb - bh).toFixed(1)}" width="${(hw - 2).toFixed(1)}" height="${bh.toFixed(1)}"/>`
    if (i % 3 === 0) body += `<text class="xs" x="${(i * hw + (hw - 2) / 2).toFixed(1)}" y="${hb + 12}" text-anchor="middle">${i}</text>`
  })
  body += `<line class="d" x1="0" y1="${hb}" x2="${W - 20}" y2="${hb}"/>`
  const H = hb + 20
  const style = `.h{fill:#1f1e1d;font:600 13px ${FONT}}.s{fill:#87867f;font:12px ${FONT}}.xs{fill:#87867f;font:10px ${FONT}}.v{fill:#1f1e1d;font:600 12px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.15}.me{fill:#2e7d32}.other{fill:#6a5acd}@media (prefers-color-scheme:dark){.h,.v{fill:#ecebe6}.d{stroke:#fff;stroke-opacity:.15}.me{fill:#6abf69}.other{fill:#9d8cff}}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${style}</style>${body}</svg>`
}
