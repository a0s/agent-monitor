import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { repo, worktree, run, cleanup, root, temp, tool } from './helpers.mjs'
import { render, snapshot } from '../lib/agent-monitor.mjs'

test('event snapshot and filters keep uncertain parents explicit', () => {
  const main = repo()
  try {
    const event = { cwd: main, session_id: 'root', agent_id: 'child', agent_type: 'worker', model_name: 'gpt-5.6', reasoning_effort: 'medium' }
    spawnSync('node', [tool('agent-monitor'), '_event', 'SubagentStart', 'codex'], { cwd: main, input: JSON.stringify(event) })
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--codex'], main).stdout)
    const child = data.worktrees[0].agents[0]
    assert.equal(child.parentKnown, false)
    assert.equal(child.source, 'event')
    assert.equal(child.model, 'gpt-5.6')
    assert.equal(child.effort, 'medium')
    spawnSync('node', [tool('agent-monitor'), '_event', 'SubagentStart', 'codex'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'root', agent_id: 'unknown-child', agent_type: 'worker' }) })
    const unknownChild = JSON.parse(run(tool('agent-monitor'), ['--json', '--codex'], main).stdout).worktrees[0].agents.find(node => node.id === 'unknown-child')
    assert.equal(unknownChild.model, 'unknown')
    assert.equal(unknownChild.effort, 'unknown')
    spawnSync('node', [tool('agent-monitor'), '_event', 'SubagentStop', 'codex'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'root', agent_id: 'unknown-child', model: null, effort: null }) })
    const nullMetadataChild = JSON.parse(run(tool('agent-monitor'), ['--json', '--codex'], main).stdout).worktrees[0].agents.find(node => node.id === 'unknown-child')
    assert.equal(nullMetadataChild, undefined)
    assert.equal(JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main).stdout).worktrees[0].agents.length, 0)
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
  assert.match(output, /claude-code aceefdf3 sonnet-5\/medium/)
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
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-1' }, effort: 'medium' }) + '\n')
    const parent = { cwd: main, session_id: 'parent', model: 'claude-sonnet-4', effort: { level: 'high' }, background_tasks: [{ id: 'child', description: 'Implement agent tree title' }] }
    const child = { cwd: main, session_id: 'parent', agent_id: 'child', transcript_path: transcript, effort: { level: 'medium' } }
    spawnSync('node', [tool('agent-monitor'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify(parent) })
    spawnSync('node', [tool('agent-monitor'), '_event', 'SubagentStart', 'claude-code'], { cwd: main, input: JSON.stringify(child) })
    const eventDir = process.env.AGENT_MONITOR_HOME
    appendFileSync(join(eventDir, 'events.jsonl'), [
      { at: Date.now() - 301000, event: 'SubagentStop', cli: 'claude-code', cwd: main, payload: { session_id: 'expired-stop' } },
      { at: Date.now() - 901000, event: 'SessionStart', cli: 'claude-code', cwd: main, payload: { session_id: 'expired-unknown' } }
    ].map(JSON.stringify).join('\n') + '\n')
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main).stdout)
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
    const eventDir = process.env.AGENT_MONITOR_HOME
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
    for (const session_id of ['older', 'newer']) spawnSync('node', [tool('agent-monitor'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id }) })
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
    spawnSync('node', [tool('agent-monitor'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'lead' }) })
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
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
    spawnSync('node', [tool('agent-monitor'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: session }) })
    for (const agent_id of ['assigned', 'current-format', 'enter-worktree', 'git-add-relative', 'git-add-absolute', 'work-only', 'work-inside', 'inside-git-worktree', 'no-assignment', 'unknown-path', 'two-assignments']) {
      spawnSync('node', [tool('agent-monitor'), '_event', 'SubagentStart', 'claude-code'], { cwd: main, input: JSON.stringify({ cwd: main, session_id: session, agent_id }) })
    }
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
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
    const sessions = join(home, '.codex', 'sessions', '2026', '09', '20')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'recovered', cwd: main } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6', reasoning_effort: 'high' } } })
    ].join('\n') + '\n')
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--codex'], main, { HOME: home }).stdout)
    const recovered = data.worktrees[0].agents.find(node => node.id === 'recovered')
    assert.equal(recovered.model, 'gpt-5.6')
    assert.equal(recovered.effort, 'high')
  } finally { cleanup(home, main) }
})

