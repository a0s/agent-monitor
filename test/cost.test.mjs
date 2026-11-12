import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repo, run, cleanup, temp, tool } from './helpers.mjs'
import { ANTHROPIC_PRICING_URL, OPENAI_PRICING_URL, claudeCost, claudePrice, codexCost, formatUsd, loadPrices, openaiPrice, parseAnthropicPricing, parseOpenAIPricing, refreshPrices } from '../lib/cost.mjs'
import { render, snapshot } from '../lib/agent-monitor.mjs'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
const reply = (id, model, usage, extra = {}) => ({ type: 'assistant', message: { id, model, usage }, ...extra })

test('model ids are matched exactly, less dates and provider prefixes, never by a shorter id', () => {
  for (const id of ['claude-opus-5-5', 'opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@20260101', 'claude-opus-5-5-20260101']) assert.equal(claudePrice(id).input, 4, id)
  assert.equal(claudePrice('claude-opus-5').input, 5)
  // An unknown newer model is not priced as the older one its id starts with.
  assert.equal(claudePrice('claude-opus-5-7'), null)
  assert.equal(claudePrice('<synthetic>'), null)
  assert.equal(claudePrice(undefined), null)
  assert.equal(openaiPrice('gpt-5.6-terra').output, 12)
  assert.equal(openaiPrice('openai/gpt-5.5-2026-05-01').input, 5)
  assert.equal(openaiPrice('gpt-5.1-codex-mini'), null)
  assert.equal(openaiPrice('gpt-6-astra').write, 12.5)
})

test('a Claude reply is counted once, with 5-minute and 1-hour cache writes at their own prices', () => {
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, cache_read_input_tokens: 100000, output_tokens: 500 }
  // Claude Code writes the same reply once per content block.
  const cost = claudeCost([reply('m1', 'claude-opus-5-5', usage), reply('m1', 'claude-opus-5-5', usage), { type: 'user', message: { role: 'user', content: 'x' } }])
  // opus-5-5: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out per million.
  close(cost.usd, (1000 * 4 + 1000 * 5 + 2000 * 8 + 100000 * 0.2 + 500 * 20) / 1e6)
  assert.deepEqual(cost.tokens, { input: 1000, cacheWrite: 3000, cacheRead: 100000, output: 500 })
  assert.deepEqual(cost.unpriced, [])
})

test('Claude replies follow /model, fast mode, US-only inference and Haiku 5.5 long prompts', () => {
  const small = { input_tokens: 1000000, output_tokens: 0 }
  const cost = claudeCost([
    reply('a', 'claude-sonnet-5-5', small),
    reply('b', 'claude-opus-5-5', { ...small, speed: 'fast' }),
    reply('c', 'claude-opus-5-5', { ...small, inference_geo: 'us' }),
    reply('d', 'claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1000000 }),
    reply('e', 'claude-haiku-5-5', { input_tokens: 1, cache_read_input_tokens: 100000, output_tokens: 1000000 })
  ])
  close(cost.usd, 2 + 8 + 4.4 + (0.01 + 0.5) + (0.0000005 + 0.005 + 2.5))
})

test('tokens on a model with no price are counted but not priced, and replies without usage are skipped', () => {
  const cost = claudeCost([reply('a', 'claude-opus-5-5', { input_tokens: 1000000 }), reply('b', 'claude-opus-9', { input_tokens: 5, output_tokens: 5 }), reply('s', '<synthetic>', { input_tokens: 0, output_tokens: 0 }), { type: 'assistant', message: { id: 'x' } }])
  close(cost.usd, 4)
  assert.deepEqual(cost.unpriced, ['claude-opus-9'])
  assert.equal(cost.tokens.input, 1000005)
  assert.equal(claudeCost([{ type: 'user' }]), undefined)
})

test('a Codex thread is priced by the difference between its totals, at the model it was on', () => {
  const total = (input, cached, output) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
  const cost = codexCost([
    { type: 'session_meta', payload: { id: 't', cwd: '/x' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    total(1000000, 400000, 100000),
    total(1000000, 400000, 100000), // reported twice
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', service_tier: 'default' } } },
    total(2000000, 1400000, 200000),
    { type: 'event_msg', payload: { type: 'token_count', info: null } }
  ])
  // terra $2 in, $0.20 cached, $12 out; luna $0.10, $0.01, $0.50.
  close(cost.usd, (600000 * 2 + 400000 * 0.2 + 100000 * 12) / 1e6 + (0 * 0.1 + 1000000 * 0.01 + 100000 * 0.5) / 1e6)
  assert.deepEqual(cost.tokens, { input: 600000, cacheWrite: 0, cacheRead: 1400000, output: 200000 })
})

test('a forked Codex thread does not count what its parent spent, and the fast tier costs double', () => {
  const count = (total, last) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } })
  const rows = [
    { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'parent', cwd: '/x' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    // The parent's 50M tokens arrive in the fork's first total.
    count({ input_tokens: 50000000, cached_input_tokens: 0, output_tokens: 1000000 }, { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 }),
    count({ input_tokens: 51000000, cached_input_tokens: 0, output_tokens: 1000000 }, { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 })
  ]
  close(codexCost(rows).usd, 8)
  rows.splice(1, 0, { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'fast' } } })
  close(codexCost(rows).usd, 16)
})

