// Unit tests for keepwarm. The engine beneath the plugin is stood in for: prompt.submit echoes the
// prompt, tool.call answers 'done', model.fork answers with the usage each test sets (or, for the
// failure injection, with the results queued in `w.failNext`); the clock is the kit's mock, so a
// test moves time and the 30 s tick runs as it would. fs.write and ui.status are captured.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

import { PING, afterRefresh, cannotRead, decide, describeFailure, statusBar, statusLine, upgrade } from '../hooks/register'
import type { Config } from '../hooks/register'
import type { KeepwarmSession } from '../types'

const MIN = 60_000
const T0 = Date.parse('2026-10-02T12:00:00Z')
const STATE_FILE = '/home/tester/.claude/state/keepwarm/sid-1.json'
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const OVERLOADED: ModelForkResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
const ABORTED: ModelForkResult = { isAnswered: false, reason: 'aborted', usage: ZERO }

type World = {
  forks: number[] // the mock clock's time of each fork
  pings: string[] // each fork's prompt
  cacheRead: number
  cacheWrite: number
  env: Record<string, string>
  /** Results the next forks answer with, in order, before the normal reply; `always` repeats one. */
  failNext: ModelForkResult[]
  always: ModelForkResult | undefined
  files: Record<string, string>
  writes: number
  bar: (string | undefined)[]
  logs: string[]
  duringFork: (() => Promise<unknown>) | undefined
}

function world(on: On, init: Partial<World> = {}) {
  const w: World = { forks: [], pings: [], cacheRead: 250_000, cacheWrite: 0, env: {}, failNext: [], always: undefined, files: {}, writes: 0, bar: [], logs: [], duringFork: undefined, ...init }
  mock.env(on, { HOME: '/home/tester', ...w.env })
  const clock = mock.clock(on, { now: T0 })
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.bar.push(e.text)
    return { value: undefined }
  })
  on('fs.write', ($, e) => {
    w.writes += 1
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'done', text: 'done' }))
  on('model.fork', async ($, e) => {
    w.forks.push(clock.now())
    w.pings.push(e.prompt)
    if (w.duringFork !== undefined) await w.duringFork()
    const queued = w.failNext.shift() ?? w.always
    if (queued !== undefined) return { value: queued }
    return {
      value: {
        isAnswered: true as const,
        text: '.',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: w.cacheRead, cache_creation_input_tokens: w.cacheWrite },
      },
    }
  })
  return { w, clock }
}

function raise($: Engine) {
  return {
    start: (isInteractive = true) =>
      $.session.start({ cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive }),
    prompt: (kind: 'composer' | 'plugin' = 'composer') =>
      $.prompt.submit({
        text: 'hi',
        wait: false,
        origin: kind === 'composer' ? { kind: 'composer' } : { kind: 'plugin', name: 'other' },
      }),
    tool: (agentId?: string) => $.tool.call({ tool: 'Bash' as const, command: 'true', ...(agentId !== undefined && { agentId }) }),
    command: (args: string) =>
      $.command.run({ command: 'keepwarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }),
  }
}

const minutes = (w: World) => w.forks.map(t => (t - T0) / MIN)

test('refreshes once at 57 min of main-thread silence, with the ping, then again 57 min later', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  await raise($).prompt()
  await clock.advance(56 * MIN)
  expect(w.forks).toHaveLength(0)
  await clock.advance(1.5 * MIN)
  expect(w.pings).toEqual([PING])
  await clock.advance(56 * MIN)
  expect(w.forks).toHaveLength(1)
  await clock.advance(1.5 * MIN)
  expect(w.forks).toHaveLength(2)
})

test('a main-thread tool result restarts the idle clock; a subagent tool call does not', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  await raise($).prompt()
  await clock.advance(30 * MIN)
  await raise($).tool('agent-7')
  await clock.advance(28 * MIN)
  expect(w.forks).toHaveLength(1) // 58 min after the prompt: the subagent call did not count
  await raise($).prompt()
  await clock.advance(30 * MIN)
  await raise($).tool()
  await clock.advance(30 * MIN)
  expect(w.forks).toHaveLength(1) // 60 min after the prompt, 30 after a main tool result
  await clock.advance(28 * MIN)
  expect(w.forks).toHaveLength(2)
})