test('Claude session model follows the transcript after /model, not the SessionStart payload', () => {
  const main = repo(), home = temp()
  try {
    const project = join(home, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    const transcript = join(project, 'switched.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: 'switched', cwd: main, effort: 'xhigh', message: { model: 'claude-opus-5-5' } }) + '\n')
    const event = { cwd: main, session_id: 'switched', transcript_path: transcript, model: 'claude-sonnet-5', effort: 'high' }
    spawnSync('node', [tool('agent-monitor'), '_event', 'SessionStart', 'claude-code'], { cwd: main, input: JSON.stringify(event), env: { ...process.env, HOME: home } })
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
    const session = data.worktrees[0].agents.find(node => node.id === 'switched')
    assert.equal(session.model, 'opus-5-5')
    assert.equal(session.effort, 'xhigh')
  } finally { cleanup(home, main) }
})

test('refuses malformed hook configuration instead of overwriting it', () => {
  const main = repo()
  try {
    mkdirSync(join(main, '.claude-unused'), { recursive: true })
    mkdirSync(join(main, '.codex'), { recursive: true })
    writeFileSync(join(main, '.codex', 'hooks.json'), '{ malformed')
    const result = run(tool('agent-monitor'), ['--install-hooks', join(main, '.claude-unused'), join(main, '.codex')], main)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid JSON/)
    assert.equal(readFileSync(join(main, '.codex', 'hooks.json'), 'utf8'), '{ malformed')
    assert.equal(existsSync(join(main, '.claude-unused', 'settings.json')), false)
  } finally { cleanup(main) }
})


test('without hooks, Claude subagents come from transcripts and run while their session does', () => {
  const main = repo(), home = temp()
  try {
    const project = join(home, '.claude', 'projects', 'p')
    const subagents = join(project, 'lead', 'subagents')
    mkdirSync(subagents, { recursive: true })
    const cwd = realpathSync(main)
    const lines = rows => rows.map(row => JSON.stringify({ cwd, sessionId: 'lead', ...row })).join('\n') + '\n'
    writeFileSync(join(project, 'lead.jsonl'), lines([{ type: 'user', message: { role: 'user', content: 'go' } }, { type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use' } }]))
    writeFileSync(join(subagents, 'agent-busy.jsonl'), lines([{ agentId: 'busy', type: 'user', message: { role: 'user', content: 'task' } }, { agentId: 'busy', type: 'assistant', message: { model: 'claude-sonnet-5', stop_reason: 'tool_use' } }]))
    writeFileSync(join(subagents, 'agent-busy.meta.json'), JSON.stringify({ agentType: 'supervisor-implementer', description: 'Implement WP-1' }))
    writeFileSync(join(subagents, 'agent-done.jsonl'), lines([{ agentId: 'done', type: 'user', message: { role: 'user', content: 'task' } }, { agentId: 'done', type: 'assistant', message: { model: 'claude-sonnet-5', stop_reason: 'end_turn' } }]))
    const env = process.env.HOME
    process.env.HOME = home
    let data
    try { data = snapshot(main, null, { processes: [{ pid: 7, command: 'claude', cwd }] }) } finally { process.env.HOME = env }
    const lead = data.worktrees[0].agents.find(node => node.id === 'lead')
    assert.equal(lead.status, 'running')
    assert.equal(lead.model, 'opus-5-5')
    assert.deepEqual(lead.children.map(node => node.id), ['busy'])
    assert.equal(lead.children[0].status, 'running')
    assert.equal(lead.children[0].type, 'supervisor-implementer')
    assert.equal(lead.children[0].title, 'Implement WP-1')
    assert.equal(lead.children[0].model, 'sonnet-5')
    assert.match(render(data), /\n    \x1b\[32m●\x1b\[0m claude-code busy sonnet-5\/unknown — Implement WP-1/)
  } finally { cleanup(home, main) }
})

test('without hooks, Codex subagent threads nest under their parent thread', () => {
  const main = repo(), home = temp()
  try {
    const cwd = realpathSync(main)
    const sessions = join(home, '.codex', 'sessions', '2026', '09', '26')
    mkdirSync(sessions, { recursive: true })
    const spawn = (id, nickname) => ({ type: 'session_meta', payload: { id, session_id: 'root', parent_thread_id: 'root', cwd, agent_nickname: nickname, agent_path: `/root/${nickname.toLowerCase()}`, source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } } })
    const write = (name, rows) => writeFileSync(join(sessions, name), rows.map(JSON.stringify).join('\n') + '\n')
    write('root.jsonl', [{ type: 'session_meta', payload: { id: 'root', cwd } }])
    write('busy.jsonl', [spawn('busy', 'Boyle'), { type: 'event_msg', payload: { type: 'task_started' } }])
    write('done.jsonl', [spawn('done', 'Curie'), { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'task_complete' } }])
    const data = JSON.parse(run(tool('agent-monitor'), ['--json', '--codex'], main, { HOME: home }).stdout)
    const root = data.worktrees[0].agents.find(node => node.id === 'root')
    assert.deepEqual(root.children.map(node => node.id), ['busy'])
    assert.equal(root.children[0].title, 'Boyle (/root/boyle)')
    assert.equal(root.children[0].parentKnown, true)
  } finally { cleanup(home, main) }
})

test('outside a Git repository the folder itself is watched', () => {
  const dir = realpathSync(temp()), home = temp()
  try {
    const project = join(home, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'plain.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'plain', cwd: dir, message: { model: 'claude-haiku-4-5' } }) + '\n')
    const result = run(tool('agent-monitor'), ['--json'], dir, { HOME: home })
    assert.equal(result.status, 0, result.stderr)
    const data = JSON.parse(result.stdout)
    assert.deepEqual(data.worktrees.map(tree => tree.path), [dir])
    assert.equal(data.worktrees[0].agents[0].id, 'plain')
  } finally { cleanup(home, dir) }
})

test('hooks install into any config folder, replace the harness-supervisor copy, and come off everywhere', () => {
  const main = repo(), home = temp()
  try {
    const legacy = '"/usr/bin/node" "/old/harness-supervisor/harness/bin/agent-tree"'
    const claude = join(home, '.claude-work'), codex = join(home, '.codex'), project = join(main, '.claude')
    mkdirSync(join(claude, 'projects'), { recursive: true })
    mkdirSync(codex, { recursive: true }); writeFileSync(join(codex, 'config.toml'), '')
    mkdirSync(project, { recursive: true })
    mkdirSync(join(main, '.bin'), { recursive: true })
    symlinkSync('/old/harness-supervisor/harness/bin/agent-tree', join(main, '.bin', 'agent-tree'))
    run('git', ['config', '--local', 'hook.agent-tree-install.command', `${legacy} _install . --single`], main)
    run('git', ['config', '--local', 'hook.agent-tree-install.event', 'post-checkout'], main)
    writeFileSync(join(project, 'settings.json'), JSON.stringify({ custom: 1, hooks: { SessionStart: [
      { hooks: [{ type: 'command', command: 'true' }] },
      { hooks: [{ type: 'command', command: `${legacy} _event SessionStart claude-code` }] }
    ] } }))
    const env = { HOME: home }
    for (let i = 0; i < 2; i++) {
      const result = run(tool('agent-monitor'), ['--install-hooks', claude, codex, project], main, env)
      assert.equal(result.status, 0, result.stderr)
    }
    const self = JSON.stringify(tool('agent-monitor'))
    const settings = JSON.parse(readFileSync(join(project, 'settings.json')))
    assert.equal(settings.custom, 1)
    assert.deepEqual(settings.hooks.SessionStart.map(group => group.hooks[0].command), ['true', `${self} _event SessionStart claude-code`])
    assert.equal(JSON.parse(readFileSync(join(claude, 'settings.json'))).hooks.TeammateIdle.length, 1)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(codex, 'hooks.json'))).hooks), ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop'])
    assert.equal(existsSync(join(main, '.bin')), false)
    assert.equal(run('git', ['config', '--local', '--get', 'hook.agent-tree-install.command'], main).status, 1)

    // A global hook records a session in any project; the snapshot keeps the ones under its folder.
    const command = JSON.parse(readFileSync(join(claude, 'settings.json'))).hooks.SessionStart[0].hooks[0].command
    spawnSync('sh', ['-c', command], { cwd: main, input: JSON.stringify({ cwd: main, session_id: 'from-hook' }), env: { ...process.env, ...env } })
    assert.ok(JSON.parse(run(tool('agent-monitor'), ['--json'], main, env).stdout).worktrees[0].agents.some(node => node.id === 'from-hook'))

    assert.equal(run(tool('agent-monitor'), ['--remove-hooks', codex], main, env).status, 0)
    assert.equal(existsSync(join(codex, 'hooks.json')), false)
    assert.ok(existsSync(join(claude, 'settings.json')))
    const removed = run(tool('agent-monitor'), ['--remove-hooks'], main, env)
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(existsSync(join(claude, 'settings.json')), false)
    assert.deepEqual(JSON.parse(readFileSync(join(project, 'settings.json'))), { custom: 1, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } })
    assert.match(run(tool('agent-monitor'), ['--remove-hooks'], main, env).stdout, /no agent-monitor hooks found/)
  } finally { cleanup(home, main) }
})

test('transcripts in a second Claude config folder are found without being named', () => {
  const main = repo(), home = temp()
  try {
    const project = join(home, '.claude-personal', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'second.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'second', cwd: realpathSync(main), message: { model: 'claude-sonnet-5' } }) + '\n')
    const data = JSON.parse(run(tool('agent-monitor'), ['--json'], main, { HOME: home }).stdout)
    assert.equal(data.worktrees[0].agents[0].id, 'second')
  } finally { cleanup(home, main) }
})
