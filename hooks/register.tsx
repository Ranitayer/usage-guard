import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { History, Prefs, Sync, View } from '../types'
import { EMPTY_SYNC, pcName, readSync, sharesFor, writeSync } from './sync'
import type { SyncRepoState } from './sync'
import {
  DEFAULT_PREFS,
  addToDays,
  asDays,
  daysForStatus,
  historyOf,
  historySvg,
  projectsOf,
  EMPTY_VIEW,
  SNOOZE,
  asEntries,
  asPrefs,
  asReading,
  asSamples,
  blockReason,
  figures,
  fmtDur,
  gaugeSvg,
  level,
  plan,
  prune,
  rateFrom,
  ringGlyph,
  sampleOf,
  sparkline,
  summarize,
  toneOf,
  used,
} from './usage'

const STEP = 5
// Until a rate is known: a response more than this after the last one is not counted to this PC.
const GAP = 2 * 60_000
// Read the other PC's status at most this often unless something changed here.
const PULL_EVERY = 30_000
// While idle, say "online" this often (a PC counts as online for 5 minutes after its last status).
const ONLINE_BEAT = 2 * 60_000
const PANE = 'usage-history'
const EMPTY_HISTORY: History = { projects: [], days: {}, hours: Array<number>(24).fill(0) }
// While a turn runs, re-say "working" this often so a long turn never looks idle.
const HEARTBEAT = 2 * 60_000

const view = atom({ plugin: 'usage-guard', key: 'view' } as const, EMPTY_VIEW)
const prefsAtom = atom({ plugin: 'usage-guard', key: 'prefs' } as const, DEFAULT_PREFS)
const syncAtom = atom({ plugin: 'usage-guard', key: 'sync' } as const, EMPTY_SYNC)
const historyAtom = atom({ plugin: 'usage-guard', key: 'history' } as const, EMPTY_HISTORY)

// Values kept from an older version lack newer fields.
const loadView = async ($: EngineInterface): Promise<View> => ({ ...EMPTY_VIEW, ...(await read($, view)) })
const loadSync = async ($: EngineInterface): Promise<Sync> => ({ ...EMPTY_SYNC, ...(await read($, syncAtom)) })

async function savePrefs($: EngineInterface, change: (p: Prefs) => Prefs) {
  const p = await update($, prefsAtom, x => change(asPrefs(x)))
  await $.store.set('prefs', p)
  return p
}

/** Every %-per-dollar sample this PC has, plus the other PCs' from the gist. */
async function rateOf($: EngineInterface, s: Sync) {
  const mine = asSamples(await $.store.get('samples'))
  const theirs = Object.entries(s.pcs).flatMap(([n, st]) => (n === s.me ? [] : st.samples))
  return rateFrom([...mine, ...theirs])
}

// Saves the API's latest readings (kept per PC across sessions), redraws the band, warns once per level per window.
async function refresh($: EngineInterface): Promise<View> {
  const usage = await $.session.usage()
  const five = usage.rateLimits.find(l => l.kind === 'five_hour')
  const week = usage.rateLimits.find(l => l.kind === 'seven_day')
  const old = asReading(await $.store.get('reading'))
  if (five) await $.store.set('reading', { pct: five.percentUsed, resetsAt: five.resetsAt ?? null, week: week?.percentUsed ?? old?.week ?? null })
  const now = await $.clock.now()
  const s = await loadSync($)
  const log = asEntries(await $.store.get('log'))
  const reading = asReading(await $.store.get('reading'))
  const rate = await rateOf($, s)
  const v = summarize(log, reading, now, usage.cost?.usd ?? null, rate)
  await update($, view, () => v)
  const h = historyOf(asDays(await $.store.get('days')), s, s.me ?? 'this PC', projectsOf(log, reading, now, rate), now)
  await update($, historyAtom, () => h)

  const pl = plan(v, asPrefs(await read($, prefsAtom)), s, now)
  const key = v.resetsAt ?? 'none'
  const lv = level(v, pl)
  const warned = (await $.store.get('warned')) as { key?: string; level?: number } | undefined
  const before = warned?.key === key ? (warned.level ?? 0) : 0
  if (lv > before) {
    await $.store.set('warned', { key, level: lv })
    $.ui.toast(lv === 2 ? 'This PC reached its usage limit. Time to stop.' : 'Heads up: 80% of what this PC may use is gone.')
  }
  return v
}

