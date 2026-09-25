# How agent-monitor works

`agent-monitor` answers one question: which Codex and Claude Code agents are
working in this repository right now, and who started whom.

## What it watches

Run from inside a Git repository, it watches every worktree of that repository.
Run from any other folder, it watches that folder and everything below it. An
agent belongs to the worktree its working directory is in.

## Where it looks

Nothing has to be installed into a project. Every two seconds it reads:

- **Processes.** One `ps` for every `claude` and `codex` process, one `lsof`
  (or `/proc` on Linux) for their working directories. A process confirms that
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
