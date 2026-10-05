# Changelog

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
