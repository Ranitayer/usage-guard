import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Prefs, View } from '../types'
import {
  DEFAULT_PREFS,
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
  prune,
  rateFrom,
  ringGlyph,
  sampleOf,
  sparkline,
  split,
  summarize,
  toneOf,
  used,
} from './usage'

const STEP = 5
// Until calibrated: a response more than this after the last one is not counted to this PC (the other side may have used the gap).
const GAP = 2 * 60_000

const view = atom({ plugin: 'usage-guard', key: 'view' } as const, EMPTY_VIEW)
const prefsAtom = atom({ plugin: 'usage-guard', key: 'prefs' } as const, DEFAULT_PREFS)

// A value kept from an older version lacks newer fields.
const loadView = async ($: EngineInterface): Promise<View> => ({ ...EMPTY_VIEW, ...(await read($, view)) })

async function savePrefs($: EngineInterface, change: (p: Prefs) => Prefs) {
  const p = await update($, prefsAtom, x => change(asPrefs(x)))
  await $.store.set('prefs', p)
  return p
}

// Saves the API's latest readings (kept per PC across sessions), redraws the band, warns once per level per window.
async function refresh($: EngineInterface): Promise<View> {
  const usage = await $.session.usage()
  const five = usage.rateLimits.find(l => l.kind === 'five_hour')
  const week = usage.rateLimits.find(l => l.kind === 'seven_day')
  const old = asReading(await $.store.get('reading'))
  if (five) await $.store.set('reading', { pct: five.percentUsed, resetsAt: five.resetsAt ?? null, week: week?.percentUsed ?? old?.week ?? null })
  const now = await $.clock.now()
  const rate = rateFrom(asSamples(await $.store.get('samples')))
  const v = summarize(asEntries(await $.store.get('log')), asReading(await $.store.get('reading')), now, usage.cost?.usd ?? null, rate)
  await update($, view, () => v)

  const p = asPrefs(await read($, prefsAtom))
  const key = v.resetsAt ?? 'none'
  const lv = level(v, p)
  const warned = (await $.store.get('warned')) as { key?: string; level?: number } | undefined
  const before = warned?.key === key ? (warned.level ?? 0) : 0
  if (lv > before) {
    await $.store.set('warned', { key, level: lv })
    const why = split(v, p).isOtherBusy ? " (this PC's part while other use is busy)" : ''
    $.ui.toast(lv === 2 ? `Usage limit reached${why}. Time to stop.` : `Heads up: 80% of what this PC may use is gone${why}.`)
  }
  return v
}

