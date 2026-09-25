# Changelog

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
