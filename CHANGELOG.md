# Changelog

## [0.2.3] - 2026-10-14

- The process list is taken every six seconds instead of on every two-second
  refresh, and `lsof` is asked only about processes not seen before (a known
  one again every thirty seconds). On Linux processes and their working
  directories are read from `/proc`, so no `ps` is started at all. A process
  that starts or ends now shows up to six seconds later.

## [0.2.2] - 2026-10-14

- A refresh costs about a sixth of the CPU it did. A subagent's own transcript
  is looked up beside the parent transcript its hook event names, instead of
  in every project folder once for each event; with a day of hook events that
  search took most of every refresh and kept the monitor near a quarter of a
  core.

## [0.2.1] - 2026-10-05

- A session running longer than a day no longer drops out of the tree while
  its subagents are active: their hook events no longer stand in for the
  session's own, so its transcript is read again. Before, the session showed
  as `process only` and its subagents as unknown.

## [0.2.0] - 2026-10-04

- `agent-monitor [folder]` watches a named folder instead of the one it was
  run from; flags can go before or after it. `--install-hooks` and
  `--remove-hooks` keep their own, unrelated positional folders.
- `--short` fits a narrow terminal: each line is cut down to the status mark,
  owner (`claude` or `codex`) and model/effort, dropping ids and titles. No
  effect with `--json`.

## [0.1.1] - 2026-09-26

- Subagent ids are shortened to 8 characters, like session ids, so the tree
  lines up.

## [0.1.0] - 2026-09-26

First release as a project of its own; previously `agent-tree` in
harness-supervisor.

- Works without hooks: sessions, Claude subagents (`<session>/subagents/`) and
  Codex subagent threads (`parent_thread_id`) are read from transcripts, and a
  finished subagent is recognised from its transcript.
- Runs from any folder, not only a Git repository.
- Finds every Claude and Codex config folder: `~/.claude*`, `~/.codex*`,
  `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`.
- Hooks are optional: `--install-hooks [folder...]` and
  `--remove-hooks [folder...]`, for user-level or project folders. Events go
  to one file in `~/.agent-monitor/`. Removing also cleans up the hooks,
  `.bin/agent-tree` links and post-checkout setting harness-supervisor
  installed.
- A refresh no longer starts `lsof` once per process or reparses unchanged
  transcripts: about 10x faster on a busy machine.
