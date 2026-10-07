// keepwarm — keeps an idle interactive session's prompt cache warm.
//
// The prompt cache of a session lives one hour from the START of the last request that read it.
// While the session works, every request refreshes it; only idle gaps (you away, or the main thread
// blocked past the hour on one long subagent) let it lapse, and the next message then rewrites the
// whole transcript at the cache-write price (2x input on the 1-hour TTL) instead of reading it
// (0.05x on Opus 5.5). So, once the main thread has sent nothing for IDLE minutes, this mod sends one
// tool-less fork of the session's own transcript ($.model.fork): the API serves that prefix from the
// cache, which restarts its hour, and nothing joins the conversation.
//
//   prompt.submit   → a request is about to start (and, for the person's own prompt, the 20 h clock restarts)
//   tool.call       → after a MAIN-thread tool returns, the next request starts at once
//   session.start   → interactive sessions only: the 30 s tick, the /keepwarm command, the status line
//   command.run     → /keepwarm on | off | status, per session
//
// A refresh that gets no reply (an API error such as 429/529, a dropped connection, an abort) did not
// touch the cache: the idle clock is left where it was, so the next tick (30 s on) tries again, until
// the TTL is reached. Stops (until the next prompt) when: the person has not prompted for MAX hours;
// the idle gap already reached the TTL (the laptop slept, or every retry failed), so a refresh would
// pay a full write; a refresh reports the cache had lapsed (it read almost nothing); or there is no
// reply to fork yet. Turns itself off for the rest of the session when a refresh inside the hour had to
// write more than it read: the fork cannot reach this session's cache (measured on threaded requests,
// where the server keeps the conversation), so refreshing would only add a write. Never runs headless.
//
// Visible without debug mode: the status line under the prompt (last refresh, retrying, paused),
// /keepwarm status, and ~/.claude/state/keepwarm/<session id>.json (rewritten at session start, on every
// refresh, failure, pause and /keepwarm command, and every 5 min while the session works).
// Env: KEEPWARM_OFF (any value) disables; KEEPWARM_IDLE_MIN (57), KEEPWARM_TTL_MIN (60),
// KEEPWARM_MAX_HOURS (20), KEEPWARM_PROMPT (the ping text) override the defaults.

import type { EngineInterface, HookFailure, Register } from 'claude-code'

import type { KeepwarmBeat, KeepwarmFailure, KeepwarmSession } from '../types'

type Engine = EngineInterface

const SESSION = { plugin: 'keepwarm', key: 'session' } as const
const MIN = 60_000
const VERSION = '0.3.1'

export const PING = 'Cache keep-alive ping, not a task. Reply with exactly: .'
export const DEFAULTS = { idleMin: 57, ttlMin: 60, maxHours: 20, tickMs: 30_000, deadRead: 1_000, keptBeats: 50 }

export type Config = { idleMs: number; ttlMs: number; maxMs: number; prompt: string; isOff: boolean }
export type Due = { kind: 'wait' } | { kind: 'beat' } | { kind: 'stop'; why: string }

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function config($: Engine): Promise<Config> {
  const off = await $.env.get('KEEPWARM_OFF')
  const prompt = await $.env.get('KEEPWARM_PROMPT')
  return {
    idleMs: positive(await $.env.get('KEEPWARM_IDLE_MIN'), DEFAULTS.idleMin) * MIN,
    ttlMs: positive(await $.env.get('KEEPWARM_TTL_MIN'), DEFAULTS.ttlMin) * MIN,
    maxMs: positive(await $.env.get('KEEPWARM_MAX_HOURS'), DEFAULTS.maxHours) * 60 * MIN,
    prompt: prompt !== undefined && prompt !== '' ? prompt : PING,
    isOff: off !== undefined && off !== '',
  }
}

/** A new session's state; also the defaults a state written by an older version is filled from. */
export function fresh(now: number, isInteractive: boolean): KeepwarmSession {
  return {
    isEnabled: true,
    isInteractive,
    lastRequestAt: now,
    lastPromptAt: now,
    stoppedBecause: '',
    offBecause: '',
    beats: [],
    failStreak: 0,
    lastFailure: null,
  }
}

/**
 * The state session.start keeps: a new session's, or the held one with any field an older version of
 * this mod did not write filled in (a hot reload keeps $.state). Pure, for the tests.
 */
export function upgrade(held: Partial<KeepwarmSession> | undefined, now: number, isInteractive: boolean): KeepwarmSession {
  return { ...fresh(now, isInteractive), ...held, isInteractive }
}

/** "API error 529 overloaded", "aborted". Pure, for the tests. */
export function describeFailure(f: KeepwarmFailure): string {
  if (f.reason !== 'api-error') return f.reason
  return `API error ${f.status ?? '(no response)'}${f.error !== '' ? ` ${f.error}` : ''}`
}

