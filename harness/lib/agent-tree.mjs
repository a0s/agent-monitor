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
function runtimeMetadata(value) {
  return {
    model: firstValue(value, ['model', 'model_name', 'modelName']),
    effort: firstValue(value, ['effort', 'reasoning_effort', 'effort_level'])
  }
}
function recovered(roots, only) {
  const rows = []
  for (const [cli, dir, depth] of [['codex', join(homedir(), '.codex', 'sessions'), 5], ['claude-code', join(homedir(), '.claude', 'projects'), 2]]) {
    if (only && cli !== only) continue
    for (const path of recentJsonl(dir, depth)) {
      try {
        const head = readFileSync(path, 'utf8').slice(0, 16384).split('\n').slice(0, 40)
        let session = null
        let model
        let effort
        for (const line of head) {
          let row; try { row = JSON.parse(line) } catch { continue }
          const metadata = [row, row.payload, row.payload?.thread_settings, row.payload?.payload, row.payload?.payload?.thread_settings]
            .map(runtimeMetadata)
          for (const item of metadata) {
            if (item.model !== undefined) model = item.model
            if (item.effort !== undefined) effort = item.effort
          }
          const cwd = row.cwd || row.payload?.cwd
          const id = row.sessionId || row.payload?.id || row.session_id
          if (!cwd || !id) continue
          let actual; try { actual = realpath(cwd) } catch { continue }
          if (!roots.some(root => actual === root || actual.startsWith(root + '/'))) continue
          session = { cwd: actual, id }
        }
        if (!session) continue
        const sidecar = readJson(path.replace(/\.jsonl$/, '.meta.json'), {})
        const sidecarMetadata = runtimeMetadata(sidecar)
        rows.push({ at: statSync(path).mtimeMs, event: 'Transcript', cli, cwd: session.cwd, payload: { session_id: session.id, transcript_path: path, model: model ?? sidecarMetadata.model, effort: effort ?? sidecarMetadata.effort } })
      } catch {}
    }
  }
  return rows
}
export function snapshot(cwd, only = null) {
  const roots = trees(cwd)
  const eventsPath = join(common(cwd), 'agent-tree', 'events.jsonl')
  const events = (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).flatMap(x => { try { return [JSON.parse(x)] } catch { return [] } }) : []).filter(x => x.at > Date.now() - 86400000)
  const seen = new Set(events.map(x => `${x.cli}:${x.payload?.session_id}`))
  for (const row of recovered(roots, only)) if (!seen.has(`${row.cli}:${row.payload.session_id}`)) events.push(row)
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
  const processes = processList().map(p => ({ ...p, cwd: processCwd(p.pid) })).filter(p => p.cwd && roots.some(r => p.cwd === r || p.cwd.startsWith(r + '/')))
  const worktrees = roots.map(path => ({ path, agents: [] }))
  const byId = new Map()
  for (const row of events) {
    if (only && row.cli !== only) continue
    const p = row.payload || {}
    const id = p.agent_id || p.session_id
    if (!id) continue
    const tree = worktrees.find(t => row.cwd === t.path || row.cwd?.startsWith(t.path + '/'))
    if (!tree) continue
    const key = `${row.cli}:${tree.path}:${id}`
    let node = byId.get(key)
    const metadata = runtimeMetadata(p)
    if (!node) {
      node = {
        id,
        cli: row.cli,
        type: p.agent_type || 'session',
        parent: p.parent_agent_id || null,
        parentKnown: !p.agent_id || Boolean(p.parent_agent_id),
        source: 'event',
        model: metadata.model ?? 'unknown',
        effort: metadata.effort ?? 'unknown',
        status: 'unknown',
        lastEvent: null,
        children: []
      }
      byId.set(key, node)
      tree.agents.push(node)
    }
    if (metadata.model !== undefined) node.model = metadata.model
    if (metadata.effort !== undefined) node.effort = metadata.effort
    node.lastEvent = row.event
    node.status = /End|Stop/.test(row.event) ? 'stopped' : 'unknown'
  }
  for (const tree of worktrees) {
    for (const p of processes.filter(p => p.cwd === tree.path || p.cwd.startsWith(tree.path + '/'))) {
      const cli = /(^|[\s/])codex(\s|$)/.test(p.command) ? 'codex' : 'claude-code'
      if (only && cli !== only) continue
      const candidates = tree.agents.filter(a => a.cli === cli && a.type === 'session' && a.status !== 'stopped')
      if (candidates.length === 1) { candidates[0].status = 'running'; candidates[0].pid = p.pid }
      else tree.agents.push({ id: `pid:${p.pid}`, cli, type: 'session', parent: null, parentKnown: true, source: 'process', status: 'running', pid: p.pid, lastEvent: null, children: [] })
    }
    const flat = tree.agents; tree.agents = []
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
    const metadata = node.source === 'event' ? ` model=${node.model} effort=${node.effort}` : ''
    const sourceLimited = node.source === 'process' ? `${dim} (process only; runtime metadata unavailable)${reset}` : ''
    const parentUnknown = node.parentKnown ? '' : `${dim} (parent unknown)${reset}`
    lines.push(`${prefix}${statusColor[node.status] || statusColor.unknown}${node.cli} ${node.id} [${node.status}]${metadata}${reset}${parentUnknown}${sourceLimited}`)
    for (const child of node.children) visit(child, prefix + '  ')
  }
  for (const tree of data.worktrees) { lines.push(tree.path); for (const node of tree.agents) visit(node, '  ') }
  return lines.join('\n')
}
