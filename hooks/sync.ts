import type { EngineInterface } from 'claude-code'

import type { PcStatus, Sync } from '../types'

/** The gist both PCs share is found by this description. */
export const GIST_DESCRIPTION = 'usage-guard sync'
const API = 'https://api.github.com'
const TIMEOUT = 8_000
// Some networks drop a share of connections to api.github.com: each call tries this many times, waiting this long each.
const TRIES = 3
const TRY_TIMEOUT = 4_000

export const EMPTY_SYNC: Sync = { me: null, error: null, at: 0, shares: {}, pcs: {} }

/** A PC name safe in a gist file name. */
export const pcName = (raw: string) => raw.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'pc'

const asNumber = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Reads one PC's file; anything malformed becomes a quiet, idle status. */
export function asStatus(text: string | undefined): PcStatus | null {
  try {
    const v = JSON.parse(text ?? '') as Partial<PcStatus>
    return {
      t: asNumber(v.t),
      busy: v.busy === true,
      updated: asNumber(v.updated),
      mine: Math.max(0, asNumber(v.mine)),
      resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : null,
      samples: Array.isArray(v.samples) ? v.samples.filter((x): x is number => typeof x === 'number' && x > 0 && Number.isFinite(x)).slice(-30) : [],
    }
  } catch {
    return null
  }
}

/** Shares file: only whole numbers 1..99 count. */
export function asShares(text: string | undefined): Record<string, number> {
  try {
    const v = JSON.parse(text ?? '') as { shares?: Record<string, unknown> }
    const out: Record<string, number> = {}
    for (const [k, n] of Object.entries(v.shares ?? {})) if (typeof n === 'number' && n >= 1 && n <= 99) out[pcName(k)] = Math.round(n)
    return out
  } catch {
    return {}
  }
}

/** The gist's files as the API gives them, into shares and statuses. */
export function parseGist(files: Record<string, { content?: string } | null>): Pick<Sync, 'shares' | 'pcs'> {
  const pcs: Record<string, PcStatus> = {}
  for (const [file, f] of Object.entries(files)) {
    const m = /^pc-(.+)\.json$/.exec(file)
    const s = m && f ? asStatus(f.content) : null
    if (m && s) pcs[m[1]!] = s
  }
  return { shares: asShares(files['shares.json']?.content), pcs }
}

/** Shares after this PC picks `share`: the rest is split evenly over the other PCs. */
export function sharesFor(me: string, share: number, others: string[]): Record<string, number> {
  const out: Record<string, number> = { [me]: share }
  for (const o of others) out[o] = Math.round((100 - share) / others.length)
  return out
}

/** What the gist calls remember between calls: the CLI's token (memory only, never stored) and the gist id. */
export type GistState = { token: string | null; id: string | null }

async function auth($: EngineInterface, st: GistState): Promise<string> {
  if (st.token) return st.token
  const r = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: TIMEOUT }).catch(() => null)
  if (!r) throw new Error('install GitHub CLI (gh)')
  if (r.exitCode !== 0 || r.stdout.trim() === '') throw new Error('run: gh auth login')
  st.token = r.stdout.trim()
  return st.token
}

async function call($: EngineInterface, st: GistState, path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const token = await auth($, st)
  let res: Awaited<ReturnType<EngineInterface['http']['fetch']>> | null = null
  for (let i = 0; i < TRIES && !res; i++) res = await attempt($, token, path, method, body).catch(() => null)
  if (!res) throw new Error('GitHub not reachable')
  return check($, st, path, res)
}

function attempt($: EngineInterface, token: string, path: string, method: string, body?: unknown) {
  return Promise.race([
    $.http.fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'usage-guard',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    new Promise<never>((_, reject) => $.clock.after(TRY_TIMEOUT, () => reject(new Error('GitHub not reachable')))),
  ])
}

async function check($: EngineInterface, st: GistState, path: string, res: Awaited<ReturnType<EngineInterface['http']['fetch']>>): Promise<unknown> {
  if (res.status === 401) {
    st.token = null
    throw new Error('run: gh auth login')
  }
  if (res.status === 404 && path.startsWith('/gists/')) {
    // The gist was deleted: find or make one again next time.
    st.id = null
    await $.store.delete('gistId')
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return JSON.parse(res.text)
}

/** The shared gist's id: remembered, found by description, or created (secret). */
async function gistId($: EngineInterface, st: GistState): Promise<string> {
  if (st.id) return st.id
  const stored = await $.store.get('gistId')
  if (typeof stored === 'string') return (st.id = stored)
  const list = (await call($, st, '/gists?per_page=100')) as { id: string; description: string | null; created_at: string }[]
  // The oldest one wins, so two PCs that created one at the same moment settle on the same gist.
  const found = list.filter(g => g.description === GIST_DESCRIPTION).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  const id =
    found?.id ??
    ((await call($, st, '/gists', 'POST', {
      description: GIST_DESCRIPTION,
      public: false,
      files: { 'shares.json': { content: JSON.stringify({ shares: {} }) } },
    })) as { id: string }).id
  await $.store.set('gistId', id)
  return (st.id = id)
}

/** Every PC's status and the shares, from the gist. */
export async function readGist($: EngineInterface, st: GistState): Promise<Pick<Sync, 'shares' | 'pcs'>> {
  const id = await gistId($, st)
  const g = (await call($, st, `/gists/${id}`)) as { files: Record<string, { content?: string } | null> }
  return parseGist(g.files)
}

/** Writes only the files given; the other PC's files are left alone. */
export async function writeGist($: EngineInterface, st: GistState, files: Record<string, unknown>): Promise<void> {
  const id = await gistId($, st)
  const body: Record<string, { content: string }> = {}
  for (const [name, v] of Object.entries(files)) body[name] = { content: JSON.stringify(v) }
  await call($, st, `/gists/${id}`, 'PATCH', { files: body })
}
