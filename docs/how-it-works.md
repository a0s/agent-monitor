# How agent-monitor works

`agent-monitor` answers one question: which Codex and Claude Code agents are
working in this repository right now, and who started whom.

## What it watches

Run from inside a Git repository, it watches every worktree of that repository.
Run from any other folder, it watches that folder and everything below it. An
agent belongs to the worktree its working directory is in.

## Where it looks

Nothing has to be installed into a project. Every two seconds it reads the
transcripts below; the process list is taken every six seconds. The only
network request is the daily read of the pricing pages (see Cost).

- **Processes.** On Linux, `/proc` gives every `claude` and `codex` process and
  its working directory without starting anything. Elsewhere, one `ps` lists
  them and one `lsof` gives the working directory of each process not seen
  before; a known process is asked again every thirty seconds. A process confirms that
  the newest session in its worktree is running. Claude `bg-spare` helper
  processes are ignored. A process with no transcript behind it is still shown,
  marked `process only`.
- **Claude Code transcripts** from the last day, in `projects/` of every Claude
  config folder: `~/.claude`, `$CLAUDE_CONFIG_DIR`, any other `~/.claude*`
  folder with a `projects/` in it (a second account), and any folder hooks were
  installed into. A session's subagents are the files under
  `<session>/subagents/agent-<id>.jsonl`; their `.meta.json` gives the agent
  type and the task description.
- **Codex transcripts** from the last day, in `sessions/` of `~/.codex`,
  `$CODEX_HOME` and any other `~/.codex*` folder. A subagent thread names its
  parent in `session_meta` (`parent_thread_id`), with a nickname and a path.
- **Claude Code teams**, from `teams/*/config.json` of each Claude folder, when
  the lead session is in the watched repository. A teammate with a configured
  `worktreePath` inside the repository is shown under that worktree.

Unchanged transcripts are not parsed again, so a refresh reads only what has
been written since the last one.

## Status

- `●` green: running. A session is running while its process is. A subagent is
  running while it has not finished, was active in the last fifteen minutes,
  and its top-level session is running.
- `○` dim: stopped. A Claude subagent has stopped when its last turn ended
  without asking for a tool (`end_turn`); a Codex subagent when its thread
  reported `task_complete` and nothing started after it. With hooks, an end
  or stop event says so directly.
- `?` dim: unknown — seen recently, but nothing confirms it is still going.

Stopped agents leave the view unless a live descendant still needs them as a
parent. Unknown agents without a process leave it after fifteen minutes.

Model and effort come from the transcript, which follows `/model` changes; the
`claude-` prefix is dropped. They are shown as `model/effort`, or `unknown`, and
never guessed from a process.

## Cost

Each agent's figure is what the tokens its own transcript records would cost at
API list prices, in US dollars. It is an estimate of the API price, not a bill.

- **Claude Code**: every reply's `usage` — input, cache writes (5-minute and
  1-hour, each at its own price), cache reads and output — at the price of the
  model that reply names, so a `/model` switch is followed. Claude Code repeats a
  reply's usage on every content block; a reply is counted once, by its message
  id. Fast mode (`speed: "fast"`), US-only inference (`inference_geo: "us"`,
  1.1x) and Claude Haiku 5.5's higher prices for prompts over 100,000 tokens
  are applied per reply.
- **Codex**: the thread's running total (`token_count`), priced by the
  difference between one total and the next at the model the thread was on;
  cached input is subtracted from input and priced as cached. A forked thread
  starts with its parent's total, so its first total counts only the response it
  follows. The fast tier (`service_tier`) is priced at the page's fast rate.
- A Claude subagent and a Codex subagent thread have transcripts of their own,
  so a parent's figure does not include them; the `total` line adds up every
  agent shown. A session forked or resumed into a new transcript carries the
  replies it copied, and counts them again.

Prices are matched by the exact model id (a date suffix, `[1m]` and provider
prefixes aside), so a model with no known price is never priced as an older one
whose id it starts with: its tokens are counted and marked `+` or `$?`.

They come from the pricing pages,
<https://platform.claude.com/docs/en/about-claude/pricing.md> and
<https://developers.openai.com/api/docs/pricing.md>. A release ships the tables
as they were when it was cut (`lib/prices.json`, written by `npm run prices`).
The live view reads both pages again when the copy in
`~/.agent-monitor/prices.json` is a day old, in the background, and uses what it
finds from the next refresh on. A page that no longer reads as a pricing table
is ignored and the last good prices stay. `--json` never goes to the network;
`AGENT_MONITOR_PRICE_LOOKUP=0` keeps the live view off it too. Long-context
surcharges on OpenAI models (over 272K tokens) are not applied; Codex compacts
before that.

A Claude subagent whose first prompt assigns it exactly one worktree of the
repository (`Worktree: …`, `EnterWorktree with path=…`, `git worktree add …`,
`Work in git worktree at …` and similar) is shown under that worktree, nested
below its parent.

## Hooks (optional)

Hooks record session and subagent starts and stops the moment they happen,
which makes stopped and started states exact instead of inferred.

```sh
agent-monitor --install-hooks                      # ~/.claude and ~/.codex
agent-monitor --install-hooks ~/.claude-work       # a second Claude account
agent-monitor --install-hooks ./.claude ./.codex   # one project only
agent-monitor --remove-hooks ~/.claude-work        # from one folder
agent-monitor --remove-hooks                       # from everywhere
```

A folder is treated as Codex when it has a `config.toml` or only `sessions/`,
and as Claude otherwise; Claude hooks go into its `settings.json`, Codex hooks
into its `hooks.json`. Other hooks and settings in those files are kept. The
hook command is the path `agent-monitor` was started by (under Homebrew, the
stable `bin` link), so an upgrade does not break it. Installing again replaces
the previous entries instead of adding more.

Every hook appends to one file, `~/.agent-monitor/events.jsonl`
(`$AGENT_MONITOR_HOME` moves it), whatever project the session is in; a
snapshot keeps the rows under the folder it watches. Rows older than a day are
dropped once the file passes 8 MB. The folders hooks went into are listed in
`~/.agent-monitor/hooks.json`, which is how `--remove-hooks` with no folder
finds them all. It also removes the hooks, `.bin/agent-tree` links and
post-checkout setting that harness-supervisor's copy of this monitor installed.

A hook never blocks the agent: it has a three-second timeout, and any error
while recording is swallowed. Codex may ask you to trust new hooks once, under
`/hooks`.
