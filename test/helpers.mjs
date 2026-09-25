import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const root = new URL('..', import.meta.url).pathname
// Never read the real ~/.claude or ~/.codex: a test sees only the transcripts it writes.
process.env.HOME = mkdtempSync(join(tmpdir(), 'agent-monitor-home-'))
// Hooks record here whatever HOME a test gives the tool.
process.env.AGENT_MONITOR_HOME = mkdtempSync(join(tmpdir(), 'agent-monitor-state-'))
export const tool = name => join(root, 'bin', name)
export function run(cmd, args = [], cwd = root, env = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 })
}
export function temp() { return mkdtempSync(join(tmpdir(), 'agent-monitor-')) }
export function repo() {
  const dir = temp()
  run('git', ['init', '-b', 'main', dir])
  run('git', ['config', 'user.email', 'test@example.invalid'], dir)
  run('git', ['config', 'user.name', 'agent-monitor test'], dir)
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  run('git', ['add', 'README.md'], dir)
  run('git', ['commit', '-m', 'base'], dir)
  return dir
}
export function worktree(dir, name) {
  const path = join(dir, '..', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const result = run('git', ['worktree', 'add', '-b', name, path], dir)
  if (result.status !== 0) throw new Error(result.stderr)
  return path
}
export function cleanup(...paths) { for (const path of paths) rmSync(path, { recursive: true, force: true }) }
