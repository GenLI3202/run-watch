export type WatchStatus = 'running' | 'stalled' | 'done' | 'failed' | 'lost'

export type Watch = {
  id: number
  name: string
  path: string
  pid?: number
  /** A regex source: the run is done when the log tail matches it. */
  done?: string
  /** A regex source: the run failed when the log tail matches it. */
  fail?: string
  /** A regex source with one capture (percent) or two (done and total). */
  progress?: string
  /** Minutes without a new byte before the run counts as stalled. */
  stallMin: number
  status: WatchStatus
  createdAt: number
  /** The first progress seen, for the rate behind the ETA. */
  firstFrac?: number
  firstAt?: number
  frac?: number
  lastSize: number
  lastGrowAt: number
  /** Whether the finish, failure or stall has been told already. */
  isTold: boolean
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'run-watch': { watches: Shaped<Watch[]>; now: number }
  }
}