test('dollars are shown to the cent', () => {
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(0.004), '$0.00')
  assert.equal(formatUsd(12.345), '$12.35')
  assert.equal(formatUsd(1234.5), '$1235')
})

test('each session and subagent shows what its own transcript cost, with a total', () => {
  const main = repo(), home = temp()
  const events = join(process.env.AGENT_MONITOR_HOME, 'events.jsonl')
  const before = existsSync(events) ? readFileSync(events, 'utf8') : ''
  try {
    const project = join(home, '.claude', 'projects', 'p')
    const subagents = join(project, 'lead', 'subagents')
    mkdirSync(subagents, { recursive: true })
    const cwd = realpathSync(main)
    const lines = rows => rows.map(row => JSON.stringify({ cwd, sessionId: 'lead', ...row })).join('\n') + '\n'
    writeFileSync(join(project, 'lead.jsonl'), lines([{ type: 'user', message: { role: 'user', content: 'go' } }, { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 1000000, output_tokens: 10000 } } }]))
    writeFileSync(join(subagents, 'agent-busy.jsonl'), lines([{ agentId: 'busy', type: 'user', message: { role: 'user', content: 'task' } }, { agentId: 'busy', type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: { input_tokens: 500000, output_tokens: 0 } } }]))
    // With hooks, the session's own events stand in for its transcript; its cost still comes from it.
    appendFileSync(events, JSON.stringify({ at: Date.now() - 1000, event: 'SessionStart', cli: 'claude-code', cwd, payload: { session_id: 'lead', model: 'claude-opus-5-5' } }) + '\n')
    const env = process.env.HOME
    process.env.HOME = home
    let data
    try { data = snapshot(main, null, { processes: [{ pid: 7, command: 'claude', cwd }] }) } finally { process.env.HOME = env }
    const lead = data.worktrees[0].agents.find(node => node.id === 'lead')
    close(lead.cost.usd, 4.2)
    close(lead.children[0].cost.usd, 1)
    const output = render(data)
    assert.match(output, /claude-code lead opus-5-5\/unknown \$4\.20\n/)
    assert.match(output, /claude-code busy sonnet-5-5\/unknown \$1\.00\n/)
    assert.match(output, /total \$5\.20 at API list prices/)
    assert.match(render(data, { short: true }), /\x1b\[0m claude opus-5-5\/unknown \$4\.20\n/)
    const json = JSON.parse(run(tool('agent-monitor'), ['--json', '--claude-code'], main, { HOME: home }).stdout)
    assert.deepEqual(json.worktrees[0].agents.find(node => node.id === 'lead').cost.tokens, { input: 1000000, cacheWrite: 0, cacheRead: 0, output: 10000 })
  } finally { writeFileSync(events, before); cleanup(home, main) }
})