/** What the tick should do now. Pure, for the tests. */
export function decide(s: KeepwarmSession, now: number, cfg: Config): Due {
  if (!s.isInteractive || !s.isEnabled || cfg.isOff || s.offBecause !== '' || s.stoppedBecause !== '') return { kind: 'wait' }
  if (now - s.lastPromptAt >= cfg.maxMs) {
    return { kind: 'stop', why: `no prompt from you for ${Math.round(cfg.maxMs / (60 * MIN))} h` }
  }
  const idle = now - s.lastRequestAt
  if (idle < cfg.idleMs) return { kind: 'wait' }
  if (idle >= cfg.ttlMs) {
    const why =
      s.failStreak > 0 && s.lastFailure !== null
        ? `${s.failStreak} refresh${s.failStreak === 1 ? '' : 'es'} failed (last: ${describeFailure(s.lastFailure)}) and the cache lapsed`
        : 'the cache had already lapsed before a refresh could run'
    return { kind: 'stop', why }
  }
  return { kind: 'beat' }
}

async function load($: Engine): Promise<KeepwarmSession | undefined> {
  return (await $.state.get(SESSION)).value
}

async function change($: Engine, fn: (s: KeepwarmSession) => KeepwarmSession): Promise<KeepwarmSession | undefined> {
  const held = await $.state.get(SESSION)
  if (held.value === undefined) return undefined
  const next = fn(held.value)
  await $.state.set(SESSION, next)
  return next
}

// ---- visibility ---------------------------------------------------------------------------------

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/**
 * The status line under the prompt (the engine shows it after "keepwarm: "); undefined shows none.
 * Pure, for the tests.
 */
export function statusBar(s: KeepwarmSession, cfg: Config): string | undefined {
  if (!s.isInteractive) return undefined
  if (cfg.isOff) return 'off (KEEPWARM_OFF)'
  if (!s.isEnabled) return 'off'
  if (s.offBecause !== '') return "off: this session's cache can't be refreshed"
  if (s.stoppedBecause !== '') return `paused: ${s.stoppedBecause}`
  if (s.failStreak > 0 && s.lastFailure !== null) {
    return `retrying (${describeFailure(s.lastFailure)} at ${hhmm(s.lastFailure.at)})`
  }
  const last = s.beats.at(-1)
  if (last === undefined) return 'on, no refresh yet'
  return `last refresh ${hhmm(last.at)}, read ${kTokens(last.cacheRead)} cached`
}

let shownBar: string | undefined | null = null // null: nothing shown yet by this environment

function showBar($: Engine, s: KeepwarmSession, cfg: Config): void {
  const text = statusBar(s, cfg)
  if (text === shownBar) return
  shownBar = text
  $.ui.status(text)
}

let sessionId = ''
let statePath = ''
let cwd = ''
// the request time and clock time the state file was last written with, so a tick can bring a stale file
// up to date (at most every REWRITE_MS) without a write on every prompt or tool call
let persistedRequestAt = 0
let persistedAt = 0
const REWRITE_MS = 5 * MIN

async function persist($: Engine, s: KeepwarmSession, cfg: Config, now: number): Promise<void> {
  if (statePath === '') return
  const record = {
    version: VERSION,
    sessionId,
    cwd,
    updatedAt: new Date(now).toISOString(),
    status: statusLine(s, now, cfg),
    nextRefreshAt:
      s.stoppedBecause === '' && s.offBecause === '' && s.isEnabled && !cfg.isOff ? new Date(s.lastRequestAt + cfg.idleMs).toISOString() : null,
    config: { idleMin: cfg.idleMs / MIN, ttlMin: cfg.ttlMs / MIN, maxHours: cfg.maxMs / (60 * MIN) },
    lastRefresh: s.beats.at(-1) ?? null,
    lastFailure: s.lastFailure,
    session: { ...s, beats: s.beats.slice(-10) },
  }
  persistedRequestAt = s.lastRequestAt
  persistedAt = now
  await $.fs
    .write(statePath, `${JSON.stringify(record, null, 2)}\n`)
    .catch(err => $.ui.log(`keepwarm: state file not written: ${String(err)}`, { to: 'debug' }))
}

/** Status line + state file, after anything that changed what they show. */
async function publish($: Engine, s: KeepwarmSession | undefined, cfg: Config, now: number): Promise<void> {
  if (s === undefined) return
  showBar($, s, cfg)
  await persist($, s, cfg, now)
}

// ---- the tick -----------------------------------------------------------------------------------

let isRefreshing = false