export const register: Register = on => {
  // The last 5-hour reading this session saw, after any response.
  let last: { pct: number; t: number } | null = null
  // Fallback measure until calibrated: rises between close responses during this PC's turns.
  let riseThisTurn = 0
  // Session cost at the last main-turn end, and the reading + cost after this turn's first response.
  let costAtLastTurn = 0
  let firstOfTurn: { pct: number; usd: number } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-limit', description: 'Set the 5-hour usage limit in % (e.g. /usage-limit 45)' })
    await $.command.register({ name: 'usage-split', description: 'Turn the automatic split with other use on or off (/usage-split off)' })
    const p = asPrefs(await $.store.get('prefs'), await $.store.get('limit'))
    await update($, prefsAtom, () => p)
    // A resumed session's cost so far was spent before this run.
    costAtLastTurn = (await $.session.usage()).cost?.usd ?? 0
    await refresh($).catch(() => undefined)
    // Self-update from GitHub when installed as a git clone; the watched folder reloads what the pull changed.
    // Not awaited, so a slow network never holds up the session; no git or no clone just does nothing.
    void $.process
      .run(['git', '-C', $.plugin.root, 'pull', '--ff-only'], { timeoutMs: 30_000 })
      .then(r => (r.exitCode === 0 && r.stdout.includes('Fast-forward') ? $.ui.toast('usage-guard updated') : undefined))
      .catch(() => undefined)
    return next(e)
  })

  // `/usage-limit 45` sets the limit; alone it shows where you are.
  on('command.run', { command: 'usage-limit' }, async ($, e) => {
    const arg = e.args.trim().replace(/%$/, '')
    if (arg !== '') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > 100) return { text: 'The limit must be a whole number from 1 to 100.', isTextDisplayOnly: true }
      await savePrefs($, p => ({ ...p, limit: n }))
    }
    const v = await refresh($)
    return { text: `5-hour usage: ${v.pct ?? '?'}%. Limit: ${(await read($, prefsAtom)).limit}%.`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'usage-split' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== 'on' && arg !== 'off' && arg !== '') return { text: 'Use /usage-split on or /usage-split off.', isTextDisplayOnly: true }
    if (arg !== '') await savePrefs($, p => ({ ...p, split: arg === 'on' }))
    const v = await refresh($)
    const p = asPrefs(await read($, prefsAtom))
    const w = Math.round(split(v, p).weight * 100)
    return {
      text: `Split ${p.split ? 'on' : 'off'}. This PC used ${v.mine}% this window; other use ${v.other30}% in the last 30 min. This PC's part: ${w}% of the limit.`,
      isTextDisplayOnly: true,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Slash commands still run, so the limit can always be changed.
    if (e.command) return next(e)
    const v = await refresh($)
    const p = asPrefs(await read($, prefsAtom))
    const reason = blockReason(v, p, await $.clock.now())
    if (reason !== null) {
      if (!p.onePass) return { drop: `${reason} Use "Let 1 through" or "Snooze 15m" above the prompt to keep going.` }
      await savePrefs($, x => ({ ...x, onePass: false }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a bug here must never block prompting

  // After every model response: note the reading, the first one of the turn, and the fallback rise.
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
    } catch {
      // Measuring must never break a response.
    }
    return r
  })

  // Every turn logs its tokens and the 5-hour % after it; a main turn also its cost and a rate sample.
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
    }
    if (u || isMain) {
      const tok = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      // shortcut: two sessions finishing at the same instant can drop one entry; fine for a usage meter.
      const log = prune(asEntries(await $.store.get('log')), now)
      await $.store.set('log', [...log, { t: now, tok, out: u?.output_tokens ?? 0, pct: five?.percentUsed ?? null, d, usd }])
    }
    await refresh($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await refresh($).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e).catch(() => undefined)
    const v = await loadView($)
    const p = asPrefs(await read($, prefsAtom))
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = figures(v, p, now)
    const isSnoozed = now < p.snoozeUntil
    const isBlocked = blockReason(v, { ...p, snoozeUntil: 0 }, now) !== null
    const setLimit = (n: number) => savePrefs($, x => ({ ...x, limit: Math.min(100, Math.max(STEP, n)) }))

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
            <Button key="down" plain label="−" onPress={() => setLimit(p.limit - STEP)} />
            <Text bold>{p.limit}%</Text>
            <Button key="up" plain label="+" onPress={() => setLimit(p.limit + STEP)} />
          </Box>
        </Box>
      </Box>
    )

    let gauge
    if (e.surface === 'terminal') {
      // The terminal has no SVG: ring glyphs, a block sparkline and the same figures as text.
      const frac = used(v, p)
      gauge = (
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text>
            <Text color={toneOf(frac)}>{ringGlyph(frac)} </Text>
            <Text bold>{f.center}</Text>
            <Text dimColor> · week </Text>
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
      const alt = `5-hour usage ${f.center} (limit ${p.limit}%), week ${f.week}. ${f.cols.map(c => `${c.label}: ${c.value}, ${c.sub}`).join('. ')}. ${f.reset}`
      gauge = <Svg source={gaugeSvg(v, p, now)} alt={alt} />
    }

    const mine = (
      <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
        {/* The desktop scales the graphic to fill its box, so the box gets only what Limit leaves: one row, never wrapped. */}
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
