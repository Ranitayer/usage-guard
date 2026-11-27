import type { EngineInterface } from 'claude-code'

import type { PcStatus, Sync } from '../types'

/** The private repo both PCs share sits next to this plugin's own repo: <owner>/usage-guard-sync. */
export const SYNC_REPO = 'usage-guard-sync'
// Each network try gets longer: a quick retry helps a network that drops connections, and the later, longer
// ones leave room for a slow PC, where git and the GitHub CLI's sign-in helper take seconds just to start.
const TRY_TIMEOUTS = [10_000, 20_000, 30_000, 45_000]
// Local git work and a first clone may take longer than one network try.
const LOCAL_TIMEOUT = 30_000
// Never ask on a terminal or in a window: a PC without a sign-in just reads "not synced".
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
// Only the GitHub CLI's sign-in, whatever other credential helpers the PC has.
const CRED = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

export const EMPTY_SYNC: Sync = { me: null, error: null, at: 0, shares: {}, sharesAt: 0, sharesBy: null, pcs: {} }

/** Thrown when another Claude session on this PC is syncing right now: skip this round, it is not a failure. */
export const BUSY = 'sync busy'

/** A PC name safe in a file name. */
export const pcName = (raw: string) => raw.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'pc'

const asNumber = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Reads one PC's file; anything malformed becomes a quiet, idle status. */
export function asStatus(text: string | undefined): PcStatus | null {
  try {
    const v = JSON.parse(text ?? '') as Partial<PcStatus>
    const days: Record<string, number> = {}
    for (const [d, n] of Object.entries(v.days ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && n >= 0) days[d] = n
    return {
      t: asNumber(v.t),
      busy: v.busy === true,
      updated: asNumber(v.updated),
      mine: Math.max(0, asNumber(v.mine)),
      resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : null,
      samples: Array.isArray(v.samples) ? v.samples.filter((x): x is number => typeof x === 'number' && x > 0 && Number.isFinite(x)).slice(-30) : [],
      days,
    }
  } catch {
    return null
  }
}

/** Shares file: only whole numbers 1..99 count; `at`/`by` say when and where they were set. */
export function asShares(text: string | undefined): Pick<Sync, 'shares' | 'sharesAt' | 'sharesBy'> {
  try {
    const v = JSON.parse(text ?? '') as { shares?: Record<string, unknown>; at?: unknown; by?: unknown }
    const shares: Record<string, number> = {}
    for (const [k, n] of Object.entries(v.shares ?? {})) if (typeof n === 'number' && n >= 1 && n <= 99) shares[pcName(k)] = Math.round(n)
    return { shares, sharesAt: asNumber(v.at), sharesBy: typeof v.by === 'string' ? v.by : null }
  } catch {
    return { shares: {}, sharesAt: 0, sharesBy: null }
  }
}

/** The sync repo's files (name → text) into shares and statuses. */
export function parseFiles(files: Record<string, string>): Pick<Sync, 'shares' | 'sharesAt' | 'sharesBy' | 'pcs'> {
  const pcs: Record<string, PcStatus> = {}
  for (const [file, text] of Object.entries(files)) {
    const m = /^pc-(.+)\.json$/.exec(file)
    const s = m ? asStatus(text) : null
    if (m && s) pcs[m[1]!] = s
  }
  return { ...asShares(files['shares.json']), pcs }
}

/** Shares after this PC picks `share`: the rest is split evenly over the other PCs. */
export function sharesFor(me: string, share: number, others: string[]): Record<string, number> {
  const out: Record<string, number> = { [me]: share }
  for (const o of others) out[o] = Math.round((100 - share) / others.length)
  return out
}

/** The sync repo's address from this plugin's own clone: https://github.com/<owner>/usage-guard(.git) → <owner>/usage-guard-sync. */
export function syncUrl(origin: string): string | null {
  const m = /github\.com[/:]([^/]+)\/[^/\s]+?(\.git)?\s*$/.exec(origin.trim())
  return m ? `https://github.com/${m[1]}/${SYNC_REPO}.git` : null
}

/** Why git failed, in a few words for the band. */
export function gitError(stderr: string): string {
  if (/could not read Username|Authentication failed|terminal prompts disabled|gh auth login|not logged/i.test(stderr)) return 'run: gh auth login'
  if (/Repository not found|not found/i.test(stderr)) return `no access to ${SYNC_REPO}`
  if (/gh: (command )?not found|'gh' is not recognized|executable file not found/i.test(stderr)) return 'install GitHub CLI (gh)'
  return 'GitHub not reachable'
}

/** Where the local copy of the sync repo lives: <home>/.claude/usage-guard-sync, outside the watched plugin folder. */
export type SyncRepoState = { dir: string | null; session: string; queue?: Promise<unknown> }

/** One git operation at a time within this session; `withLock` does the same across sessions. */
function serial<T>(st: SyncRepoState, fn: () => Promise<T>): Promise<T> {
  const run = (st.queue ?? Promise.resolve()).then(fn)
  st.queue = run.catch(() => undefined)
  return run
}

async function git($: EngineInterface, args: string[], network = false): Promise<string> {
  let err = ''
  for (let i = 0; i < (network ? TRY_TIMEOUTS.length : 1); i++) {
    const timeoutMs = network ? Math.max(TRY_TIMEOUTS[i]!, args[0] === 'clone' ? LOCAL_TIMEOUT : 0) : LOCAL_TIMEOUT
    const r = await $.process.run(['git', ...CRED, ...args], { env: GIT_ENV, timeoutMs }).catch((e: unknown) => {
      err = e instanceof Error ? e.message : String(e)
      return null
    })
    if (r?.exitCode === 0) return r.stdout
    if (r) err = r.stderr
    // A sign-in or access problem will not pass on a retry.
    if (gitError(err) !== 'GitHub not reachable') break
  }
  throw new Error(gitError(err))
}

/** The local clone, made on first use: a shallow copy, its commits signed "usage-guard". */
async function repo($: EngineInterface, st: SyncRepoState): Promise<string> {
  if (st.dir) return st.dir
  const origin = await $.process.run(['git', '-C', $.plugin.root, 'remote', 'get-url', 'origin']).catch(() => null)
  const url = origin?.exitCode === 0 ? syncUrl(origin.stdout) : null
  if (!url) throw new Error('reinstall with git clone (see README)')
  // A fixed folder next to Claude's own (the plugin's data folder is not given to every kind of install).
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) throw new Error('no home folder')
  const dir = `${home}/.claude/usage-guard-sync`
  const isClone = await $.process.run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree']).then(r => r.exitCode === 0).catch(() => false)
  if (!isClone) {
    await git($, ['clone', '-q', '--depth', '1', url, dir], true)
    await git($, ['-C', dir, 'config', 'user.name', 'usage-guard'])
    await git($, ['-C', dir, 'config', 'user.email', 'usage-guard@localhost'])
  }
  return (st.dir = dir)
}

