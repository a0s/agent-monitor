import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const executable = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/agent-tree')
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim() }
function common(cwd) { return resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')) }
function trees(cwd) { return git(cwd, 'worktree', 'list', '--porcelain').split(/\n(?=worktree )/).map(x => x.match(/^worktree (.+)/m)?.[1]).filter(Boolean).map(p => realpath(p)) }
function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw Error(`invalid JSON in ${path}`) }
}
function pathExists(path) { try { lstatSync(path); return true } catch { return false } }
function safeWrite(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
function addHooks(path, events, cli) {
  const data = readJson(path)
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || Array.isArray(data.hooks))) throw Error(`invalid hooks in ${path}`)
  if (!data.hooks) data.hooks = {}
  for (const event of events) {
    if (data.hooks[event] !== undefined && !Array.isArray(data.hooks[event])) throw Error(`invalid ${event} hooks in ${path}`)
    if (!data.hooks[event]) data.hooks[event] = []
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(executable)} _event ${event} ${cli}`
    if (!data.hooks[event].some(group => group?.hooks?.some(h => h.command === cmd))) data.hooks[event].push({ hooks: [{ type: 'command', command: cmd, timeout: 3 }] })
  }
  safeWrite(path, data)
}
function exclude(cwd) {
  const path = join(common(cwd), 'info', 'exclude')
  const rule = '.bin/\n.codex/hooks.json\n.claude/settings.json\n'
  mkdirSync(dirname(path), { recursive: true })
  const old = existsSync(path) ? readFileSync(path, 'utf8') : ''
  let next = old
  for (const line of rule.trim().split('\n')) if (!old.split('\n').includes(line)) next += `${next.endsWith('\n') || !next ? '' : '\n'}${line}\n`
  if (next !== old) writeFileSync(path, next)
}
export function install(cwd, single = false) {
  cwd = realpath(cwd)
  checkGitVersion(git(cwd, '--version'))
  const roots = single ? [cwd] : trees(cwd)
  exclude(cwd)
  for (const root of roots) {
    if (!existsSync(root)) continue
    mkdirSync(join(root, '.bin'), { recursive: true })
    const target = join(root, '.bin', 'agent-tree')
    if (pathExists(target)) {
      if (realpath(target) !== executable) throw Error(`refusing to replace ${target}`)
    } else {
      symlink(executable, target)
    }
    addHooks(join(root, '.codex', 'hooks.json'), ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop'], 'codex')
    addHooks(join(root, '.claude', 'settings.json'), ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted'], 'claude-code')
  }
  if (!single) {
    const key = 'hook.agent-tree-install'
    const existing = spawnSync('git', ['-C', cwd, 'config', '--local', '--get', `${key}.command`], { encoding: 'utf8' }).stdout?.trim()
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(executable)} _install . --single`
    if (existing && existing !== command) throw Error(`refusing to replace ${key}.command`)
    git(cwd, 'config', '--local', '--replace-all', `${key}.command`, command)
    git(cwd, 'config', '--local', '--replace-all', `${key}.event`, 'post-checkout')
  }
}
export function checkGitVersion(output) {
  const version = output.match(/(\d+)\.(\d+)/)
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 54) throw Error('automatic worktree setup requires Git 2.54 or newer')
}
import { realpathSync as realpath, symlinkSync as symlink } from 'node:fs'
export function record(event, cli) {
  try {
    const raw = readFileSync(0, 'utf8')
    const payload = JSON.parse(raw)
    const cwd = payload.cwd || process.cwd()
    const dir = join(common(cwd), 'agent-tree')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), event, cli, cwd: realpath(cwd), payload }) + '\n')
  } catch { /* Hooks are observational and must never block the CLI. */ }
}
function processList() {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return (out.stdout || '').split('\n').map(x => x.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean).map(x => ({ pid: Number(x[1]), command: x[2] })).filter(x => /(^|[\s/])(codex|claude)(\s|$)/.test(x.command))
}
function processCwd(pid) {
  if (existsSync(`/proc/${pid}/cwd`)) { try { return realpath(`/proc/${pid}/cwd`) } catch {} }
  const out = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  return out.stdout?.split('\n').find(x => x.startsWith('n'))?.slice(1) || null
}
function recentJsonl(dir, depth, result = []) {
  if (!existsSync(dir) || result.length > 300) return result
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) recentJsonl(path, depth - 1, result)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const st = statSync(path)
      if (st.mtimeMs > Date.now() - 86400000) result.push(path)
    }
  }
  return result
}
function firstValue(value, keys) {
  for (const key of keys) if (value?.[key] != null) return value[key]
  return undefined
}
function scalarSlug(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const slug = String(value).trim()
    return slug || undefined
  }
  if (value && typeof value === 'object') return scalarSlug(value.level)
  return undefined
}
function runtimeMetadata(value, cli = null) {
  let model = scalarSlug(firstValue(value, ['model', 'model_name', 'modelName']))
  const effort = scalarSlug(firstValue(value, ['effort', 'reasoning_effort', 'effort_level']))
  if (cli === 'claude-code' && model) model = model.replace(/^claude-/i, '') || undefined
  return {
    model,
    effort
  }
}
function transcriptMetadata(path, cli, cache, lines = null) {
  const key = `${cli}:${path}`
  if (cache?.has(key)) return cache.get(key)
  let model
  let effort
  try {
    for (const line of lines ?? readFileSync(path, 'utf8').split('\n')) {
      let row; try { row = JSON.parse(line) } catch { continue }
      const sources = [row, row.message, row.payload, row.payload?.thread_settings, row.payload?.payload, row.payload?.payload?.thread_settings]
      for (const source of sources) {
        const metadata = runtimeMetadata(source, cli)
        if (metadata.model !== undefined) model = metadata.model
        if (metadata.effort !== undefined) effort = metadata.effort
      }
    }
    const sidecarMetadata = runtimeMetadata(readJson(path.replace(/\.jsonl$/, '.meta.json'), {}), cli)
    const metadata = { model: model ?? sidecarMetadata.model, effort: effort ?? sidecarMetadata.effort }
    cache?.set(key, metadata)
    return metadata
  } catch {
    const metadata = {}
    cache?.set(key, metadata)
    return metadata
  }
}
function recovered(roots, only, cache) {
  const rows = []
  for (const [cli, dir, depth] of [['codex', join(homedir(), '.codex', 'sessions'), 5], ['claude-code', join(homedir(), '.claude', 'projects'), 2]]) {
    if (only && cli !== only) continue
    for (const path of recentJsonl(dir, depth)) {
      try {
        const lines = readFileSync(path, 'utf8').split('\n')
        let session = null
        for (const line of lines) {
          let row; try { row = JSON.parse(line) } catch { continue }
          const cwd = row.cwd || row.payload?.cwd
          const id = row.sessionId || row.payload?.id || row.session_id
          if (!cwd || !id) continue
          let actual; try { actual = realpath(cwd) } catch { continue }
          if (!roots.some(root => actual === root || actual.startsWith(root + '/'))) continue
          session = { cwd: actual, id }
        }
        if (!session) continue
        const metadata = transcriptMetadata(path, cli, cache, lines)
        rows.push({ at: statSync(path).mtimeMs, event: 'Transcript', cli, cwd: session.cwd, payload: { session_id: session.id, transcript_path: path, ...metadata } })
      } catch {}
    }
  }
  return rows
}
export function snapshot(cwd, only = null, options = {}) {
  const roots = trees(cwd)
  const transcriptCache = new Map()
  const eventsPath = join(common(cwd), 'agent-tree', 'events.jsonl')
  const events = (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).flatMap(x => { try { return [JSON.parse(x)] } catch { return [] } }) : []).filter(x => x.at > Date.now() - 86400000)
  const transcripts = recovered(roots, only, transcriptCache)
  const transcriptBySession = new Map(transcripts.map(row => [`${row.cli}:${row.payload.session_id}`, row]))
  for (const row of transcripts) if (!events.some(event => `${event.cli}:${event.payload?.session_id}` === `${row.cli}:${row.payload.session_id}`)) events.push(row)
  if (!only || only === 'claude-code') {
    const teamRoot = join(homedir(), '.claude', 'teams')
    if (existsSync(teamRoot)) for (const name of readdirSync(teamRoot)) {
      let config
      try { config = readJson(join(teamRoot, name, 'config.json'), null) }
      catch { continue }
      if (!config || !Array.isArray(config.members)) continue
      const lead = config.leadSessionId || config.leadAgentId
      const leadEvent = events.find(e => e.cli === 'claude-code' && (e.payload?.session_id === lead || e.payload?.team_name === name))
      if (!leadEvent || !roots.includes(leadEvent.cwd)) continue
      for (const member of config.members) {
        if (!member.agentId || member.agentId === lead) continue
        events.push({ at: Date.now(), event: 'TeamMember', cli: 'claude-code', cwd: leadEvent.cwd, payload: { agent_id: member.agentId, agent_type: member.agentType || member.name || 'teammate', parent_agent_id: config.leadAgentId || null, session_id: lead } })
      }
    }
  }
  const processes = (options.processes || processList().map(p => ({ ...p, cwd: processCwd(p.pid) }))).filter(p => p.cwd && roots.some(r => p.cwd === r || p.cwd.startsWith(r + '/')))
  const worktrees = roots.map(path => ({ path, agents: [] }))
  const byId = new Map()
  for (const [eventOrder, row] of events.entries()) {
    if (only && row.cli !== only) continue
    const p = row.payload || {}
    const id = p.agent_id || p.session_id
    if (!id) continue
    const tree = worktrees.find(t => row.cwd === t.path || row.cwd?.startsWith(t.path + '/'))
    if (!tree) continue
    const key = `${row.cli}:${tree.path}:${id}`
    let node = byId.get(key)
    const directMetadata = runtimeMetadata(p, row.cli)
    const pathMetadata = p.transcript_path ? transcriptMetadata(p.transcript_path, row.cli, transcriptCache) : {}
    const recoveredMetadata = transcriptBySession.get(`${row.cli}:${p.session_id}`)?.payload || {}
    const metadata = {
      model: directMetadata.model ?? pathMetadata.model ?? recoveredMetadata.model,
      effort: directMetadata.effort ?? pathMetadata.effort ?? recoveredMetadata.effort
    }
    if (!node) {
      node = {
        id,
        cli: row.cli,
        type: p.agent_type || 'session',
        parent: p.parent_agent_id || (row.cli === 'claude-code' && p.agent_id ? p.session_id : null),
        parentKnown: !p.agent_id || Boolean(p.parent_agent_id || (row.cli === 'claude-code' && p.session_id)),
        source: 'event',
        model: metadata.model ?? 'unknown',
        effort: metadata.effort ?? 'unknown',
        status: 'unknown',
        lastEvent: null,
        lastAt: row.at,
        lastOrder: eventOrder,
        children: []
      }
      byId.set(key, node)
      tree.agents.push(node)
    }
    if (metadata.model !== undefined) node.model = metadata.model
    if (metadata.effort !== undefined) node.effort = metadata.effort
    node.lastEvent = row.event
    node.lastAt = row.at
    node.lastOrder = eventOrder
    node.status = /End|Stop/.test(row.event) ? 'stopped' : 'unknown'
  }
  for (const tree of worktrees) {
    for (const p of processes.filter(p => p.cwd === tree.path || p.cwd.startsWith(tree.path + '/'))) {
      const cli = /(^|[\s/])codex(\s|$)/.test(p.command) ? 'codex' : 'claude-code'
      if (only && cli !== only) continue
      if (cli === 'claude-code' && /(?:^|\s)bg-spare(?:\s|$)/.test(p.command)) continue
      const candidates = tree.agents.filter(a => a.cli === cli && a.type === 'session' && a.status !== 'stopped').sort((a, b) => b.lastAt - a.lastAt || b.lastOrder - a.lastOrder)
      if (candidates.length) { candidates[0].status = 'running'; candidates[0].pid = p.pid }
      else tree.agents.push({ id: `pid:${p.pid}`, cli, type: 'session', parent: null, parentKnown: true, source: 'process', status: 'running', pid: p.pid, lastEvent: null, children: [] })
    }
    const now = options.now ?? Date.now()
    const flat = tree.agents.filter(node => node.source === 'process' || node.status === 'running' || (node.status === 'stopped' ? now - node.lastAt <= 300000 : now - node.lastAt <= 900000))
    const retained = new Set(flat)
    let addedParent = true
    while (addedParent) {
      addedParent = false
      for (const node of [...retained]) {
        const parent = node.parent && tree.agents.find(candidate => candidate.cli === node.cli && candidate.id === node.parent)
        if (parent && !retained.has(parent)) { retained.add(parent); addedParent = true }
      }
    }
    flat.push(...tree.agents.filter(node => retained.has(node) && !flat.includes(node))); tree.agents = []
    for (const node of flat) {
      const parent = node.parent && flat.find(x => x.cli === node.cli && x.id === node.parent)
      if (parent) { parent.children.push(node); node.parentKnown = true }
      else tree.agents.push(node)
    }
  }
  return { worktrees }
}
export function render(data) {
  const lines = []
  const statusColor = { running: '\x1b[32m', stopped: '\x1b[2;90m', unknown: '\x1b[33m' }
  const reset = '\x1b[0m'
  const dim = '\x1b[2m'
  const visit = (node, prefix = '') => {
    const metadata = node.source === 'event' ? ` ${node.model}/${node.effort}` : ''
    const sourceLimited = node.source === 'process' ? `${dim} (process only; runtime metadata unavailable)${reset}` : ''
    const parentUnknown = node.parentKnown ? '' : `${dim} (parent unknown)${reset}`
    lines.push(`${prefix}${statusColor[node.status] || statusColor.unknown}${node.cli} ${node.id} [${node.status}]${metadata}${reset}${parentUnknown}${sourceLimited}`)
    for (const child of node.children) visit(child, prefix + '  ')
  }
  for (const tree of data.worktrees) { lines.push(tree.path); for (const node of tree.agents) visit(node, '  ') }
  return lines.join('\n')
}