test('a cost with unpriced tokens is marked, and agents without usage show none', () => {
  const node = (id, cost) => ({ cli: 'codex', id, status: 'running', source: 'event', model: 'm', effort: 'e', parentKnown: true, children: [], cost })
  const output = render({ worktrees: [{ path: '/w', agents: [
    node('part', { usd: 1.5, tokens: {}, unpriced: ['gpt-9'] }),
    node('none', { usd: 0, tokens: {}, unpriced: ['gpt-9'] }),
    node('free', undefined)
  ] }] })
  assert.match(output, /codex part m\/e \$1\.50\+\n/)
  assert.match(output, /codex none m\/e \$\?\n/)
  assert.match(output, /codex free m\/e\n/)
  assert.match(output, /total \$1\.50\+ at API list prices/)
  assert.doesNotMatch(render({ worktrees: [{ path: '/w', agents: [node('free', undefined)] }] }), /total/)
})

// Shaped like the pages: the rows that matter, and the ones that must not be read.
const ANTHROPIC_PAGE = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Opus 6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.15 / MTok<sup>2</sup> | $15 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.1 ([retired, except on Claude Models on Google Cloud (Google managed) and Bedrock](https://x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

### Fast mode pricing

| Model | Input | Output |
| --- | --- | --- |
| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |
| Claude Opus 6 / Claude Opus 4.1 | $9 USD / MTok | $45 USD / MTok |

### Batch processing

| Model | Batch input | Batch output |
| :--- | :--- | :--- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`
const OPENAI_PAGE = `### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-7-sol | $3.00 | $15.00 | $0.30 | $3.75 | $7.50 | $6.00 |
| gpt-5.6-terra | $2.00 | $12.00 | $0.20 | $2.50 | $5.00 | $4.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.2 | $1.75 | $14.00 | $0.175 |
| gpt-5-pro | $15.00 | $120.00 | - |

### Batch pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-7-sol | $1.50 | $7.50 | $0.15 |

### Fast pricing data

| Model | Short context input | Short context output | Short context cached input |
| --- | --- | --- | --- |
| gpt-7-sol | $6.00 | $30.00 | $0.60 |
| gpt-5.5 (<272K context length) | $12.50 | $75.00 | $1.25 |

Images
Standard

### Grouped Pricing Table data

| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-7-sol | Image | $99.00 | $99.00 | $9.00 |

Specialized models
Standard

### Grouped Pricing Table data

| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $14.00 | $0.175 | - | - |
| Cyber | gpt-6-cyber (long context) | $40.00 | $150.00 | $4.00 | - | - |
`

test('the Anthropic pricing page is read into the same rows the release ships', () => {
  const rows = parseAnthropicPricing(ANTHROPIC_PAGE)
  assert.deepEqual(Object.keys(rows), ['opus-6', 'opus-5-5', 'opus-4-1', 'sonnet-5-5', 'haiku-5-5'])
  assert.deepEqual(rows['opus-6'], { input: 3, write5m: 3.75, write1h: 6, read: 0.15, output: 15, fast: 3 })
  assert.equal(rows['opus-5-5'].fast, 2)
  assert.deepEqual(rows['haiku-5-5'].over, [100000, { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 }])
  assert.equal(rows['opus-4-1'].fast, 0.6)
  assert.deepEqual(parseAnthropicPricing('# Pricing\n\nmoved'), {})
})

test('the OpenAI pricing page is read from its standard and fast text tables only', () => {
  const rows = parseOpenAIPricing(OPENAI_PAGE)
  assert.deepEqual(Object.keys(rows).sort(), ['gpt-5-pro', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.5', 'gpt-5.6-terra', 'gpt-7-sol'])
  assert.deepEqual(rows['gpt-7-sol'], { input: 3, output: 15, read: 0.3, write: 3.75, fast: 2 })
  assert.deepEqual(rows['gpt-5.5'], { input: 5, output: 30, read: 0.5, write: 5, fast: 2.5 })
  // No cached price: cached input is billed as input.
  assert.equal(rows['gpt-5-pro'].read, 15)
})

test('the shipped tables match what the parsers read off the pages', () => {
  // lib/prices.json is written by `npm run prices`; a hand edit would show up here.
  const shipped = JSON.parse(readFileSync(new URL('../lib/prices.json', import.meta.url), 'utf8'))
  assert.ok(Object.keys(shipped.claude).length >= 10 && Object.keys(shipped.openai).length >= 10)
  assert.deepEqual(claudePrice('claude-opus-5-5'), shipped.claude['opus-5-5'])
  assert.deepEqual(openaiPrice('gpt-5-codex'), shipped.openai['gpt-5'])
})

test('prices are read off the pages once a day, replace the shipped ones, and a broken page changes nothing', async () => {
  const dir = temp()
  const path = join(dir, 'prices.json')
  const pages = { [ANTHROPIC_PRICING_URL]: ANTHROPIC_PAGE, [OPENAI_PRICING_URL]: OPENAI_PAGE }
  let calls = 0
  const fetch = async url => { calls++; return { ok: true, status: 200, text: async () => pages[url] } }
  const shipped = claudePrice('claude-opus-5-5')
  try {
    assert.equal(claudePrice('claude-opus-6'), null)
    assert.equal(await refreshPrices(path, { now: 1000, fetch }), true)
    assert.equal(calls, 2)
    assert.equal(claudePrice('claude-opus-6').input, 3)
    assert.equal(openaiPrice('gpt-7-sol').output, 15)
    // Within the day the file is used as it is.
    assert.equal(await refreshPrices(path, { now: 1000 + 3600000, fetch }), false)
    assert.equal(calls, 2)
    // A day on, a page that no longer parses is refused and the last good prices stay.
    pages[ANTHROPIC_PRICING_URL] = '# Pricing\n\nmoved'
    await assert.rejects(refreshPrices(path, { now: 1000 + 86400001, fetch }), /did not parse/)
    assert.equal(claudePrice('claude-opus-6').input, 3)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).at, 1000)
    await assert.rejects(refreshPrices(path, { now: 1000 + 86400001, fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/)
  } finally {
    // Back to the shipped tables for the other tests.
    writeFileSync(path, JSON.stringify({ at: 0, claude: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x${i}`, { input: 1, output: 1 }])), openai: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x${i}`, { input: 1, output: 1 }])) }))
    loadPrices(path)
    assert.equal(claudePrice('claude-opus-5-5'), shipped)
    cleanup(dir)
  }
})

test('new prices reprice a transcript that has not changed', async () => {
  const main = repo(), home = temp(), dir = temp()
  try {
    const project = join(home, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    const cwd = realpathSync(main)
    writeFileSync(join(project, 's.jsonl'), JSON.stringify({ cwd, sessionId: 's', type: 'assistant', message: { id: 'm', model: 'claude-opus-6', usage: { input_tokens: 1000000 } } }) + '\n')
    const env = process.env.HOME
    process.env.HOME = home
    const cost = () => snapshot(main, null, { processes: [{ pid: 7, command: 'claude', cwd }] }).worktrees[0].agents[0].cost
    try {
      assert.deepEqual(cost().unpriced, ['claude-opus-6'])
      const fetch = async url => ({ ok: true, text: async () => url === ANTHROPIC_PRICING_URL ? ANTHROPIC_PAGE : OPENAI_PAGE })
      await refreshPrices(join(dir, 'prices.json'), { fetch })
      close(cost().usd, 3)
    } finally { process.env.HOME = env }
  } finally {
    const reset = join(dir, 'reset.json')
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x${i}`, { input: 1, output: 1 }]))
    writeFileSync(reset, JSON.stringify({ at: 0, claude: five, openai: five }))
    loadPrices(reset)
    cleanup(home, main, dir)
  }
})
