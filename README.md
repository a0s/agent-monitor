# agent-monitor

[![test](https://github.com/a0s/agent-monitor/actions/workflows/test.yml/badge.svg)](https://github.com/a0s/agent-monitor/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A live tree of every **Codex** and **Claude Code** session, subagent and
teammate working in a repository — across all of its worktrees — with each
one's model, effort, task and status. Run it in a spare terminal from the
project root and leave it there.

```
/Users/me/src/shop
  ● claude-code 047e616b opus-5-5/high
    ● claude-code a7f0561ef3b45bf80 sonnet-5/medium — Implement checkout endpoint
    /Users/me/src/shop/.claude/worktrees/wp-2
      ● claude-code b19c02e4d7a5f3e11 sonnet-5/medium — Payment webhook
  ● codex 01a0bf0c gpt-5.6-terra/high
    ● codex 01a0d0e0 gpt-5.6-terra/high — Boyle (/root/g03_repair)
```

Nothing is installed into the project. It reads the agents' own transcripts
and the running processes, so it works in any folder, for sessions that were
started before it, and for agents started by anyone's tooling.

## Install

Homebrew, on macOS and Linux:

```sh
brew install a0s/agent-monitor/agent-monitor
```

Or from a checkout (Node.js 20 or later, no dependencies):

```sh
git clone https://github.com/a0s/agent-monitor.git
ln -s "$PWD/agent-monitor/bin/agent-monitor" /usr/local/bin/agent-monitor
```

## Use

```sh
cd ~/src/shop
agent-monitor                  # live view, refreshed every two seconds; Ctrl-C to stop
agent-monitor --claude-code    # only Claude Code
agent-monitor --codex          # only Codex
agent-monitor --json           # one machine-readable snapshot
```

Inside a Git repository it watches every worktree of it; anywhere else, that
folder and everything below it.

`●` running, `○` stopped, `?` seen recently but not confirmed. Stopped agents
drop out of the view; `parent unknown` means the runtime did not say who
started an agent, and `process only` marks a process with no transcript behind
it.

Transcripts are found in `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`,
`$CODEX_HOME`, and any other `~/.claude*` or `~/.codex*` folder that holds them
— a second account included.

## Hooks (optional)

Without hooks, whether an agent has stopped is inferred from its transcript.
Hooks record starts and stops as they happen. They can go into a user-level
config folder, which covers every project that account opens, or into one
project's `.claude` / `.codex`:

```sh
agent-monitor --install-hooks                      # ~/.claude and ~/.codex
agent-monitor --install-hooks ~/.claude-work       # a Claude folder that is not the default
agent-monitor --install-hooks ./.claude ./.codex   # this project only
agent-monitor --remove-hooks ~/.claude-work        # from one folder
agent-monitor --remove-hooks                       # from everywhere they were installed
```

Your other hooks and settings are kept, and installing twice does not add a
second copy. Events go to `~/.agent-monitor/`. Codex may ask you to trust the
hooks once, under `/hooks`.

More detail — where each piece of information comes from, and how status is
decided — is in [docs/how-it-works.md](docs/how-it-works.md).

## Development

```sh
npm test
npm run check
```

agent-monitor started as the `agent-tree` monitor in
[harness-supervisor](https://github.com/a0s/harness-supervisor).
