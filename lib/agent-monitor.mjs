import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync as realpath, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HOOK_EVENTS = {
  codex: ['hooks.json', ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']],
  'claude-code': ['settings.json', ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted']]
}
// Ours in any form: this project's `agent-monitor _event`, or the agent-tree copy harness-supervisor used to link in.
const OWN_HOOK = /agent-(?:monitor|tree)"?\s+_event\s/
const DAY = 86400000
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
function inGit(cwd) { try { git(cwd, 'rev-parse', '--git-dir'); return true } catch { return false } }
// Outside a repository the folder itself is the only root; nothing else changes.
function trees(cwd) {
  if (!inGit(cwd)) return [realpath(cwd)]
  return git(cwd, 'worktree', 'list', '--porcelain').split(/\n(?=worktree )/).map(x => x.match(/^worktree (.+)/m)?.[1]).filter(Boolean).flatMap(p => { try { return [realpath(p)] } catch { return [] } })
}
function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw Error(`invalid JSON in ${path}`) }
}
function safeWrite(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
function unique(paths) { return [...new Set(paths.flatMap(path => { try { return [realpath(path)] } catch { return [] } }))] }

// Everything agent-monitor itself keeps: the events hooks record and the list of
// config folders hooks were installed into, so they can all be removed again.
export function stateDir() { return process.env.AGENT_MONITOR_HOME || join(homedir(), '.agent-monitor') }
const registryPath = () => join(stateDir(), 'hooks.json')
const eventsPath = () => join(stateDir(), 'events.jsonl')
function registry() { try { const dirs = readJson(registryPath(), {}).dirs; return Array.isArray(dirs) ? dirs : [] } catch { return [] } }
function saveRegistry(dirs) { safeWrite(registryPath(), { dirs: [...new Set(dirs)].sort() }) }

// Config folders: the defaults, whatever the environment points at, every ~/.claude* and
// ~/.codex* that holds transcripts (a second account lives in one), and any folder hooks
// were installed into. `kind` reads the folder rather than trusting its name alone.
function kind(dir) {
  if (existsSync(join(dir, 'sessions')) && !existsSync(join(dir, 'projects')) || existsSync(join(dir, 'config.toml'))) return 'codex'
  if (existsSync(join(dir, 'projects')) || existsSync(join(dir, 'settings.json'))) return 'claude-code'
  return /codex/i.test(basename(dir)) ? 'codex' : 'claude-code'
}
export function configDirs() {
  const home = homedir()
  const found = { codex: [process.env.CODEX_HOME, join(home, '.codex')], 'claude-code': [process.env.CLAUDE_CONFIG_DIR, join(home, '.claude')] }
  let entries = []; try { entries = readdirSync(home, { withFileTypes: true }) } catch {}
  for (const entry of entries) if (entry.isDirectory()) {
    if (/^\.claude/.test(entry.name) && existsSync(join(home, entry.name, 'projects'))) found['claude-code'].push(join(home, entry.name))
    if (/^\.codex/.test(entry.name) && existsSync(join(home, entry.name, 'sessions'))) found.codex.push(join(home, entry.name))
  }
  for (const dir of registry()) if (existsSync(dir)) found[kind(dir)].push(dir)
  return { codex: unique(found.codex.filter(Boolean)), 'claude-code': unique(found['claude-code'].filter(Boolean)) }
}

function hookFile(path) {
  const data = readJson(path)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw Error(`invalid JSON in ${path}`)
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks))) throw Error(`invalid hooks in ${path}`)
  for (const [event, groups] of Object.entries(data.hooks || {})) if (!Array.isArray(groups)) throw Error(`invalid ${event} hooks in ${path}`)
  return data
}
function dropOwnHooks(data) {
  let changed = false
  for (const [event, groups] of Object.entries(data.hooks || {})) {
    const kept = groups.flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group]
      const hooks = group.hooks.filter(h => !OWN_HOOK.test(h?.command || ''))
      if (hooks.length === group.hooks.length) return [group]
      changed = true
      return hooks.length ? [{ ...group, hooks }] : []
    })
    if (kept.length) data.hooks[event] = kept
    else if (changed) delete data.hooks[event]
  }
  if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks
  return changed
}
// harness-supervisor linked .bin/agent-tree into every worktree and re-ran itself from a
// post-checkout hook. Both point into a checkout that no longer ships the monitor.
function dropLegacy(project) {
  const link = join(project, '.bin', 'agent-tree')
  try { if (/\/harness\/bin\/agent-tree$/.test(readlinkSync(link))) { rmSync(link); try { rmdirSync(join(project, '.bin')) } catch {} } } catch {}
  if (!inGit(project)) return
  const key = 'hook.agent-tree-install'
  const command = spawnSync('git', ['-C', project, 'config', '--local', '--get', `${key}.command`], { encoding: 'utf8' }).stdout?.trim()
  if (command && /agent-tree"?\s+_install\b/.test(command)) spawnSync('git', ['-C', project, 'config', '--local', '--remove-section', key])
}
function configDir(path) {
  const dir = resolve(path)
  if (!existsSync(dir)) throw Error(`no such folder: ${dir}`)
  if (!statSync(dir).isDirectory()) throw Error(`not a folder: ${dir} (expected a .claude or .codex folder)`)
  return realpath(dir)
}
// Hooks go into one config folder: a user-level one (~/.claude, ~/.claude-work, ~/.codex)
// covers every project that account opens; a project's own .claude or .codex covers that
// project. `self` is the path the tool was started by, not its realpath: under Homebrew that
// is the stable bin link, which survives an upgrade where the versioned Cellar path would not.
export function installHooks(paths, self) {
  const dirs = (paths.length ? paths : [process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), process.env.CODEX_HOME || join(homedir(), '.codex')].filter(existsSync)).map(configDir)
  const plans = dirs.map(dir => { const cli = kind(dir); const [file, events] = HOOK_EVENTS[cli]; const path = join(dir, file); return { dir, cli, events, path, data: hookFile(path) } })
  for (const { dir, cli, events, path, data } of plans) {
    dropOwnHooks(data)
    if (!data.hooks) data.hooks = {}
    for (const event of events) (data.hooks[event] ||= []).push({ hooks: [{ type: 'command', command: `${JSON.stringify(self)} _event ${event} ${cli}`, timeout: 3 }] })
    safeWrite(path, data)
    dropLegacy(dirname(dir))
  }
  saveRegistry([...registry(), ...dirs])
  return plans.map(({ path, cli }) => ({ path, cli }))
}
// With no folder named, every folder hooks were ever installed into and every config folder
// this machine has lose them — including the copies harness-supervisor wrote.
export function removeHooks(paths) {
  const named = paths.map(configDir)
  const all = named.length ? named : unique([...registry(), ...Object.values(configDirs()).flat()])
  const files = all.flatMap(dir => Object.values(HOOK_EVENTS).map(([file]) => join(dir, file))).filter(path => existsSync(path))
  const plans = files.map(path => ({ path, data: hookFile(path) }))
  const removed = []
  for (const { path, data } of plans) {
    if (!dropOwnHooks(data)) continue
    if (Object.keys(data).length) safeWrite(path, data)
    else rmSync(path)
    removed.push(path)
  }
  for (const dir of all) dropLegacy(dirname(dir))
  saveRegistry(named.length ? registry().filter(dir => !named.includes(dir)) : [])
  return removed
}
// One file for every project: a hook knows its session's cwd, and a snapshot keeps the rows
// under the folder it watches. Rows older than a day are dropped once the file grows.
export function record(event, cli) {
  try {
    const raw = readFileSync(0, 'utf8')
    const payload = JSON.parse(raw)
    const cwd = realpath(payload.cwd || process.cwd())
    const path = eventsPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ at: Date.now(), event, cli, cwd, payload }) + '\n')
    if (statSync(path).size > 8 << 20) {
      const kept = readFileSync(path, 'utf8').split('\n').filter(line => { try { return JSON.parse(line).at > Date.now() - DAY } catch { return false } })
      writeFileSync(`${path}.${process.pid}`, kept.join('\n') + '\n')
      renameSync(`${path}.${process.pid}`, path)
    }
  } catch { /* Hooks are observational and must never block the CLI. */ }
}
// Every claude and codex process with its working directory: one ps, then one lsof for all of
// them (Linux reads /proc instead). Starting lsof once per process is what made a refresh slow.
function listProcesses() {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const list = (out.stdout || '').split('\n').map(x => x.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean).map(x => ({ pid: Number(x[1]), command: x[2] })).filter(x => /(^|[\s/])(codex|claude)(\s|$)/.test(x.command))
  const cwd = new Map()
  for (const { pid } of list) if (existsSync(`/proc/${pid}/cwd`)) { try { cwd.set(pid, realpath(`/proc/${pid}/cwd`)) } catch {} }
  const rest = list.filter(({ pid }) => !cwd.has(pid)).map(({ pid }) => pid)
  if (rest.length) {
    let pid = null
    for (const line of (spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', rest.join(',')], { encoding: 'utf8' }).stdout || '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1))
    }
  }
  return list.map(p => ({ ...p, cwd: cwd.get(p.pid) || null }))
}
function recentJsonl(dir, depth, result = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) recentJsonl(path, depth - 1, result)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try { if (statSync(path).mtimeMs > Date.now() - DAY) result.push(path) } catch {}
    }
  }
  return result
}
// The live view rereads every transcript each refresh; one that has not changed since the
// last pass is not parsed again. Keyed by path, invalidated by size and mtime.
const parsedTranscripts = new Map()
function parsedTranscript(path, parse, kind = 'session') {
  const st = statSync(path)
  path = `${kind}:${path}`
  const hit = parsedTranscripts.get(path)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value
  const value = parse(readFileSync(path.slice(kind.length + 1), 'utf8').split('\n'), st.mtimeMs)
  parsedTranscripts.set(path, { size: st.size, mtimeMs: st.mtimeMs, value })
  return value
}
function jsonRows(lines) { return lines.flatMap(line => { if (!line) return []; try { return [JSON.parse(line)] } catch { return [] } }) }
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
function taskTitle(value) {
  const title = firstValue(value, ['title', 'task_title', 'taskTitle', 'description'])
  return typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') || undefined : undefined
}
function teamMemberCwd(member, roots, fallback) {
  if (typeof member?.worktreePath !== 'string' || !member.worktreePath.trim()) return fallback
  try {
    const configured = realpath(resolve(member.worktreePath))
    return roots.includes(configured) ? configured : fallback
  } catch {
    return fallback
  }
}
function initialUserMessage(path) {
  try {
    return parsedTranscript(path, lines => {
      for (const line of lines) {
        let row; try { row = JSON.parse(line) } catch { continue }
        if (row.type !== 'user' || row.message?.role !== 'user') continue
        return typeof row.message.content === 'string' ? row.message.content : null
      }
      return null
    }, 'first')
  } catch { return null }
}
function worktreeAddPath(command) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  const value = token => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
  for (let index = 0; index < tokens.length; index++) {
    const token = value(tokens[index])
    if (token === '--') return tokens[index + 1] && value(tokens[index + 1])
    if (!token.startsWith('-')) return token
    if (['-b', '-B', '--orphan', '--lock', '--reason'].includes(token)) index++
  }
  return null
}
function transcriptWorktree(path, roots, cache) {
  if (cache.has(path)) return cache.get(path)
  const message = initialUserMessage(path)
  const matches = new Set()
  const directives = [
    ...(message?.matchAll(/^Worktree:\s+(.+?)(?=\s+\(|\r?$)/gm) || []),
    ...(message?.matchAll(/\bEnterWorktree with path=(\/[^\s()]+)/g) || []),
    ...(message?.matchAll(/^Work in git worktree at\s+(.+?)(?=\s+\(|\r?$)/gm) || []),
    ...(message?.matchAll(/\bgit worktree add\s+([^\r\n]+)/g) || []).map(([, command]) => [null, worktreeAddPath(command)]),
    ...(message?.matchAll(/^Work only inside\s+(\/[^\s()]+)(?=\s+\(a git worktree\b|\s+.*\bgit worktree\b)/gm) || []),
    ...(message?.matchAll(/^Work inside the worktree\s+(\/[^\s()]+)/gm) || []),
    ...(message?.matchAll(/\binside the git worktree at\s+(\/[^\s()]+)/gi) || [])
  ]
  for (const [, assigned] of directives) {
    if (!assigned) continue
    try {
      const resolved = realpath(isAbsolute(assigned) ? assigned : resolve(roots[0], assigned))
      if (roots.includes(resolved)) matches.add(resolved)
    } catch {}
  }
  const worktree = matches.size === 1 ? [...matches][0] : null
  cache.set(path, worktree)
  return worktree
}
function subagentWorktree(payload, roots, cache, claudeDirs) {
  if (!payload.agent_id) return null
  const paths = new Set()
  if (typeof payload.transcript_path === 'string') paths.add(payload.transcript_path)
  // A hook's payload names the parent's transcript; the subagent's own sits in a folder under it.
  if (payload.session_id && !/\/subagents\/agent-[^/]+\.jsonl$/.test(payload.transcript_path || '')) {
    for (const projects of claudeDirs.map(dir => join(dir, 'projects'))) {
      try {
        for (const project of readdirSync(projects)) {
          const parent = join(projects, project, `${payload.session_id}.jsonl`)
          const child = join(projects, project, payload.session_id, 'subagents', `agent-${payload.agent_id}.jsonl`)
          if (existsSync(parent) && existsSync(child)) paths.add(child)
        }
      } catch {}
    }
  }
  const matches = new Set([...paths].map(path => transcriptWorktree(path, roots, cache)).filter(Boolean))
  return matches.size === 1 ? [...matches][0] : null
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
function metadataOf(path, cli, lines) {
  let model
  let effort
  for (const line of lines) {
    let row; try { row = JSON.parse(line) } catch { continue }
    const sources = [row, row.message, row.payload, row.payload?.thread_settings, row.payload?.payload, row.payload?.payload?.thread_settings]
    for (const source of sources) {
      const metadata = runtimeMetadata(source, cli)
      if (metadata.model !== undefined) model = metadata.model
      if (metadata.effort !== undefined) effort = metadata.effort
    }
  }
  let sidecar = {}; try { sidecar = runtimeMetadata(readJson(path.replace(/\.jsonl$/, '.meta.json'), {}), cli) } catch {}
  return { model: model ?? sidecar.model, effort: effort ?? sidecar.effort }
}
function transcriptMetadata(path, cli, lines = null) {
  try { return lines ? metadataOf(path, cli, lines) : parsedTranscript(path, lines => metadataOf(path, cli, lines), `meta-${cli}`) }
  catch { return {} }
}
function within(roots, cwd) {
  let actual; try { actual = realpath(cwd) } catch { return null }
  return roots.some(root => actual === root || actual.startsWith(root + '/')) ? actual : null
}
// A subagent is done when its last turn ended without asking for a tool (Claude) or when its
// thread reported the task complete and nothing started after it (Codex). A top-level session
// between turns is merely waiting for its user, so this is only asked of subagents.
function claudeFinished(rows) {
  const last = rows.filter(row => row.type === 'user' || row.type === 'assistant').at(-1)
  return last?.type === 'assistant' && last.message?.stop_reason === 'end_turn'
}
function codexFinished(rows) {
  const last = rows.filter(row => row.type === 'event_msg' && ['task_started', 'task_complete', 'user_message', 'turn_aborted'].includes(row.payload?.type)).at(-1)
  return last?.payload?.type === 'task_complete' || last?.payload?.type === 'turn_aborted'
}
function parseSession(cli, path, lines, mtimeMs) {
  const rows = jsonRows(lines)
  let cwd = null, id = null, meta = null
  for (const row of rows) {
    if (cli === 'codex' && row.type === 'session_meta') meta = row.payload
    const rowCwd = row.cwd || row.payload?.cwd
    const rowId = row.sessionId || row.payload?.id || row.session_id
    if (rowCwd && rowId) { cwd = rowCwd; id = rowId }
  }
  if (!cwd) return null
  const payload = { session_id: id, transcript_path: path, ...transcriptMetadata(path, cli, lines) }
  const parent = meta?.parent_thread_id || meta?.source?.subagent?.thread_spawn?.parent_thread_id
  if (cli === 'codex' && parent && meta?.id) {
    const nickname = meta.agent_nickname || meta.source?.subagent?.thread_spawn?.agent_nickname
    const agentPath = meta.agent_path || meta.source?.subagent?.thread_spawn?.agent_path
    Object.assign(payload, {
      agent_id: meta.id,
      parent_agent_id: parent,
      agent_type: meta.agent_role || meta.source?.subagent?.thread_spawn?.agent_role || 'subagent',
      title: [nickname, agentPath && `(${agentPath})`].filter(Boolean).join(' ') || undefined,
      finished: codexFinished(rows)
    })
  }
  return { at: mtimeMs, cwd, payload }
}
function parseClaudeSubagent(sessionId, path, lines, mtimeMs) {
  const rows = jsonRows(lines)
  const cwd = rows.map(row => row.cwd).filter(Boolean).at(-1)
  const agentId = rows.map(row => row.agentId).filter(Boolean).at(-1) || path.match(/agent-([^/]+)\.jsonl$/)?.[1]
  if (!cwd || !agentId) return null
  const meta = readJson(path.replace(/\.jsonl$/, '.meta.json'), {})
  return { at: mtimeMs, cwd, payload: {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: meta.agentType || 'subagent',
    title: typeof meta.description === 'string' ? meta.description : undefined,
    transcript_path: path,
    ...transcriptMetadata(path, 'claude-code', lines),
    finished: claudeFinished(rows)
  } }
}
function recovered(roots, only, dirs) {
  const rows = []
  const add = (cli, parsed) => {
    const cwd = parsed && within(roots, parsed.cwd)
    if (cwd) rows.push({ at: parsed.at, event: 'Transcript', cli, cwd, payload: parsed.payload })
    return Boolean(cwd)
  }
  const sources = [...dirs.codex.map(dir => ['codex', join(dir, 'sessions'), 5]), ...dirs['claude-code'].map(dir => ['claude-code', join(dir, 'projects'), 1])]
  for (const [cli, dir, depth] of sources) {
    if (only && cli !== only) continue
    for (const path of recentJsonl(dir, depth)) {
      try {
        const session = parsedTranscript(path, (lines, mtimeMs) => parseSession(cli, path, lines, mtimeMs))
        if (!add(cli, session) || cli !== 'claude-code') continue
        // Claude keeps each subagent's transcript beside its session's: <session>/subagents/agent-<id>.jsonl
        for (const agent of recentJsonl(join(path.replace(/\.jsonl$/, ''), 'subagents'), 0)) {
          try { add(cli, parsedTranscript(agent, (lines, mtimeMs) => parseClaudeSubagent(session.payload.session_id, agent, lines, mtimeMs))) } catch {}
        }
      } catch {}
    }
  }
  return rows
}
export function snapshot(cwd, only = null, options = {}) {
  const roots = trees(cwd)
  const dirs = options.dirs || configDirs()
  const worktreeAssignmentCache = new Map()
  const events_ = eventsPath()
  const now = options.now ?? Date.now()
  const events = (existsSync(events_) ? readFileSync(events_, 'utf8').split('\n').filter(Boolean).flatMap(x => { try { return [JSON.parse(x)] } catch { return [] } }) : []).filter(x => x.at > now - DAY && roots.some(root => x.cwd === root || x.cwd?.startsWith(root + '/')))
  const transcripts = recovered(roots, only, dirs)
  const transcriptBySession = new Map(transcripts.filter(row => !row.payload.agent_id).map(row => [`${row.cli}:${row.payload.session_id}`, row]))
  // A session with hook events keeps them: its transcript would only blur a recorded end.
  // A subagent's transcript is always read, since it is what says the subagent finished.
  for (const row of transcripts) if (row.payload.agent_id || !events.some(event => `${event.cli}:${event.payload?.session_id}` === `${row.cli}:${row.payload.session_id}`)) events.push(row)
  if (!only || only === 'claude-code') {
    for (const teamRoot of dirs['claude-code'].map(dir => join(dir, 'teams')).filter(existsSync)) for (const name of readdirSync(teamRoot)) {
      let config
      try { config = readJson(join(teamRoot, name, 'config.json'), null) }
      catch { continue }
      if (!config || !Array.isArray(config.members)) continue
      const lead = config.leadSessionId || config.leadAgentId
      const leadEvent = events.find(e => e.cli === 'claude-code' && (e.payload?.session_id === lead || e.payload?.team_name === name))
      if (!leadEvent || !roots.includes(leadEvent.cwd)) continue
      for (const member of config.members) {
        if (!member.agentId || member.agentId === lead) continue
        events.push({ at: Date.now(), event: 'TeamMember', cli: 'claude-code', cwd: teamMemberCwd(member, roots, leadEvent.cwd), payload: { agent_id: member.agentId, agent_type: member.agentType || member.name || 'teammate', title: member.name, parent_agent_id: config.leadAgentId || null, session_id: lead } })
      }
    }
  }
  const titles = new Map()
  for (const row of events) for (const task of row.payload?.background_tasks || []) {
    const title = taskTitle(task)
    if (task?.id && title) titles.set(`${row.cli}:${task.id}`, title)
  }
  const processes = (options.processes || listProcesses()).filter(p => p.cwd && roots.some(r => p.cwd === r || p.cwd.startsWith(r + '/')))
  const worktrees = roots.map(path => ({ path, agents: [] }))
  const byId = new Map()
  for (const [eventOrder, row] of events.entries()) {
    if (only && row.cli !== only) continue
    const p = row.payload || {}
    const id = p.agent_id || p.session_id
    if (!id) continue
    const assignedWorktree = row.cli === 'claude-code' && row.event !== 'TeamMember' ? subagentWorktree(p, roots, worktreeAssignmentCache, dirs['claude-code']) : null
    const eventCwd = assignedWorktree || row.cwd
    const tree = worktrees.filter(t => eventCwd === t.path || eventCwd?.startsWith(t.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]
    if (!tree) continue
    const key = `${row.cli}:${tree.path}:${id}`
    let node = byId.get(key)
    const directMetadata = runtimeMetadata(p, row.cli)
    const pathMetadata = p.transcript_path ? transcriptMetadata(p.transcript_path, row.cli) : {}
    const recoveredMetadata = transcriptBySession.get(`${row.cli}:${p.session_id}`)?.payload || {}
    // A session's hook payload carries the model it STARTED on; /model changes it later
    // and only the transcript records that. Subagent payloads point at the parent transcript.
    const sources = p.agent_id ? [directMetadata, pathMetadata, recoveredMetadata] : [pathMetadata, recoveredMetadata, directMetadata]
    const metadata = {
      model: sources.map(x => x.model).find(x => x !== undefined),
      effort: sources.map(x => x.effort).find(x => x !== undefined)
    }
    const title = taskTitle(p) ?? titles.get(`${row.cli}:${id}`)
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
        title,
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
    if (title !== undefined) node.title = title
    if (row.event === 'Transcript') {
      // A transcript says what it saw last; it never reopens an end a hook recorded.
      if (p.finished) node.status = 'stopped'
      if (row.at >= node.lastAt) { node.lastAt = row.at; node.lastOrder = eventOrder }
      if (!node.lastEvent) node.lastEvent = row.event
      continue
    }
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
  }
  // Subagents run inside their session's process, so no process of their own confirms them.
  // One that has not finished and was active recently runs while its top-level session does.
  const all = worktrees.flatMap(tree => tree.agents)
  const rootOf = node => {
    for (let depth = 0; node?.parent && depth < 32; depth++) node = all.find(x => x.cli === node.cli && x.id === node.parent)
    return node
  }
  for (const node of all) if (node.parent && node.status === 'unknown' && now - node.lastAt <= 900000 && rootOf(node)?.status === 'running') node.status = 'running'
  for (const tree of worktrees) {
    const flat = tree.agents.filter(node => node.source === 'process' || node.status === 'running' || (node.status === 'unknown' && now - node.lastAt <= 900000))
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
  const statusMarker = {
    running: '\x1b[32m●\x1b[0m',
    stopped: '\x1b[2;90m○\x1b[0m',
    unknown: '\x1b[2;90m?\x1b[0m'
  }
  const reset = '\x1b[0m'
  const dim = '\x1b[2m'
  const displayId = id => String(id).replace(/^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '$1')
  const displayTitle = title => title?.length > 80 ? `${title.slice(0, 77)}…` : title
  const nodes = new Map()
  const treeByNode = new Map()
  const index = (tree, node) => {
    nodes.set(`${node.cli}:${node.id}`, node)
    treeByNode.set(node, tree)
    for (const child of node.children) index(tree, child)
  }
  for (const tree of data.worktrees) for (const node of tree.agents) index(tree, node)
  const assigned = new Set()
  const worktreesByParent = new Map()
  for (const tree of data.worktrees) for (const node of tree.agents) {
    const parent = node.parent && nodes.get(`${node.cli}:${node.parent}`)
    if (!parent || treeByNode.get(parent) === tree) continue
    assigned.add(node)
    const key = `${node.cli}:${node.parent}`
    if (!worktreesByParent.has(key)) worktreesByParent.set(key, new Map())
    const groups = worktreesByParent.get(key)
    if (!groups.has(tree)) groups.set(tree, [])
    groups.get(tree).push(node)
  }
  const rendered = new Set()
  const visit = (node, prefix = '') => {
    if (rendered.has(node)) return
    rendered.add(node)
    const metadata = node.source === 'event' ? ` ${node.model}/${node.effort}` : ''
    const title = node.source === 'event' && node.title ? ` — ${displayTitle(node.title)}` : ''
    const sourceLimited = node.source === 'process' ? `${dim} (process only; runtime metadata unavailable)${reset}` : ''
    const parentUnknown = node.parentKnown ? '' : `${dim} (parent unknown)${reset}`
    lines.push(`${prefix}${statusMarker[node.status] || statusMarker.unknown} ${node.cli} ${displayId(node.id)}${metadata}${title}${parentUnknown}${sourceLimited}`)
    for (const child of node.children) visit(child, prefix + '  ')
    for (const [tree, children] of worktreesByParent.get(`${node.cli}:${node.id}`) || []) {
      lines.push(`${prefix}  ${tree.path}`)
      for (const child of children) visit(child, prefix + '    ')
    }
  }
  for (const tree of data.worktrees) {
    const topLevel = tree.agents.filter(node => !assigned.has(node))
    if (!topLevel.length) continue
    lines.push(tree.path)
    for (const node of topLevel) visit(node, '  ')
  }
  return lines.join('\n')
}