test('a failure in the bookkeeping after a prompt or a tool call is logged; the prompt and the tool result pass', async ($, on) => {
  const { w } = world(on)
  let isStoreDown = false
  on('state.set', ($, e, next) => (isStoreDown ? { deny: 'store down' } : next(e)))
  await raise($).start()
  isStoreDown = true
  expect(await raise($).prompt()).toEqual(expect.objectContaining({ text: 'hi' }))
  expect(await raise($).tool()).toEqual(expect.objectContaining({ result: 'done' }))
  expect(w.logs.filter(l => l.includes('bookkeeping skipped'))).toHaveLength(2)
})

test('never runs in a headless session', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start(false)
  await raise($).prompt()
  await clock.advance(3 * 60 * MIN)
  expect(w.forks).toHaveLength(0)
})

test('KEEPWARM_OFF disables it', async ($, on) => {
  const { w, clock } = world(on, { env: { KEEPWARM_OFF: '1' } })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(2 * 60 * MIN)
  expect(w.forks).toHaveLength(0)
})

test('KEEPWARM_IDLE_MIN and KEEPWARM_PROMPT override the defaults', async ($, on) => {
  const { w, clock } = world(on, { env: { KEEPWARM_IDLE_MIN: '1', KEEPWARM_PROMPT: 'ping' } })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(1.5 * MIN)
  expect(w.pings).toEqual(['ping'])
})

test('a refresh that finds the cache lapsed pauses until the next prompt', async ($, on) => {
  const { w, clock } = world(on, { cacheRead: 0 })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(58 * MIN)
  expect(w.forks).toHaveLength(1)
  await clock.advance(3 * 60 * MIN)
  expect(w.forks).toHaveLength(1)
  w.cacheRead = 250_000
  await raise($).prompt()
  await clock.advance(58 * MIN)
  expect(w.forks).toHaveLength(2)
})

test('a gap already past the hour (nothing could refresh in time) pauses instead of paying a full rewrite', async ($, on) => {
  // an idle mark past the TTL stands in for a laptop that slept through the refresh: the first tick
  // that can act finds the gap at or past the hour
  const { w, clock } = world(on, { env: { KEEPWARM_IDLE_MIN: '61' } })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(62 * MIN)
  expect(w.forks).toHaveLength(0)
  expect((await raise($).command('status')).text).toContain('paused until your next prompt')
})

test('stops 20 h after your last own prompt; a plugin prompt does not extend it', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  await raise($).prompt()
  await clock.advance(10 * 60 * MIN)
  await raise($).prompt('plugin')
  await clock.advance(12 * 60 * MIN)
  // 22 h after the person's prompt: refreshes ran up to the 20 h mark and no further
  const at20 = w.forks.length
  await clock.advance(5 * 60 * MIN)
  expect(w.forks.length).toBe(at20)
  expect(at20).toBeGreaterThan(15)
})

test('/keepwarm off and on, per session; status names the next refresh', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  await raise($).prompt()
  expect((await raise($).command('off')).text).toBe('off for this session.')
  await clock.advance(2 * 60 * MIN)
  expect(w.forks).toHaveLength(0)
  await raise($).prompt()
  expect((await raise($).command('on')).text).toBe('on for this session.')
  await clock.advance(10 * MIN)
  expect((await raise($).command('status')).text).toContain('next refresh in 47 min')
  await clock.advance(48 * MIN)
  expect(w.forks).toHaveLength(1)
})

// ---- failure injection: a refresh that gets no reply is retried, never read as a lapsed cache ----

