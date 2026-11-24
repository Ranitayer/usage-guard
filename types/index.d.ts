export type View = {
  /** 5-hour window % used (whole account), null before any reading. */
  pct: number | null
  resetsAt: string | null
  /** 7-day window % used, null before any reading. */
  week: number | null
  /** Tokens this PC used in the last 15 minutes / in the current 5-hour window. */
  tokens15: number
  out15: number
  tokensWindow: number
  /** % of the 5-hour window this PC used: this window / last 15 minutes. */
  mine: number
  mine15: number
  /** True once a %-per-dollar rate is known (this PC's samples or the other PC's). */
  isCalibrated: boolean
  /** This PC's usage over the window: [0..1 through the window, %]. */
  points: [number, number][]
  /** This session's cost at API prices, USD. */
  cost: number | null
}

export type Prefs = {
  /** This PC's share of the 5-hour window in %, used until the synced shares say otherwise. */
  share: number
  /** Prompts go through until this time (ms). */
  snoozeUntil: number
  /** The next blocked prompt goes through once. */
  onePass: boolean
}

/** What one PC publishes to the shared gist. */
export type PcStatus = {
  /** When it last finished a turn (ms), 0 if never. */
  t: number
  /** Running a Claude turn right now. */
  busy: boolean
  /** When this status was written (ms). */
  updated: number
  /** % of the 5-hour window this PC used, for the window ending at resetsAt. */
  mine: number
  resetsAt: string | null
  /** Its %-per-dollar samples, so a new PC is calibrated at once. */
  samples: number[]
}

export type Sync = {
  /** This PC's name in the gist. */
  me: string | null
  /** Why syncing is off, or null while it works. */
  error: string | null
  /** When the gist was last read (ms), 0 if never. */
  at: number
  /** Share in % per PC name. */
  shares: Record<string, number>
  /** Every PC's status, this one included. */
  pcs: Record<string, PcStatus>
}

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': { view: View; prefs: Prefs; sync: Sync }
  }
}