// Sync state for this load of the module (a reload starts it over, which only costs one extra read).
const live: {
  repo: SyncRepoState | null
  busy: boolean
  pulling: Promise<void> | null
  lastPull: number
  lastBeat: number
  lastPush: number
  queue: Promise<void>
} = { repo: null, busy: false, pulling: null, lastPull: 0, lastBeat: 0, lastPush: 0, queue: Promise.resolve() }

/** Reads both PCs' state from the sync repo into the band; a failure only marks the band "not synced". */
async function pull($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!live.repo) return
  // One read at a time: on a slow network a read can outlast the 30 s between them. A forced read waits for it.
  if (live.pulling) return force ? live.pulling : undefined
  if (!force && now - live.lastPull < PULL_EVERY - 5_000) return
  live.lastPull = now
  live.pulling = pullNow($, now).finally(() => {
    live.pulling = null
  })
  return live.pulling
}

async function pullNow($: EngineInterface, now: number) {
  if (!live.repo) return
  try {
    const remote = await readSync($, live.repo)
    const s = await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, ...remote, error: null, at: now }))
    // A limit change not yet saved to the sync repo wins over what the gist says, and is sent again.
    const pending = await $.store.get('pendingShare')
    if (typeof pending === 'number') await pushShares($, pending)
    // First time this PC shows up: claim its share so the other PC's adds up to 100.
    else if (s.me && remote.shares[s.me] === undefined) await pushShares($, asPrefs(await read($, prefsAtom)).share)
  } catch (err) {
    await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, error: err instanceof Error ? err.message : 'sync failed' }))
  }
  await refresh($).catch(() => undefined)
}

/** Every 30 s: read the other PC; every 2 min while idle, tell it this one is still online. */
async function tick($: EngineInterface) {
  await pull($)
  if ((await $.clock.now()) - live.lastPush >= ONLINE_BEAT) await push($)
}

/** Publishes this PC's status, one write at a time so an older status never lands after a newer one. */
function push($: EngineInterface): Promise<void> {
  const run = live.queue.then(() => pushNow($))
  live.queue = run.catch(() => undefined)
  return run
}

/** This PC's status: working or not, its own usage, its rate samples. */
async function pushNow($: EngineInterface) {
  const s = await loadSync($)
  if (!live.repo || !s.me) return
  const v = await loadView($)
  const now = await $.clock.now()
  live.lastPush = now
  const status = {
    t: Number((await $.store.get('lastTurn')) ?? 0),
    busy: live.busy,
    updated: now,
    mine: v.mine,
    resetsAt: v.resetsAt,
    samples: asSamples(await $.store.get('samples')).slice(-30),
    days: daysForStatus(asDays(await $.store.get('days'))),
  }
  try {
    await writeSync($, live.repo, { [`pc-${s.me}.json`]: status })
    await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, pcs: { ...x.pcs, [s.me!]: status } }))
  } catch (err) {
    await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, error: err instanceof Error ? err.message : 'sync failed' }))
  }
}

/** Sets this PC's share and gives the rest to the other PC(s), on both sides. */
async function pushShares($: EngineInterface, share: number) {
  const s = await loadSync($)
  if (!live.repo || !s.me) return
  const shares = sharesFor(s.me, share, Object.keys(s.pcs).filter(n => n !== s.me))
  await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, shares }))
  // Kept until GitHub has it, so a dropped request is retried on the next sync instead of lost.
  await $.store.set('pendingShare', share)
  try {
    await writeSync($, live.repo, { 'shares.json': { shares } })
    await $.store.delete('pendingShare')
  } catch {
    // Left pending: the next pull sends it again.
  }
}

