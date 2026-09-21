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
    assert.equal(nullMetadataChild, undefined)
    assert.equal(JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main).stdout).worktrees[0].agents.length, 0)
  } finally { cleanup(main) }
})

test('event-backed agents use explicit metadata fallbacks and interactive rendering is styled', () => {
  const output = render({ worktrees: [{ path: '/workspace', agents: [
    { cli: 'codex', id: 'child', status: 'running', source: 'event', model: 'unknown', effort: 'unknown', parentKnown: false, children: [] },
    { cli: 'claude-code', id: 'pid:12', status: 'stopped', source: 'process', parentKnown: true, children: [] },
    { cli: 'codex', id: 'waiting', status: 'unknown', source: 'event', model: 'o4-mini', effort: 'low', parentKnown: true, children: [] }
  ] }] })
  assert.match(output, /\x1b\[32m●\x1b\[0m codex child unknown\/unknown\x1b\[2m \(parent unknown\)\x1b\[0m/)
  assert.match(output, /\x1b\[2;90m○\x1b\[0m claude-code pid:12\x1b\[2m \(process only; runtime metadata unavailable\)\x1b\[0m/)
  assert.match(output, /\x1b\[2;90m\?\x1b\[0m codex waiting o4-mini\/low/)
})

test('interactive rendering shortens UUIDs without changing other identifiers', () => {
  const output = render({ worktrees: [{ path: '/workspace', agents: [
    { cli: 'claude-code', id: 'c21db08d-8424-4ef0-927a-0735221006ce', status: 'running', source: 'event', model: 'sonnet-5', effort: 'medium', title: 'Implement account endpoint', parentKnown: true, children: [] },
    { cli: 'claude-code', id: 'aceefdf3359141526', status: 'stopped', source: 'event', model: 'sonnet-5', effort: 'medium', parentKnown: true, children: [] }
  ] }] })
  assert.match(output, /claude-code c21db08d sonnet-5\/medium — Implement account endpoint/)
  assert.match(output, /claude-code aceefdf3359141526 sonnet-5\/medium/)
  assert.doesNotMatch(output, /c21db08d-8424-4ef0-927a-0735221006ce/)
})

test('interactive rendering nests assigned worktrees under the actual cross-worktree parent', () => {
  const event = (id, parent = null, children = [], parentKnown = true) => ({ cli: 'claude-code', id, parent, status: 'unknown', source: 'event', model: 'sonnet-5', effort: 'medium', parentKnown, children })
  const rootChild = event('root-child', 'lead')
  const lead = event('lead', null, [rootChild])
  const assigned = event('assigned-child', 'lead')
  const orphan = event('orphan', 'missing-parent', [], false)
  const output = render({ worktrees: [
    { path: '/repo', agents: [lead] },
    { path: '/repo/.claude/worktrees/assigned', agents: [assigned] },
    { path: '/repo/.claude/worktrees/unassigned', agents: [orphan] }
  ] })
  assert.match(output, /\/repo\n  \x1b\[2;90m\?\x1b\[0m claude-code lead sonnet-5\/medium\n    \x1b\[2;90m\?\x1b\[0m claude-code root-child sonnet-5\/medium\n    \/repo\/\.claude\/worktrees\/assigned\n      \x1b\[2;90m\?\x1b\[0m claude-code assigned-child sonnet-5\/medium/)
  assert.match(output, /\/repo\/\.claude\/worktrees\/unassigned\n  \x1b\[2;90m\?\x1b\[0m claude-code orphan sonnet-5\/medium\x1b\[2m \(parent unknown\)\x1b\[0m/)
  assert.doesNotMatch(output, /^\/repo\/\.claude\/worktrees\/assigned/m)
})

test('normalizes Claude metadata, recovers transcripts, nests subagents, and prunes live nodes', () => {
  const main = repo(), transcript = join(main, 'claude.jsonl')
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-1' }, effort: 'medium' }) + '\n')
    const parent = { cwd: main, session_id: 'parent', model: 'claude-sonnet-4', effort: { level: 'high' }, background_tasks: [{ id: 'child', description: 'Implement agent tree title' }] }
    const child = { cwd: main, session_id: 'parent', agent_id: 'child', transcript_path: transcript, effort: { level: 'medium' } }
    spawnSync('node', [tool('agent-tree'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify(parent) })
    spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStart', 'claude-code'], { cwd: main, input: JSON.stringify(child) })
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
    assert.equal(parentNode.children[0].title, 'Implement agent tree title')
    assert.equal(parentNode.children[0].parentKnown, true)
    assert.equal(data.worktrees[0].agents.some(node => /expired/.test(node.id)), false)
    assert.match(render(data), /\x1b\[2;90m\?\x1b\[0m claude-code child opus-4-1\/medium — Implement agent tree title/)
  } finally { cleanup(main) }
})

test('retains a stale parent needed by a fresh active descendant', () => {
  const main = repo(), now = Date.now()
  try {
    assert.equal(run(join(root, 'link.sh'), [main]).status, 0)
    const common = run('git', ['rev-parse', '--git-common-dir'], main).stdout.trim()
    const eventDir = join(main, common, 'agent-tree')
    const worktreePath = realpathSync(main)
    mkdirSync(eventDir, { recursive: true })
    appendFileSync(join(eventDir, 'events.jsonl'), [
      { at: now - 901000, event: 'SessionStart', cli: 'claude-code', cwd: worktreePath, payload: { session_id: 'stale-parent', model: 'claude-sonnet-4', effort: { level: 'high' } } },
      { at: now - 299000, event: 'SubagentStart', cli: 'claude-code', cwd: worktreePath, payload: { session_id: 'stale-parent', agent_id: 'fresh-child', parent_agent_id: 'stale-parent', model: 'claude-opus-4-1', effort: { level: 'medium' } } }
    ].map(JSON.stringify).join('\n') + '\n')
    const data = snapshot(main, 'claude-code', { processes: [], now })
    const parent = data.worktrees[0].agents.find(node => node.id === 'stale-parent')
    assert.equal(parent.model, 'sonnet-4')
    assert.equal(parent.effort, 'high')
    assert.equal(parent.children[0].id, 'fresh-child')
    assert.equal(parent.children[0].model, 'opus-4-1')
    assert.equal(parent.children[0].effort, 'medium')
    assert.match(render(data), /\x1b\[2;90m\?\x1b\[0m claude-code fresh-child opus-4-1\/medium/)
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

test('Claude team members use configured repository worktrees and otherwise stay with the lead', () => {
  const main = repo(), assigned = worktree(main, 'assigned'), home = temp()
  try {
    const team = join(home, '.claude', 'teams', 'feature-team')
    mkdirSync(team, { recursive: true })
    writeFileSync(join(team, 'config.json'), JSON.stringify({
      leadSessionId: 'lead',
      leadAgentId: 'lead',
      members: [
        { agentId: 'assigned', agentType: 'worker', name: 'Assigned teammate', worktreePath: assigned },
        { agentId: 'missing-path', agentType: 'worker', name: 'No configured worktree' },
        { agentId: 'outside-repo', agentType: 'worker', name: 'Outside repository', worktreePath: home }
      ]
    }))
    spawnSync('node', [tool('agent-tree'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'lead' }) })
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
    const mainTree = data.worktrees.find(tree => tree.path === realpathSync(main))
    const assignedTree = data.worktrees.find(tree => tree.path === realpathSync(assigned))
    assert.deepEqual(assignedTree.agents.map(node => node.id), ['assigned'])
    assert.deepEqual(mainTree.agents.find(node => node.id === 'lead').children.map(node => node.id).sort(), ['missing-path', 'outside-repo'])
    assert.match(render(data), new RegExp(`\\n    ${realpathSync(assigned)}\\n      \\x1b\\[2;90m\\?\\x1b\\[0m claude-code assigned`))
  } finally { cleanup(home, assigned, main) }
})

test('Claude subagent transcripts explicitly assign one repository worktree', () => {
  const main = repo(), assigned = join(main, '.claude', 'worktrees', 'assigned'), other = worktree(main, 'other'), home = temp(), unknown = temp()
  try {
    mkdirSync(join(main, '.claude', 'worktrees'), { recursive: true })
    assert.equal(run('git', ['worktree', 'add', '-b', 'assigned', assigned], main).status, 0)
    const session = 'lead'
    const subagents = join(home, '.claude', 'projects', 'fixture-project', session, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(home, '.claude', 'projects', 'fixture-project', `${session}.jsonl`), '{}\n')
    const transcript = (agent, content) => writeFileSync(join(subagents, `agent-${agent}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
    transcript('assigned', `Work in git worktree at ${assigned} (branch assigned).\nDo the task.`)
    transcript('current-format', `Worktree: ${assigned}\nFirst: EnterWorktree with path=${assigned} before inspecting files.`)
    transcript('enter-worktree', `First: EnterWorktree with path=${assigned} before inspecting files.`)
    transcript('git-add-relative', 'Create it with git worktree add .claude/worktrees/assigned topic/assigned before starting.')
    transcript('git-add-absolute', `Use git worktree add -b assigned-copy ${assigned} topic/assigned before starting.`)
    transcript('work-only', `Work only inside ${assigned} (a git worktree created for this task).`)
    transcript('work-inside', `Work inside the worktree ${assigned}`)
    transcript('inside-git-worktree', `You are implementing this task inside the git worktree at ${assigned} (branch assigned).`)
    transcript('no-assignment', `Please inspect the worktree at ${assigned}, but do not change directories.`)
    transcript('unknown-path', `Work in git worktree at ${unknown}`)
    transcript('two-assignments', `Work in git worktree at ${assigned}\nWork in git worktree at ${other}`)
    spawnSync('node', [tool('agent-tree'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: session }) })
    for (const agent_id of ['assigned', 'current-format', 'enter-worktree', 'git-add-relative', 'git-add-absolute', 'work-only', 'work-inside', 'inside-git-worktree', 'no-assignment', 'unknown-path', 'two-assignments']) {
      spawnSync('node', [tool('agent-tree'), '_event', 'SubagentStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: session, agent_id }) })
    }
    const data = JSON.parse(run(tool('agent-tree'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
    const mainTree = data.worktrees.find(tree => tree.path === realpathSync(main))
    const assignedTree = data.worktrees.find(tree => tree.path === realpathSync(assigned))
    assert.deepEqual(assignedTree.agents.map(node => node.id).sort(), ['assigned', 'current-format', 'enter-worktree', 'git-add-absolute', 'git-add-relative', 'inside-git-worktree', 'work-inside', 'work-only'])
    assert.deepEqual(mainTree.agents.find(node => node.id === session).children.map(node => node.id).sort(), ['no-assignment', 'two-assignments', 'unknown-path'])
    assert.match(render(data), new RegExp(`\\n    ${realpathSync(assigned)}\\n      \\x1b\\[2;90m\\?\\x1b\\[0m claude-code assigned`))
  } finally { cleanup(unknown, home, other, assigned, main) }
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
