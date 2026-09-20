import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { repo, worktree, run, cleanup, root, temp, tool } from './helpers.mjs'
import { checkGitVersion, render, snapshot } from '../harness/lib/agent-tree.mjs'

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
    const event = { cwd: main, session_id: 'root', agent_id: 'child', agent_type: 'worker', model_name: 'gpt-5.6', reasoning_effort: 'medium' }
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStart', 'codex'], { cwd: main, input: JSON.stringify(event) })
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--codex'], main).stdout)
    const child = data.worktrees[0].agents[0]
    assert.equal(child.parentKnown, false)
    assert.equal(child.source, 'event')
    assert.equal(child.model, 'gpt-5.6')
    assert.equal(child.effort, 'medium')
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStart', 'codex'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'root', agent_id: 'unknown-child', agent_type: 'worker' }) })
    const unknownChild = JSON.parse(run(tool('agent-tree'), ['--json', '--codex'], main).stdout).worktrees[0].agents.find(node => node.id === 'unknown-child')
    assert.equal(unknownChild.model, 'unknown')
    assert.equal(unknownChild.effort, 'unknown')
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStop', 'codex'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'root', agent_id: 'unknown-child', model: null, effort: null }) })
    const nullMetadataChild = JSON.parse(run(tool('agent-tree'), ['--json', '--codex'], main).stdout).worktrees[0].agents.find(node => node.id === 'unknown-child')
    assert.equal(nullMetadataChild.model, 'unknown')
    assert.equal(nullMetadataChild.effort, 'unknown')
    assert.equal(JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main).stdout).worktrees[0].agents.length, 0)
  } finally { cleanup(main) }
})

test('event-backed agents use explicit metadata fallbacks and interactive rendering is styled', () => {
  const output = render({ worktrees: [{ path: '/workspace', agents: [
    { cli: 'codex', id: 'child', status: 'running', source: 'event', model: 'unknown', effort: 'unknown', parentKnown: false, children: [] },
    { cli: 'claude-code', id: 'pid:12', status: 'stopped', source: 'process', parentKnown: true, children: [] },
    { cli: 'codex', id: 'waiting', status: 'unknown', source: 'event', model: 'o4-mini', effort: 'low', parentKnown: true, children: [] }
  ] }] })
  assert.match(output, /\x1b\[32mcodex child \[running\] unknown\/unknown\x1b\[0m\x1b\[2m \(parent unknown\)\x1b\[0m/)
  assert.match(output, /\x1b\[2;90mclaude-code pid:12 \[stopped\]\x1b\[0m\x1b\[2m \(process only; runtime metadata unavailable\)\x1b\[0m/)
  assert.match(output, /\x1b\[33mcodex waiting \[unknown\] o4-mini\/low\x1b\[0m/)
})

test('normalizes Claude metadata, recovers transcripts, nests subagents, and prunes live nodes', () => {
  const main = repo(), transcript = join(main, 'claude.jsonl')
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-1' }, effort: 'medium' }) + '\n')
    const parent = { cwd: main, session_id: 'parent', model: 'claude-sonnet-4', effort: { level: 'high' } }
    const child = { cwd: main, session_id: 'parent', agent_id: 'child', transcript_path: transcript, effort: { level: 'medium' } }
    spawnSync('node', [tool('agent-tree'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify(parent) })
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStop', 'claude-code'], { cwd: main, input: JSON.stringify(child) })
    const common = run('git', ['rev-parse', '--git-common-dir'], main).stdout.trim()
    const eventDir = join(main, common, 'agent-tree')
    appendFileSync(join(eventDir, 'events.jsonl'), [
      { at: Date.now() - 301000, event: 'SubagentStop', cli: 'claude-code', cwd: main, payload: { session_id: 'expired-stop' } },
      { at: Date.now() - 901000, event: 'SessionStart', cli: 'claude-code', cwd: main, payload: { session_id: 'expired-unknown' } }
    ].map(JSON.stringify).join('\n') + '\n')
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main).stdout)
    const parentNode = data.worktrees[0].agents.find(node => node.id === 'parent')
    assert.equal(parentNode.model, 'sonnet-4')
    assert.equal(parentNode.effort, 'high')
    assert.equal(parentNode.children[0].id, 'child')
    assert.equal(parentNode.children[0].model, 'opus-4-1')
    assert.equal(parentNode.children[0].effort, 'medium')
    assert.equal(parentNode.children[0].parentKnown, true)
    assert.equal(data.worktrees[0].agents.some(node => /expired/.test(node.id)), false)
    assert.match(render(data), /claude-code child \[stopped\] opus-4-1\/medium/)
  } finally { cleanup(main) }
})

test('Claude bg-spare helpers do not create nodes and the main process uses the newest session', () => {
  const main = repo()
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    for (const session_id of ['older', 'newer']) spawnSync('node', [tool('agent-tree'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id }) })
    const data = snapshot(main, 'claude-code', { processes: [
      { pid: 101, command: 'claude bg-spare', cwd: realpathSync(main) },
      { pid: 102, command: 'claude', cwd: realpathSync(main) }
    ] })
    assert.equal(data.worktrees[0].agents.find(node => node.id === 'newer').status, 'running')
    assert.equal(data.worktrees[0].agents.some(node => node.id === 'pid:101'), false)
    assert.equal(data.worktrees[0].agents.some(node => node.id === 'pid:102'), false)
  } finally { cleanup(main) }
})

test('recovers Codex thread settings after initial session metadata', () => {
  const main = repo(), home = temp()
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    const sessions = join(home, '.codex', 'sessions', '2026', '09', '20')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'recovered', cwd: main } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6', reasoning_effort: 'high' } } })
    ].join('\n') + '\n')
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--codex'], main, { HOME: home }).stdout)
    const recovered = data.worktrees[0].agents.find(node => node.id === 'recovered')
    assert.equal(recovered.model, 'gpt-5.6')
    assert.equal(recovered.effort, 'high')
  } finally { cleanup(home, main) }
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