async function tick($: Engine): Promise<void> {
  if (isRefreshing) return
  const s = await load($)
  if (s === undefined) return
  const cfg = await config($)
  const now = await $.clock.now()
  const due = decide(s, now, cfg)
  if (due.kind === 'wait') {
    // the session is working: keep the state file's last request and next refresh within REWRITE_MS of true
    if (s.lastRequestAt !== persistedRequestAt && now - persistedAt >= REWRITE_MS) await persist($, s, cfg, now)
    return
  }
  if (due.kind === 'stop') {
    const after = await change($, x => ({ ...x, stoppedBecause: due.why }))
    $.ui.log(`keepwarm: paused until your next prompt: ${due.why}`, { to: 'debug' })
    await publish($, after, cfg, now)
    return
  }
  isRefreshing = true
  try {
    const r = await $.model.fork({ prompt: cfg.prompt })
    if (!r.isAnswered && r.reason === 'nothing-to-fork') {
      const why = 'nothing to keep warm yet (this conversation has no reply)'
      const after = await change($, x => ({ ...x, stoppedBecause: why }))
      $.ui.log(`keepwarm: paused until your next prompt: ${why}`, { to: 'debug' })
      await publish($, after, cfg, now)
      return
    }
    if (!r.isAnswered && (r.reason === 'api-error' || r.reason === 'aborted')) {
      // no reply, so no proof the cache was read: leave the idle clock alone and retry at the next tick
      const failure: KeepwarmFailure =
        r.reason === 'api-error'
          ? { at: now, reason: r.reason, status: r.status, error: String(r.error) }
          : { at: now, reason: r.reason, status: null, error: '' }
      const after = await change($, x => ({ ...x, failStreak: x.failStreak + 1, lastFailure: failure }))
      $.ui.log(
        `keepwarm: refresh failed (${describeFailure(failure)}); try ${after?.failStreak ?? '?'}, retrying at the next tick`,
        { to: 'debug' },
      )
      await publish($, after, cfg, now)
      return
    }
    // answered, or a reply with no text: the request reached the API and its usage is the cache's
    const usage = r.usage
    const beat: KeepwarmBeat = {
      at: now,
      cacheRead: usage.cache_read_input_tokens,
      input: usage.input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      output: usage.output_tokens,
    }
    const hasLapsed = beat.cacheRead < DEFAULTS.deadRead
    const after = await change($, x => afterRefresh(x, beat, now))
    $.ui.log(
      `keepwarm: refresh cache_read=${beat.cacheRead} input=${beat.input} cache_write=${beat.cacheWrite} ` +
        `output=${beat.output} answered=${r.isAnswered}${cannotRead(beat) ? ' (could not reach the session cache: off for this session)' : hasLapsed ? ' (cache had lapsed: paused)' : ''}`,
      { to: 'debug' },
    )
    await publish($, after, cfg, now)
  } finally {
    isRefreshing = false
  }
}

/** The state after a refresh that reached the API (its request started at `sentAt`). Pure, for the tests. */
export function afterRefresh(x: KeepwarmSession, beat: KeepwarmBeat, sentAt: number): KeepwarmSession {
  return {
    ...x,
    // a prompt that entered while the fork ran is newer: keep it
    lastRequestAt: Math.max(x.lastRequestAt, sentAt),
    failStreak: 0,
    beats: [...x.beats, beat].slice(-DEFAULTS.keptBeats),
    ...(cannotRead(beat)
      ? {
          offBecause:
            `a refresh inside the hour read ${beat.cacheRead.toLocaleString('en-US')} cached tokens and had to write ` +
            `${beat.cacheWrite.toLocaleString('en-US')}: it could not reach this session's own cache, so refreshing only adds cost`,
        }
      : beat.cacheRead < DEFAULTS.deadRead && { stoppedBecause: 'a refresh found the cache already lapsed' }),
  }
}

/**
 * A refresh that wrote more of the conversation than it read did not find this session's cache. Every
 * session shares a warm system-and-tools prefix (~26-29k tokens), so a miss reads that much and writes the
 * rest; a refresh that found the session's cache writes only the last turn (0-1,300 tokens measured).
 * Pure, for the tests.
 */