/** Brings the local copy to GitHub's latest, throwing away anything local (only this plugin writes there). */
async function latest($: EngineInterface, dir: string) {
  await git($, ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', 'main'], true)
  await git($, ['-C', dir, 'reset', '-q', '--hard', 'origin/main'])
}

/**
 * One Claude session at a time uses the clone: several sessions on one PC each run this plugin.
 * shortcut: write-then-read-back, not an atomic lock; two sessions in the same millisecond can both pass, which
 * at worst costs one sync round (every write starts over from GitHub's latest).
 */
async function withLock<T>($: EngineInterface, dir: string, me: string, fn: () => Promise<T>): Promise<T> {
  const path = `${dir}.lock`
  const now = await $.clock.now()
  const held = await $.fs
    .read(path)
    .then(t => JSON.parse(t) as { owner?: string; t?: number })
    .catch(() => null)
  if (held?.owner && held.owner !== me && now - (held.t ?? 0) < 60_000) throw new Error(BUSY)
  await $.fs.write(path, JSON.stringify({ owner: me, t: now }))
  const mine = await $.fs.read(path).then(t => (JSON.parse(t) as { owner?: string }).owner === me).catch(() => false)
  if (!mine) throw new Error(BUSY)
  try {
    return await fn()
  } finally {
    await $.fs.write(path, JSON.stringify({ owner: '', t: 0 })).catch(() => undefined)
  }
}

/** Every PC's status and the shares, from GitHub's latest. */
export async function readSync($: EngineInterface, st: SyncRepoState): Promise<Pick<Sync, 'shares' | 'sharesAt' | 'sharesBy' | 'pcs'>> {
  return serial(st, async () => {
    const dir = await repo($, st)
    return withLock($, dir, st.session, () => readNow($, dir))
  })
}

async function readNow($: EngineInterface, dir: string) {
  await latest($, dir)
  const files: Record<string, string> = {}
  for (const f of await $.fs.list(dir)) {
    if (f.kind === 'file' && /^(pc-.+|shares)\.json$/.test(f.name)) files[f.name] = await $.fs.read(`${dir}/${f.name}`).catch(() => '')
  }
  return parseFiles(files)
}

/**
 * Writes the given files and pushes them. Each try starts from GitHub's latest, so the other PC's
 * newer files are kept and the push never conflicts; a push the other PC beat is simply tried again.
 */
export async function writeSync($: EngineInterface, st: SyncRepoState, files: Record<string, unknown>): Promise<void> {
  return serial(st, async () => {
    const dir = await repo($, st)
    return withLock($, dir, st.session, () => writeNow($, dir, files))
  })
}

async function writeNow($: EngineInterface, dir: string, files: Record<string, unknown>): Promise<void> {
  let err: unknown = null
  // The whole write is tried a few times more, for a push the other PC beat.
  for (let i = 0; i < 3; i++) {
    try {
      await latest($, dir)
      for (const [name, v] of Object.entries(files)) await $.fs.write(`${dir}/${name}`, JSON.stringify(v))
      await git($, ['-C', dir, 'add', '-A'])
      const changed = await $.process.run(['git', '-C', dir, 'diff', '--cached', '--quiet']).then(r => r.exitCode !== 0)
      if (!changed) return
      await git($, ['-C', dir, 'commit', '-q', '-m', Object.keys(files).join(' ')])
      await git($, ['-C', dir, 'push', '-q', 'origin', 'HEAD:main'], true)
      return
    } catch (e) {
      err = e
    }
  }
  throw err instanceof Error ? err : new Error('GitHub not reachable')
}