async function setShare($: EngineInterface, n: number) {
  const share = Math.min(100, Math.max(STEP, n))
  await savePrefs($, x => ({ ...x, share }))
  await pushShares($, share)
  await refresh($).catch(() => undefined)
}

export const register: Register = on => {
  // The last 5-hour reading this session saw, after any response.
  let last: { pct: number; t: number } | null = null
  // Fallback measure until a rate is known: rises between close responses during this PC's turns.
  let riseThisTurn = 0
  // Session cost at the last main-turn end, and the reading + cost after this turn's first response.
  let costAtLastTurn = 0
  let firstOfTurn: { pct: number; usd: number } | null = null
  // The project this session works in, for "which project used it".
  let project = 'other'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-share', description: "Set this PC's share of the 5-hour window in % (e.g. /usage-share 70)" })
    await $.command.register({ name: 'usage-history', description: 'Show usage per day, per PC, per hour and per project' })
    const root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.cwd())
    project = root.split(/[\\/]/).filter(Boolean).pop() ?? 'other'
    const p = asPrefs(await $.store.get('prefs'))
    await update($, prefsAtom, () => p)
    // A resumed session's cost so far was spent before this run.
    costAtLastTurn = (await $.session.usage()).cost?.usd ?? 0
    await refresh($).catch(() => undefined)

    // This PC's name in the gist: kept once chosen, from the computer's name.
    let me = await $.store.get('pcName')
    if (typeof me !== 'string') {
      const host = await $.process.run(['hostname'], { timeoutMs: 5_000 }).catch(() => null)
      me = pcName(host?.stdout ?? `pc-${Math.floor((await $.clock.now()) % 100000)}`)
      await $.store.set('pcName', me)
    }
    await update($, syncAtom, x => ({ ...EMPTY_SYNC, ...x, me: me as string }))
    live.repo = { dir: null }
    // Background sync never throws: a failure only shows as "not synced" on the band.
    void pull($, true).then(() => push($)).catch(() => undefined)
    $.clock.every(PULL_EVERY, () => void tick($).catch(() => undefined))

    // Self-update from GitHub when installed as a git clone; the watched folder reloads what the pull changed.
    // Not awaited, so a slow network never holds up the session; no git or no clone just does nothing.
    void $.process
      .run(['git', '-C', $.plugin.root, 'pull', '--ff-only'], { timeoutMs: 30_000 })
      .then(r => (r.exitCode === 0 && r.stdout.includes('Fast-forward') ? $.ui.toast('usage-guard updated') : undefined))
      .catch(() => undefined)
    return next(e)
  })

  // `/usage-share 70` sets this PC's share (the other PC gets the rest); alone it shows where you are.
  on('command.run', { command: 'usage-share' }, async ($, e) => {
    const arg = e.args.trim().replace(/%$/, '')
    if (arg !== '') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > 100) return { text: 'The share must be a whole number from 1 to 100.', isTextDisplayOnly: true }
      await setShare($, n)
    }
    await pull($, true)
    const v = await loadView($)
    const s = await loadSync($)
    const pl = plan(v, asPrefs(await read($, prefsAtom)), s, await $.clock.now())
    const others = pl.others.map(o => `${o.name}: ${o.mine}% of ${o.share}%${o.isWorking ? ', working' : ''}`).join('; ')
    return {
      text: `This PC (${s.me ?? '?'}): ${v.mine}% of its ${pl.share}% share, ${pl.left ?? '?'}% left. ${pl.synced ? `Other PCs: ${others || 'none yet'}.` : `Not synced: ${s.error ?? 'connecting'}.`} Account: ${v.pct ?? '?'}%.`,
      isTextDisplayOnly: true,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Slash commands still run, so the share can always be changed.
    if (e.command) return next(e)
    await pull($)
    const v = await refresh($)
    const p = asPrefs(await read($, prefsAtom))
    const now = await $.clock.now()
    const reason = blockReason(v, p, plan(v, p, await loadSync($), now), now)
    if (reason !== null) {
      if (!p.onePass) return { drop: `${reason} Use "Let 1 through" or "Snooze 15m" above the prompt to keep going.` }
      await savePrefs($, x => ({ ...x, onePass: false }))
    }
    const r = await next(e)
    // Tell the other PC this one is working now.
    live.busy = true
    live.lastBeat = now
    void push($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e)) // a bug here must never block prompting

  // After every model response: note the reading, the first one of the turn, the fallback rise, and keep "working" fresh.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const usage = await $.session.usage()
      const five = usage.rateLimits.find(l => l.kind === 'five_hour')
      const now = await $.clock.now()
      if (five) {
        if (last && now - last.t < GAP && five.percentUsed >= last.pct) riseThisTurn += five.percentUsed - last.pct
        if (firstOfTurn === null) firstOfTurn = { pct: five.percentUsed, usd: usage.cost?.usd ?? 0 }
        last = { pct: five.percentUsed, t: now }
      }
      if (now - live.lastBeat >= HEARTBEAT) {
        live.busy = true
        live.lastBeat = now
        void push($).catch(() => undefined)
      }
    } catch {
      // Measuring must never break a response.
    }
    return r
  })

  // Every turn logs its tokens and the 5-hour % after it; a main turn also its cost, a rate sample, and tells the other PC.
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const five = usage.rateLimits.find(l => l.kind === 'five_hour')
    const isMain = e.agentId === undefined
    let usd = 0
    let d = 0
    if (isMain) {
      const cost = usage.cost?.usd ?? costAtLastTurn
      usd = Math.max(0, cost - costAtLastTurn)
      costAtLastTurn = cost
      d = riseThisTurn
      riseThisTurn = 0
      // From the first response to the last, so the gap before the turn (other use) is left out.
      const sample = firstOfTurn && five ? sampleOf(five.percentUsed - firstOfTurn.pct, cost - firstOfTurn.usd) : null
      firstOfTurn = null
      if (sample !== null) await $.store.set('samples', [...asSamples(await $.store.get('samples')), sample].slice(-30))
      await $.store.set('lastTurn', now)
    }
    if (u || isMain) {
      const tok = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      // shortcut: two sessions finishing at the same instant can drop one entry; fine for a usage meter.
      const log = prune(asEntries(await $.store.get('log')), now)
      await $.store.set('log', [...log, { t: now, tok, out: u?.output_tokens ?? 0, pct: five?.percentUsed ?? null, d, usd, proj: project }])
    }
    if (isMain) {
      // This turn's own % into the per-day and per-hour history.
      const rate = await rateOf($, await loadSync($))
      const own = rate !== null ? usd * rate : d
      if (own > 0) await $.store.set('days', addToDays(asDays(await $.store.get('days')), now, own))
    }
    await refresh($).catch(() => undefined)
    if (isMain) {
      // shortcut: two sessions on one PC share one "working" flag; the first to finish clears it until the other's next heartbeat.
      live.busy = false
      void push($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await refresh($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'usage-history' }, async $ => {
    await refresh($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: 'Usage history' })
    return { text: 'Usage history opened.', isTextDisplayOnly: true }
  })

  // The history pane: projects this window, per-day usage of each PC, this PC by hour.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Not `h`: that name is the JSX factory.
    const hist: History = { ...EMPTY_HISTORY, ...(await read($, historyAtom)) }
    const me = (await loadSync($)).me ?? 'this PC'
    const { Box, Text } = $.ui.resolve(e)
    if (e.surface === 'terminal') {
      const days = Object.keys(hist.days[me] ?? {})
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>This 5-hour window by project</Text>
          {hist.projects.length === 0 ? <Text dimColor>No usage yet this window</Text> : hist.projects.slice(0, 6).map(([p, n]) => <Text key={p}>{`${n}%`.padStart(6)}  {p}</Text>)}
          <Text bold>Last {days.length} days</Text>
          {Object.entries(hist.days).map(([pc, d]) => (
            <Text key={pc}>
              {sparkline(days.map((k, i) => [i / Math.max(1, days.length - 1), d[k] ?? 0] as [number, number]), days.length)} {pc === me ? `${pc} (this PC)` : pc}
            </Text>
          ))}
          <Text bold>This PC by hour of day</Text>
          <Text>{sparkline(hist.hours.map((v, i) => [i / 23, v] as [number, number]), 24)}</Text>
          <Text dimColor>0h{' '.repeat(18)}23h</Text>
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e)
    const alt = `Usage history. This window by project: ${hist.projects.map(([p, n]) => `${p} ${n}%`).join(', ') || 'none'}.`
    return <Svg source={historySvg(hist, me)} alt={alt} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e).catch(() => undefined)
    const v = await loadView($)
    const p = asPrefs(await read($, prefsAtom))
    const s = await loadSync($)
    const now = await $.clock.now()
    const pl = plan(v, p, s, now)
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = figures(v, pl, s, now)
    const isSnoozed = now < p.snoozeUntil
    const isBlocked = blockReason(v, { ...p, snoozeUntil: 0 }, pl, now) !== null

    const controls = (
      <Box flexDirection="column" alignItems="flex-end" gap={1}>
        {isBlocked && (
          <Box flexDirection="row" alignItems="center" gap={1}>
            {isSnoozed ? (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Text color="warning">Snoozed · {fmtDur(p.snoozeUntil - now)} left</Text>
                <Button key="unsnooze" plain label="End snooze" onPress={() => savePrefs($, x => ({ ...x, snoozeUntil: 0 }))} />
              </Box>
            ) : p.onePass ? (
              <Text color="warning">Next prompt goes through</Text>
            ) : (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Text color="error">Stopped</Text>
                <Button key="once" label="Let 1 through" onPress={() => savePrefs($, x => ({ ...x, onePass: true }))} />
                <Button
                  key="snooze"
                  label="Snooze 15m"
                  onPress={async () => {
                    const t = await $.clock.now()
                    await savePrefs($, x => ({ ...x, snoozeUntil: t + SNOOZE }))
                  }}
                />
              </Box>
            )}
          </Box>
        )}
        <Box flexDirection="column" alignItems="center">
          <Text dimColor>Limit</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Button key="down" plain label="−" onPress={() => setShare($, pl.share - STEP)} />
            <Text bold>{pl.share}%</Text>
            <Button key="up" plain label="+" onPress={() => setShare($, pl.share + STEP)} />
          </Box>
          <Button key="history" plain dimColor label="History" onPress={() => $.ui.open({ id: PANE, title: 'Usage history' })} />
        </Box>
      </Box>
    )

    let gauge
    if (e.surface === 'terminal') {
      // The terminal has no SVG: ring glyphs, a block sparkline and the same figures as text.
      const frac = used(v, pl)
      gauge = (
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text>
            <Text color={toneOf(frac)}>{ringGlyph(frac)} </Text>
            <Text bold>{f.center}</Text>
            <Text dimColor> this PC · week </Text>
            <Text>{f.week}</Text>
          </Text>
          {f.cols.map(c => (
            <Text key={c.label}>
              <Text dimColor>{c.label} </Text>
              <Text bold color={c.tone}>
                {c.value}
              </Text>
              <Text dimColor> {c.sub}</Text>
            </Text>
          ))}
          <Text>
            <Text dimColor>5h </Text>
            {sparkline(v.points)}
            <Text dimColor> {f.reset}</Text>
          </Text>
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve(e)
      const alt = `This PC used ${f.center} of the 5-hour window (may use ${pl.cap}%), week ${f.week}. ${f.cols.map(c => `${c.label}: ${c.value}, ${c.sub}`).join('. ')}. ${f.reset}`
      gauge = <Svg source={gaugeSvg(v, pl, s, now)} alt={alt} />
    }

    const mine = (
      <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
        {/* The desktop scales the graphic to fill its box, so the box gets only what the controls leave: one row, never wrapped. */}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {gauge}
        </Box>
        {controls}
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  }).catch(($, e, next) => next(e))
}
