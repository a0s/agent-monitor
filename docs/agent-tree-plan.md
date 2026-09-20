# Project agent-tree monitor

`link.sh` installs `.bin/agent-tree` and project-level Codex and Claude Code hooks in every existing worktree. A shared Git `post-checkout` hook installs them in future worktrees after checkout. This requires Git 2.54 or newer. With `git worktree add --no-checkout`, installation waits until that worktree is checked out; if it is never checked out, run `link.sh` again.

Run `.bin/agent-tree` from any worktree for a live terminal view. `--codex` and `--claude-code` filter by CLI, while `--json` prints one machine-readable snapshot. The monitor reads events from the repository's shared Git directory, recent local transcripts, and Claude Code team configuration, then matches them to local processes. A `parent unknown` annotation means that the runtime did not provide the immediate parent. A matching process confirms that an agent is running; without one, the state remains unknown even after a start event. Stop hooks mark an agent as stopped.

Codex may require trusting project hooks through `/hooks`. Until they are trusted, Codex events may be absent. Sessions started before installation are visible only when their process can be associated with a worktree. The monitor does not change global user settings.
