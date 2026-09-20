import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { repo, worktree, run, cleanup, root, tool } from './helpers.mjs'
import { checkGitVersion } from '../harness/lib/agent-tree.mjs'

test('installs in current and future worktrees while preserving hooks', () => {
  const main = repo(), old = worktree(main, 'old')
  try {
    mkdirSync(join(main, '.claude'), { recursive: true })
    writeFileSync(join(main, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] }, custom: 1 }))
    run('git', ['config', '--local', 'hook.other.event', 'post-checkout'], main)
    run('git', ['config', '--local', 'hook.other.command', 'true'], main)
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    assert.ok(existsSync(join(old, '.bin/agent-tree')))
    const config = JSON.parse(readFileSync(join(main, '.claude/settings.json')))
    assert.equal(config.custom, 1)
    assert.equal(config.hooks.SessionStart.length, 2)
    assert.equal(run('git', ['config', '--local', '--get', 'hook.other.command'], main).stdout.trim(), 'true')
    const newer = worktree(main, 'newer')
    try {
      assert.ok(existsSync(join(newer, '.bin/agent-tree')))
      const shot = JSON.parse(run(tool('agent-tree'), ['--json'], newer).stdout)
      assert.ok(shot.worktrees.some(t => t.path === realpathSync(main)))
      assert.ok(shot.worktrees.some(t => t.path === realpathSync(newer)))
    } finally { cleanup(newer) }
  } finally { cleanup(old, main) }
})

test('event snapshot and filters keep uncertain parents explicit', () => {
  const main = repo()
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    const event = { cwd: main, session_id: 'root', agent_id: 'child', agent_type: 'worker' }
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStart', 'codex'], { cwd: main, input: JSON.stringify(event) })
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--codex'], main).stdout)
    assert.equal(data.worktrees[0].agents[0].parentKnown, false)
    assert.equal(JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main).stdout).worktrees[0].agents.length, 0)
  } finally { cleanup(main) }
})

test('refuses malformed hook configuration instead of overwriting it', () => {
  const main = repo()
  try {
    mkdirSync(join(main, '.codex'), { recursive: true })
    writeFileSync(join(main, '.codex', 'hooks.json'), '{ malformed')
    const result = run(join(root, 'link.sh'), [main])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid JSON/)
    assert.equal(readFileSync(join(main, '.codex', 'hooks.json'), 'utf8'), '{ malformed')
  } finally { cleanup(main) }
})

test('post-checkout config installs after a no-checkout worktree is checked out', () => {
  const main = repo(), delayed = join(main, '..', `delayed-${Date.now()}`)
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    assert.equal(run('git', ['worktree', 'add', '--no-checkout', '-b', 'delayed', delayed], main).status, 0)
    assert.equal(existsSync(join(delayed, '.bin', 'agent-tree')), false)
    assert.equal(run('git', ['checkout', 'delayed'], delayed).status, 0)
    assert.equal(existsSync(join(delayed, '.bin', 'agent-tree')), true)
  } finally { cleanup(delayed, main) }
})

test('Git 2.54 is required for automatic worktree setup', () => {
  assert.throws(() => checkGitVersion('git version 2.53.9'), /Git 2\.54 or newer/)
  assert.doesNotThrow(() => checkGitVersion('git version 2.54.0'))
})
