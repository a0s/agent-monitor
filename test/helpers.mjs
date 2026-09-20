import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const root = new URL('..', import.meta.url).pathname
export const tool = name => join(root, 'harness', 'bin', name)
export function run(cmd, args = [], cwd = root, env = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 })
}
export function temp() { return mkdtempSync(join(tmpdir(), 'harness-v2-')) }
export function repo() {
  const dir = temp()
  run('git', ['init', '-b', 'main', dir])
  run('git', ['config', 'user.email', 'test@example.invalid'], dir)
  run('git', ['config', 'user.name', 'Harness Test'], dir)
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