test('an API error on a refresh is retried at the next tick, not read as a lapsed cache', async ($, on) => {
  const { w, clock } = world(on, { failNext: [OVERLOADED] })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(57.25 * MIN) // the tick at 57.0 → 529
  expect(minutes(w)).toEqual([57])
  expect(w.bar.at(-1)).toContain('retrying (API error 529 overloaded at ')
  const mid = (await raise($).command('status')).text ?? ''
  expect(mid).toContain('Last failure')
  expect(mid).toContain('1 in a row')
  expect(mid).not.toContain('paused')
  await clock.advance(0.5 * MIN) // the tick at 57.5 → retried, answered
  expect(minutes(w)).toEqual([57, 57.5])
  const after = (await raise($).command('status')).text ?? ''
  expect(after).toMatch(/^on\. /)
  expect(after).toContain('read 250,000 cached tokens')
  expect(after).not.toContain('Last failure')
  // the next refresh counts 57 min from the retry that reached the API, not from the failed try
  await clock.advance(56.5 * MIN) // 57.75 → 114.25
  expect(w.forks).toHaveLength(2)
  await clock.advance(0.5 * MIN)
  expect(minutes(w)).toEqual([57, 57.5, 114.5])
})

test('an aborted refresh is retried the same way', async ($, on) => {
  const { w, clock } = world(on, { failNext: [ABORTED, ABORTED] })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(58.5 * MIN)
  expect(minutes(w)).toEqual([57, 57.5, 58])
  expect((await raise($).command('status')).text).toMatch(/^on\. /)
})

test('refreshes that keep failing stop at the TTL and name the failure; a prompt resumes', async ($, on) => {
  const { w, clock } = world(on, { always: OVERLOADED })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(65 * MIN)
  expect(minutes(w)).toEqual([57, 57.5, 58, 58.5, 59, 59.5]) // every tick inside [57, 60)
  const text = (await raise($).command('status')).text ?? ''
  expect(text).toContain('paused until your next prompt (6 refreshes failed (last: API error 529 overloaded) and the cache lapsed)')
  expect(w.bar.at(-1)).toContain('paused: 6 refreshes failed')
  w.always = undefined
  await raise($).prompt()
  expect(w.bar.at(-1)).toBe('on, no refresh yet')
  await clock.advance(57.5 * MIN)
  expect(w.forks).toHaveLength(7)
  expect((await raise($).command('status')).text).toMatch(/^on\. /)
})

test('nothing to fork yet (no reply in the conversation) pauses until the next prompt', async ($, on) => {
  const { w, clock } = world(on, { failNext: [{ isAnswered: false, reason: 'nothing-to-fork' }] })
  await raise($).start()
  await clock.advance(60 * MIN)
  expect(w.forks).toHaveLength(1)
  expect((await raise($).command('status')).text).toContain('nothing to keep warm yet')
  await raise($).prompt()
  await clock.advance(57.5 * MIN)
  expect(w.forks).toHaveLength(2)
})

test('a reply with no text still counts as a refresh: it read the cache', async ($, on) => {
  const usage = { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 }
  const { w, clock } = world(on, { failNext: [{ isAnswered: false, reason: 'empty-reply', usage }] })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(57.5 * MIN)
  expect(w.forks).toHaveLength(1)
  const text = (await raise($).command('status')).text ?? ''
  expect(text).toMatch(/^on\. /)
  expect(text).toContain('read 120,000 cached tokens')
})

// ---- a refresh that cannot reach the session's cache (measured on threaded requests) ----------------

