// Session-scoped state of the keepwarm mod (survives hot reloads, not sessions).
export type KeepwarmBeat = {
  /** Epoch ms when the refresh request was sent. */
  at: number
  /** Prompt-cache tokens the fork read: the transcript the cache still held. */
  cacheRead: number
  /** Uncached input, cache writes and generated tokens of the fork. */
  input: number
  cacheWrite: number
  output: number
}

/** A refresh that reached no reply: an API error (with its HTTP status and kind) or an abort. */
export type KeepwarmFailure = {
  /** Epoch ms when the failed refresh was sent. */
  at: number
  reason: string
  /** HTTP status of an API error; null when no response arrived or not an API error. */
  status: number | null
  /** Claude Code's word for the API error (`overloaded`, `rate_limit`, ...); '' when not an API error. */
  error: string
}

export type KeepwarmSession = {
  /** /keepwarm off sets false for this session; default true. */
  isEnabled: boolean
  /** session.start's isInteractive; headless sessions never refresh. */
  isInteractive: boolean
  /** Epoch ms when the main thread last SENT a model request (prompt entered, a main tool result returned, or a refresh that reached the API). */
  lastRequestAt: number
  /** Epoch ms of the person's last own prompt; the 20 h deadline counts from here. */
  lastPromptAt: number
  /** Why refreshing stopped until the next prompt, or '' while active. */
  stoppedBecause: string
  /**
   * Why keepwarm turned itself off for the rest of this session, or ''. Set when a refresh inside the hour
   * had to write more of the conversation than it could read: the session's own cache is not one a fork
   * can reach (seen on threaded requests), so refreshing only adds cost. /keepwarm on clears it.
   */
  offBecause: string
  beats: KeepwarmBeat[]
  /** Failed refreshes since the last request that reached the API; each is retried at the next tick. */
  failStreak: number
  /** The most recent failed refresh, kept for /keepwarm status. */
  lastFailure: KeepwarmFailure | null
}

declare module 'claude-code' {
  interface PluginState {
    keepwarm: {
      session: KeepwarmSession
    }
  }
}
