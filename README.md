# keepwarm

A Claude Code mod that keeps an idle **interactive** session's prompt cache warm, so coming back after a long
pause reads the conversation from cache (0.05× input on Opus 5.5) instead of rewriting it (2× input on the
1-hour TTL).

> **Early access.** Mods (plugins of function hooks) are an early-access Claude Code feature: the interface may
> change between releases, and a mod loads only where Claude Code has the feature switched on. A session that
> shows no `keepwarm:` status row under the prompt is not running mods.

## Install

1. Clone this repository, e.g. `git clone https://github.com/declanbx/keepwarm ~/.claude/mods/keepwarm`.
2. Load it in every session: add the folder's **absolute** path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
   `~/.claude/settings.json` (several folders are separated by `:`):

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/keepwarm" } }
   ```

3. Start a new session. The status row under the prompt reads `keepwarm: on, no refresh yet`.

## Cost: read before installing

- **Each refresh reads the whole conversation from cache.** At Opus 5.5 API prices ($0.20 per million cached
  tokens) that is about $0.02 for a 100k-token conversation and $0.16 for an 800k one, plus a few output tokens.
  On a subscription plan it counts against your usage instead.
- **A session left idle refreshes about once an hour for up to 20 h** after your last prompt: about 21 refreshes,
  ~$3.40 for an 800k-token conversation, against ~$6.40 to rewrite those 800k tokens once when you come back.
  Lower `KEEPWARM_MAX_HOURS` if you leave sessions open overnight and rarely return to them.
- **Where a refresh cannot reach the session's cache, the first one pays a full write.** On some accounts the
  requests are threaded (see below) and a refresh never reads the conversation's cache: it writes the whole
  conversation at 2× input, then keepwarm turns itself off for that session. Measured once at 737,647 tokens
  written, about $5.90 at Opus 5.5 API prices. If `/keepwarm status` reports
  `off for this session: a refresh inside the hour read … and had to write …` after its first refresh, your
  account works this way: set `KEEPWARM_OFF=1` in the same `env` block.

## How it works

- **How:** once the main thread has sent no model request for **57 min**, one tool-less `$.model.fork` of the
  session's own transcript, prompt `Cache keep-alive ping, not a task. Reply with exactly: .`. The API serves the
  prefix from cache, which restarts its hour. Nothing joins the conversation; no shell task, no permission prompt.
- **Clock:** restarts whenever a request starts: a prompt entering, a MAIN-thread tool returning, or a refresh.
  A subagent's requests carry its own transcript and do not count.
- **A refresh that gets no reply** (an API error such as 429/529, a dropped connection, an abort) did not
  touch the cache, so the idle clock is left alone and the next 30 s tick tries again, until the hour is up.
- **Stops until your next prompt:** 20 h after your last own prompt; when the gap already reached the hour
  (laptop asleep, or every retry failed: the pause names the last error); when a refresh reads under 1,000
  cached tokens; or when there is no reply to fork yet.
- **Turns itself off for the session** when a refresh inside the hour had to write more of the conversation
  than it could read: the fork could not reach this session's own cache, so refreshing only adds cost.
  Measured 2026-10-02 on a Team-plan account, where Opus 5.5 requests are **threaded** (the server keeps the
  conversation and each request sends only the new turn): a fork never reads the thread's cache, the thread was
  gone after 6-11 min idle in every test, and the main thread's first return after forks read only the shared
  ~29k system prefix whether keepwarm ran or not (a keepwarm session and a control session at 74 min: 28,876
  read, ~31.7k written, both). On a Max-plan account Opus 5.5 requests are stateless and refreshes read the
  whole conversation (430,620 read, 356 written). `/keepwarm on` retries.
- **Never headless** (`session.start`'s `isInteractive` is false for `claude -p` and SDK runs).
- **Never in the way:** if its bookkeeping after a prompt or a tool call fails, the failure goes to the debug log
  and the prompt or tool result passes through unchanged.

## Commands, settings and where to see it

- **`/keepwarm off | on | status`**, per session. `status` names the last request, the next refresh time, the last
  refresh with its cached read and write, and the last failure.
- **Status row** under the prompt: `keepwarm: on, no refresh yet`, `keepwarm: last refresh 20:19, read 50k cached`,
  `keepwarm: retrying (…)`, `keepwarm: paused: …`.
- **State file** `~/.claude/state/keepwarm/<session id>.json`, rewritten at session start, on every refresh,
  failure, pause and `/keepwarm` command, and every 5 min while the session works. It stays on your machine.
- **Environment:** `KEEPWARM_OFF` (any value) disables it; `KEEPWARM_IDLE_MIN` (57), `KEEPWARM_TTL_MIN` (60),
  `KEEPWARM_MAX_HOURS` (20) and `KEEPWARM_PROMPT` (the ping text) override the defaults. `KEEPWARM_IDLE_MIN=1`
  shows a refresh within a minute.

## Development

- `claude plugin validate .` reads the manifest and the hooks module the way the engine will;
  `claude plugin test .` runs `tests/`. If `claude` is a shell alias that puts flags before the subcommand, call
  `command claude plugin test .`: the test runner refuses `--dangerously-skip-permissions`.
- Type check: `npx -p typescript@5 tsc -p .`. It needs `.claude-plugin/types/`, which Claude Code writes beside the
  mod the first time a session loads it (git-ignored, rewritten after each Claude Code update), so load the mod in
  one session before the first type check.

## Tests

### 0.3.1 (2026-10-07)

- `claude plugin validate`: passed. `tsc`: 0 errors. `claude plugin test`: 25 pass, 0 fail (new: a failure in the
  bookkeeping after a prompt or a tool call is logged and the prompt and tool result pass).
- README rewritten for publication: install, cost, development.

### 0.3.0 (2026-10-02)

- `claude plugin validate`: passed. `tsc`: 0 errors. `claude plugin test`: 24 pass, 0 fail (new: a refresh that
  wrote more than it read turns keepwarm off until `/keepwarm on`; the state file follows a working session).

### 0.2.0 (2026-10-02)

- `claude plugin validate`: passed. `tsc`: 0 errors. `claude plugin test`: 21 pass, 0 fail (new: a 529 and an
  abort are retried at the next tick; failures until the hour pause naming the error; nothing-to-fork;
  a reply with no text counts; status row, `/keepwarm status` and state file show the last refresh).
- Fixed: 0.1.0 read the zeroed usage of a failed refresh as "cache lapsed" and paused for the whole idle stretch.

### 0.1.0 (2026-10-02, Claude Code 2.1.287, Team-plan account)

- `claude plugin validate`: passed. `tsc` (bundled API types): 0 errors. `claude plugin test`: 11 pass, 0 fail.
- **Live, interactive, Opus 5.5, repo session (~105k-token prefix), timer cut to 1 min** (debug log):
  - ping above: 4 refreshes, one **mid-turn** during a 100 s command; each read 102,565–105,497 cached tokens,
    30 uncached input, **3 output tokens**, cache write 0–240.
  - alternative ping "This is just to keep the cache fresh, no action required from you.": 3 refreshes,
    25 input, **6–69 output tokens** (the mid-turn one wrote two messages). Kept the first.
- Cost per refresh at API prices for that session: ≈ 105,500 × $0.20/M ≈ **$0.021**; output and input add < 1%.