test('a refresh that had to write more than it read turns keepwarm off for the session, until /keepwarm on', async ($, on) => {
  // the numbers of a measured session (threaded Opus 5.5 requests) at its 57-min refresh
  const { w, clock } = world(on, { cacheRead: 28_876, cacheWrite: 29_256 })
  await raise($).start()
  await raise($).prompt()
  await clock.advance(57.5 * MIN)
  expect(w.forks).toHaveLength(1)
  expect(w.bar.at(-1)).toBe("off: this session's cache can't be refreshed")
  const text = (await raise($).command('status')).text ?? ''
  expect(text).toContain('off for this session: a refresh inside the hour read 28,876 cached tokens and had to write 29,256')
  // a prompt does not lift it (unlike a pause): the next idle stretch would pay the same write again
  await raise($).prompt()
  await clock.advance(3 * 60 * MIN)
  expect(w.forks).toHaveLength(1)
  w.cacheWrite = 0
  expect((await raise($).command('on')).text).toBe('on for this session.')
  await raise($).prompt()
  await clock.advance(57.5 * MIN)
  expect(w.forks).toHaveLength(2)
  expect((await raise($).command('status')).text).toMatch(/^on\. /)
})

test('cannotRead: the shared-prefix miss trips it; a real refresh (last turn written) does not', async () => {
  const b = (cacheRead: number, cacheWrite: number) => ({ at: T0, cacheRead, input: 30, cacheWrite, output: 3 })
  expect(cannotRead(b(28_876, 29_256))).toBe(true) // the measured threaded session above
  expect(cannotRead(b(28_876, 593_213))).toBe(true) // a real 600k session's miss
  expect(cannotRead(b(430_620, 356))).toBe(false) // a measured refresh on stateless requests
  expect(cannotRead(b(505_925, 1_277))).toBe(false) // another measured refresh
  expect(cannotRead(b(0, 0))).toBe(false) // nothing at all: the lapsed pause handles it
})

// ---- visibility -----------------------------------------------------------------------------------

test('the status line and the state file show the last refresh', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  expect(w.bar).toEqual(['on, no refresh yet'])
  expect(JSON.parse(w.files[STATE_FILE] ?? '{}').version).toBe('0.3.1')
  await raise($).prompt()
  await clock.advance(57.5 * MIN)
  expect(w.bar.at(-1)).toMatch(/^last refresh \d\d:\d\d, read 250k cached$/)
  const file = JSON.parse(w.files[STATE_FILE] ?? '{}')
  expect(file.sessionId).toBe('sid-1')
  expect(file.cwd).toBe('/work')
  expect(file.lastRefresh.cacheRead).toBe(250_000)
  expect(file.lastRefresh.at).toBe(T0 + 57 * MIN)
  expect(file.status).toMatch(/^on\. /)
  expect(file.nextRefreshAt).toBe(new Date(T0 + 114 * MIN).toISOString())
  const text = (await raise($).command('status')).text ?? ''
  expect(text).toContain('Last refresh')
  expect(text).toContain(`State file: ${STATE_FILE}`)
  expect(text.startsWith('keepwarm:')).toBe(false) // the engine already prefixes the plugin's name
})

test('the state file follows a working session within 5 min, and is not rewritten while nothing moves', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start() // write 1, at T0
  await clock.advance(10 * MIN)
  expect(w.writes).toBe(1) // idle since the start: nothing moved, no rewrite
  await raise($).prompt() // T0 + 10
  await clock.advance(0.75 * MIN) // the tick at 10.5 sees a moved clock and a file 10.5 min old
  expect(w.writes).toBe(2)
  expect(JSON.parse(w.files[STATE_FILE] ?? '{}').session.lastRequestAt).toBe(T0 + 10 * MIN)
  await raise($).prompt() // T0 + 10.75
  await clock.advance(4 * MIN) // ticks up to 14.5: the file is under 5 min old
  expect(w.writes).toBe(2)
  await clock.advance(1.25 * MIN) // the tick at 15.5
  expect(w.writes).toBe(3)
  expect(JSON.parse(w.files[STATE_FILE] ?? '{}').session.lastRequestAt).toBe(T0 + 10.75 * MIN)
})