export function cannotRead(beat: KeepwarmBeat): boolean {
  return beat.cacheWrite > beat.cacheRead
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** What /keepwarm status answers with. Pure, for the tests. */
export function statusLine(s: KeepwarmSession, now: number, cfg: Config): string {
  const read = s.beats.reduce((n, b) => n + b.cacheRead, 0)
  const tally = `${s.beats.length} refresh${s.beats.length === 1 ? '' : 'es'} this session, ${read.toLocaleString('en-US')} cached tokens read`
  const last = s.beats.at(-1)
  const lastText =
    last === undefined
      ? 'No refresh yet'
      : `Last refresh ${hhmm(last.at)} (${ago(now - last.at)} ago): read ${last.cacheRead.toLocaleString('en-US')} cached tokens, wrote ${last.cacheWrite.toLocaleString('en-US')}`
  const failText =
    s.failStreak > 0 && s.lastFailure !== null
      ? ` Last failure ${hhmm(s.lastFailure.at)}: ${describeFailure(s.lastFailure)} (${s.failStreak} in a row; retrying every ${DEFAULTS.tickMs / 1000} s until ${hhmm(s.lastRequestAt + cfg.ttlMs)}).`
      : ''
  const facts = `${lastText}.${failText} ${tally}.`
  if (!s.isInteractive) return 'off (not an interactive session).'
  if (cfg.isOff) return `off (KEEPWARM_OFF is set). ${facts}`
  if (!s.isEnabled) return `off for this session (/keepwarm on to resume). ${facts}`
  if (s.offBecause !== '') return `off for this session: ${s.offBecause}. /keepwarm on to try again. ${facts}`
  if (s.stoppedBecause !== '') return `paused until your next prompt (${s.stoppedBecause}). ${facts}`
  const dueIn = s.lastRequestAt + cfg.idleMs - now
  const next = dueIn > 0 ? `next refresh in ${ago(dueIn)} (${hhmm(s.lastRequestAt + cfg.idleMs)})` : 'refresh due now'
  return `on. Last request ${ago(now - s.lastRequestAt)} ago, ${next}; stops ${ago(s.lastPromptAt + cfg.maxMs - now)} from now without a prompt. ${facts}`
}

let timer: { cancel: () => void } | undefined

/**
 * The bookkeeping after `next` in prompt.submit and tool.call must never stand in for the prompt or the
 * tool. The engine already skips a failed hook and keeps what `next` settled to, but reports the failure
 * on every prompt or tool call; the .catch on each logs it to the debug log instead and passes `next` on.
 */
function logSkipped($: Engine, hook: string, error: HookFailure): void {
  // a re-entry ran nothing of ours, and its $ calls reject
  if (error.kind === 're-entry') return
  const why = error.message !== undefined ? `${error.kind}: ${error.message}` : error.kind
  $.ui.log(`keepwarm: ${hook} bookkeeping skipped (${why})`, { to: 'debug' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const held = await load($)
    const s = upgrade(held, now, e.isInteractive)
    await $.state.set(SESSION, s)
    if (e.isInteractive) {
      await $.command
        .register({ name: 'keepwarm', description: "Keep this idle session's prompt cache warm: /keepwarm on | off | status" })
        .catch(err => $.ui.log(`keepwarm: command not registered: ${String(err)}`, { to: 'debug' }))
      timer?.cancel()
      timer = $.clock.every(DEFAULTS.tickMs, () => {
        void tick($).catch(err => $.ui.log(`keepwarm: tick failed: ${String(err)}`, { to: 'debug' }))
      })
      try {
        cwd = e.cwd
        sessionId = await $.session.id()
        const home = await $.env.get('HOME')
        statePath = home !== undefined && sessionId !== '' ? `${home}/.claude/state/keepwarm/${sessionId}.json` : ''
      } catch (err) {
        $.ui.log(`keepwarm: no state file: ${String(err)}`, { to: 'debug' })
      }
      shownBar = null
      await publish($, s, await config($), now)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    if (r.drop === undefined) {
      const now = await $.clock.now()
      const isPerson = e.origin === undefined || e.origin.kind === 'composer'
      // any prompt that enters starts a request, which re-warms the cache, so a pause lifts
      const before = await load($)
      const after = await change($, s => ({
        ...s,
        lastRequestAt: now,
        stoppedBecause: '',
        failStreak: 0,
        ...(isPerson && { lastPromptAt: now }),
      }))
      if (after !== undefined && before !== undefined && (before.stoppedBecause !== '' || before.failStreak > 0)) {
        await publish($, after, await config($), now)
      }
    }
    return r
  }).catch(($, e, next) => {
    logSkipped($, 'prompt.submit', next.error)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // a subagent's requests carry its own transcript and never refresh the main thread's cache
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await change($, s => ({ ...s, lastRequestAt: now }))
    }
    return ran
  }).catch(($, e, next) => {
    logSkipped($, 'tool.call', next.error)
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const s = await load($)
    if (s === undefined) return { text: 'not active in this session.' }
    const word = e.args.trim().toLowerCase()
    const now = await $.clock.now()
    const cfg = await config($)
    if (word === 'off') {
      await publish($, await change($, x => ({ ...x, isEnabled: false })), cfg, now)
      return { text: 'off for this session.' }
    }
    if (word === 'on') {
      await publish($, await change($, x => ({ ...x, isEnabled: true, stoppedBecause: '', offBecause: '' })), cfg, now)
      return { text: 'on for this session.' }
    }
    const where = statePath !== '' ? ` State file: ${statePath}` : ''
    return { text: `${statusLine(s, now, cfg)}${where}` }
  })
}
