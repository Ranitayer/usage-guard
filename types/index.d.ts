export type View = {
  /** 5-hour window % used (whole account), null before any reading. */
  pct: number | null
  resetsAt: string | null
  /** 7-day window % used, null before any reading. */
  week: number | null
  /** % of the 5-hour window used in the last 15 minutes (whole account). */
  pct15: number
  /** Tokens this PC used in the last 15 minutes / in the current 5-hour window. */
  tokens15: number
  out15: number
  tokensWindow: number
  /** % of the 5-hour window this PC used, this window / last 30 minutes. */
  mine: number
  mine30: number
  /** % the rest of the account (other PC, Chat, claude.ai) used in the last 30 minutes. */
  other30: number
  /** True once this PC has learned how much % a dollar of its usage is. */
  isCalibrated: boolean
  /** The 5-hour % over the window: [0..1 through the window, %]. */
  points: [number, number][]
  /** This session's cost at API prices, USD. */
  cost: number | null
}

export type Prefs = {
  /** Stop at this 5-hour %. */
  limit: number
  /** Split the limit with other use by recent work. */
  split: boolean
  /** Prompts go through until this time (ms). */
  snoozeUntil: number
  /** The next blocked prompt goes through once. */
  onePass: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': { view: View; prefs: Prefs }
  }
}