test('the status line is not redrawn when nothing it shows changed', async ($, on) => {
  const { w, clock } = world(on)
  await raise($).start()
  await raise($).prompt()
  await raise($).tool()
  await raise($).prompt()
  await clock.advance(10 * MIN)
  expect(w.bar).toEqual(['on, no refresh yet'])
})

// ---- pure helpers -------------------------------------------------------------------------------

const cfg: Config = { idleMs: 57 * MIN, ttlMs: 60 * MIN, maxMs: 20 * 60 * MIN, prompt: PING, isOff: false }
const base: KeepwarmSession = upgrade(undefined, T0, true)

test('decide: waits under the idle mark, beats inside [idle, ttl), stops at the ttl and at the deadline', async () => {
  expect(decide(base, T0 + 56 * MIN, cfg).kind).toBe('wait')
  expect(decide(base, T0 + 57 * MIN, cfg).kind).toBe('beat')
  expect(decide(base, T0 + 59.9 * MIN, cfg).kind).toBe('beat')
  expect(decide(base, T0 + 60 * MIN, cfg).kind).toBe('stop')
  expect(decide({ ...base, lastRequestAt: T0 + 20 * 60 * MIN - 58 * MIN }, T0 + 20 * 60 * MIN, cfg).kind).toBe('stop')
  expect(decide({ ...base, isEnabled: false }, T0 + 58 * MIN, cfg).kind).toBe('wait')
})

test('statusLine counts refreshes and cached tokens read', async () => {
  const s = { ...base, beats: [{ at: T0, cacheRead: 100_000, input: 10, cacheWrite: 0, output: 2 }] }
  expect(statusLine(s, T0 + 10 * MIN, cfg)).toContain('1 refresh this session, 100,000 cached tokens read')
  expect(statusBar(s, cfg)).toMatch(/^last refresh \d\d:\d\d, read 100k cached$/)
})

test('a state held from the previous version (hot reload) is filled in, not reset', async () => {
  const old = { isEnabled: false, isInteractive: true, lastRequestAt: T0 - 5 * MIN, lastPromptAt: T0 - 9 * MIN, stoppedBecause: '', beats: [] }
  const s = upgrade(old, T0, true)
  expect(s.isEnabled).toBe(false)
  expect(s.lastRequestAt).toBe(T0 - 5 * MIN)
  expect(s.failStreak).toBe(0)
  expect(s.lastFailure).toBe(null)
  expect(s.offBecause).toBe('')
})

test('afterRefresh keeps a newer request time (a prompt that entered while the fork ran) and clears the failures', async () => {
  const beat = { at: T0 + 57 * MIN, cacheRead: 100_000, input: 10, cacheWrite: 0, output: 2 }
  const failed = { ...base, failStreak: 2, lastFailure: { at: T0, reason: 'aborted', status: null, error: '' } }
  const promptedMeanwhile = { ...failed, lastRequestAt: T0 + 59 * MIN }
  expect(afterRefresh(promptedMeanwhile, beat, T0 + 57 * MIN).lastRequestAt).toBe(T0 + 59 * MIN)
  const quiet = afterRefresh(failed, beat, T0 + 57 * MIN)
  expect(quiet.lastRequestAt).toBe(T0 + 57 * MIN)
  expect(quiet.failStreak).toBe(0)
  expect(quiet.stoppedBecause).toBe('')
  expect(afterRefresh(failed, { ...beat, cacheRead: 12 }, T0 + 57 * MIN).stoppedBecause).toBe('a refresh found the cache already lapsed')
})

test('describeFailure names the status and kind', async () => {
  expect(describeFailure({ at: 0, reason: 'api-error', status: 429, error: 'rate_limit' })).toBe('API error 429 rate_limit')
  expect(describeFailure({ at: 0, reason: 'api-error', status: null, error: 'unknown' })).toBe('API error (no response) unknown')
  expect(describeFailure({ at: 0, reason: 'aborted', status: null, error: '' })).toBe('aborted')
})
