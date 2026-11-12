import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// What a transcript's tokens would cost at the providers' API list prices. It is an
// estimate of the API price, not a bill: a subscription pays differently, and only the
// tokens a transcript records are counted.
//
// USD per million tokens, from the providers' own pricing pages. A release carries the
// tables as they were when it was cut, for offline use; the live view reads both pages
// again once a day (refreshPrices), and what it finds there replaces them, so a new model
// or a price change does not wait for a release. A model is matched by its exact id, less
// a date suffix, so a new model is left unpriced rather than priced as an older one its id
// starts with.
export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
export const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md'
// The tables shipped with this release: what refreshPrices read off the pages when it was
// cut (npm run prices). Codex model ids the page does not list are priced as the model
// they are a build of.
const BUILT_IN = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8'))
const OPENAI_ALIASES = { 'gpt-5-codex': 'gpt-5', 'gpt-5.1-codex': 'gpt-5.1', 'gpt-5.1-codex-max': 'gpt-5.1', 'gpt-5.2-codex': 'gpt-5.2' }
// "claude-opus-4-5-20251101", "us.anthropic.claude-opus-5-5", "claude-opus-4-5@20251101",
// "claude-opus-5-5[1m]" and "opus-5-5" are all opus-5-5's row.
export function claudePrice(model) {
  if (typeof model !== 'string') return null
  const id = model.toLowerCase().trim().replace(/^.*anthropic\./, '').replace(/[@[].*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '').replace(/^claude-/, '')
  return fetched.claude[id] || BUILT_IN.claude[id] || null
}
export function openaiPrice(model) {
  if (typeof model !== 'string') return null
  let id = model.toLowerCase().trim().replace(/^.*\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  if (!fetched.openai[id] && !BUILT_IN.openai[id]) id = OPENAI_ALIASES[id] || id
  return fetched.openai[id] || BUILT_IN.openai[id] || null
}

// The pricing pages are markdown tables: a row per model, a column per kind of token.
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
function tables(md) {
  const found = []
  let heading = '', label = '', table = null
  for (const line of md.split('\n')) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue
      if (table) table.rows.push(cells(line))
      else found.push(table = { heading, label, header: cells(line).map(x => x.toLowerCase()), rows: [] })
      continue
    }
    table = null
    if (/^#+\s/.test(line)) heading = line.replace(/^#+\s*/, '').trim()
    else if (line.trim()) label = line.trim()
  }
  return found
}
const dollars = cell => { if (/^free$/i.test(cell || '')) return 0; const m = /\$\s*([\d,]*\.?\d+)/.exec(cell || ''); return m ? Number(m[1].replace(/,/g, '')) : null }
const column = (table, pattern) => table.header.findIndex(name => pattern.test(name))

// "Claude Opus 5.5" is opus-5-5; Haiku 5.5's second row is its price over 100,000 tokens.
export function parseAnthropicPricing(md) {
  const rows = {}
  const all = tables(md)
  const main = all.find(t => /^model pricing$/i.test(t.heading) && column(t, /cache hits/) >= 0)
  if (!main) return rows
  const at = { input: column(main, /^base input/), write5m: column(main, /^5m cache writes/), write1h: column(main, /^1h cache writes/), read: column(main, /^cache hits/), output: column(main, /^output/) }
  if (Object.values(at).some(i => i < 0)) return rows
  const id = name => /^claude\s/i.test(name) ? name.replace(/\s*\(.*$/, '').replace(/^claude\s+/i, '').trim().toLowerCase().replace(/[\s.]+/g, '-') : null
  for (const row of main.rows) {
    const key = id(row[0] || '')
    const price = Object.fromEntries(Object.entries(at).map(([name, i]) => [name, dollars(row[i])]))
    if (!key || Object.values(price).some(x => x === null)) continue
    const over = /over\s+([\d,]+)\s+tokens/i.exec(row[0])
    if (over && rows[key]) rows[key].over = [Number(over[1].replace(/,/g, '')), price]
    else if (!rows[key]) rows[key] = price
  }
  // Fast mode: one row may name several models ("Claude Opus 5 / Claude Opus 4.8").
  const fast = all.find(t => /^fast mode pricing$/i.test(t.heading) && column(t, /^input/) >= 0)
  for (const row of fast?.rows || []) {
    const input = dollars(row[column(fast, /^input/)])
    for (const name of (row[0] || '').split('/')) {
      const key = id(name.trim())
      if (key && rows[key] && input) rows[key].fast = Math.round(input / rows[key].input * 100) / 100
    }
  }
  return rows
}
// Text-token tables only: the image, audio and fine-tuning ones carry a column of their own.
const OPENAI_COLUMNS = /^(model|category|(short context |long context )?(input|output|cached input|30m write|12h write))$/
export function parseOpenAIPricing(md) {
  const standard = {}, fast = {}
  for (const table of tables(md)) {
    const tier = (/^(standard|fast|ultrafast|batch|flex|priority)\b/i.exec(table.heading) || /^(standard|fast|ultrafast|batch|flex|priority)$/i.exec(table.label) || [])[1]?.toLowerCase()
    if ((tier !== 'standard' && tier !== 'fast') || !table.header.every(name => OPENAI_COLUMNS.test(name))) continue
    const at = { model: column(table, /^model$/), input: column(table, /^(short context )?input$/), output: column(table, /^(short context )?output$/), read: column(table, /^(short context )?cached input$/), write: column(table, /^(short context )?30m write$/) }
    if (at.model < 0 || at.input < 0 || at.output < 0) continue
    for (const row of table.rows) {
      const name = row[at.model] || ''
      if (/long context/i.test(name)) continue
      const key = name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase()
      const input = dollars(row[at.input]), output = dollars(row[at.output])
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(key) || input === null || output === null) continue
      const target = tier === 'fast' ? fast : standard
      // Cached input with no price of its own is billed as input; so is a write.
      if (!target[key]) target[key] = { input, output, read: dollars(row[at.read]) ?? input, write: dollars(row[at.write]) ?? input }
    }
  }
  for (const [key, price] of Object.entries(fast)) if (standard[key]?.input) standard[key].fast = Math.round(price.input / standard[key].input * 100) / 100
  return standard
}

// What the pages said last, kept in one file for every run on the machine. Prices from it
// are used even when it is old: they are newer than the tables above. It is fetched again
// once a day, in the background of the live view, and never waited on.
const PRICE_TTL = 86400000
let fetched = { claude: {}, openai: {} }
let version = 0
export function pricesVersion() { return version }
function valid(table, min) { return table && typeof table === 'object' && Object.keys(table).length >= min && Object.values(table).every(row => Number.isFinite(row?.input) && Number.isFinite(row?.output)) }
function apply(data) {
  if (!valid(data?.claude, 5) || !valid(data?.openai, 5)) return false
  fetched = { claude: data.claude, openai: data.openai }
  version++
  return true
}
export function loadPrices(path) {
  try { const data = JSON.parse(readFileSync(path, 'utf8')); apply(data); return data } catch { return null }
}
export async function refreshPrices(path, { now = Date.now(), fetch = globalThis.fetch, timeout = 10000, force = false } = {}) {
  const cached = force ? null : loadPrices(path)
  if (cached && now - cached.at < PRICE_TTL) return false
  const get = async url => {
    const response = await fetch(url, { headers: { 'user-agent': 'agent-monitor (+https://github.com/a0s/agent-monitor)' }, signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
    return response.text()
  }
  const [claude, openai] = await Promise.all([get(ANTHROPIC_PRICING_URL).then(parseAnthropicPricing), get(OPENAI_PRICING_URL).then(parseOpenAIPricing)])
  const data = { at: now, claude, openai }
  // A page whose tables no longer read as expected leaves the prices as they were.
  if (!apply(data)) throw Error('the pricing pages did not parse')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.${process.pid}`, JSON.stringify(data, null, 2) + '\n')
  renameSync(`${path}.${process.pid}`, path)
  return true
}

const M = 1e6
function blank() { return { usd: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, unpriced: [] } }
function add(cost, model, tokens, usd) {
  for (const key of Object.keys(cost.tokens)) cost.tokens[key] += tokens[key]
  if (usd === null) { if (!cost.unpriced.includes(model)) cost.unpriced.push(model) }
  else cost.usd += usd
}
function done(cost) { return Object.values(cost.tokens).some(Boolean) ? cost : undefined }

// Claude Code writes one row per content block of a reply, each carrying the whole reply's
// usage, so a reply is counted once, by its message id, from the last row that names it.
export function claudeCost(rows) {
  const replies = new Map()
  for (const [index, row] of rows.entries()) {
    const usage = row?.type === 'assistant' && row.message?.usage
    if (!usage || typeof usage !== 'object') continue
    replies.set(row.message.id || row.requestId || row.uuid || `row:${index}`, { model: row.message.model, usage })
  }
  const cost = blank()
  for (const { model, usage } of replies.values()) {
    const n = key => Number.isFinite(usage[key]) ? usage[key] : 0
    const write = n('cache_creation_input_tokens')
    const write1h = Math.min(write, Number.isFinite(usage.cache_creation?.ephemeral_1h_input_tokens) ? usage.cache_creation.ephemeral_1h_input_tokens : 0)
    const tokens = { input: n('input_tokens'), cacheWrite: write, cacheRead: n('cache_read_input_tokens'), output: n('output_tokens') }
    if (!Object.values(tokens).some(Boolean)) continue
    let price = claudePrice(model)
    let usd = null
    if (price) {
      if (price.over && tokens.input + tokens.cacheWrite + tokens.cacheRead > price.over[0]) price = price.over[1]
      const factor = (usage.speed === 'fast' ? price.fast || 1 : 1) * (usage.inference_geo === 'us' ? 1.1 : 1)
      usd = factor * (tokens.input * price.input + (write - write1h) * price.write5m + write1h * price.write1h + tokens.cacheRead * price.read + tokens.output * price.output) / M
    }
    add(cost, model || 'unknown', tokens, usd)
  }
  return done(cost)
}

// Codex reports a thread's running total after each response, sometimes twice; what was
// spent between two totals is priced at the model the thread was on. A forked thread's
// first total carries what its parent spent, so the first one counts only the response it
// follows, as does a total that went down. Its input count includes cached and
// cache-written input, and its output count includes reasoning.
export function codexCost(rows) {
  const cost = blank()
  let model, tier
  let last = null
  for (const row of rows) {
    const p = row?.payload
    if (!p) continue
    const settings = p.thread_settings || p
    if ((row.type === 'turn_context' || row.type === 'session_meta' || p.type === 'thread_settings_applied') && typeof settings.model === 'string') model = settings.model
    if (typeof settings.service_tier === 'string') tier = settings.service_tier
    const total = p.type === 'token_count' && p.info?.total_token_usage
    if (!total) continue
    const n = (usage, key) => Number.isFinite(usage?.[key]) ? usage[key] : 0
    const keys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens']
    const fresh = !last || keys.some(key => n(total, key) < last[key])
    const delta = key => fresh ? n(p.info.last_token_usage || total, key) : n(total, key) - last[key]
    const cached = delta('cached_input_tokens'), written = delta('cache_write_input_tokens')
    const tokens = { input: Math.max(0, delta('input_tokens') - cached - written), cacheWrite: written, cacheRead: cached, output: delta('output_tokens') }
    last = Object.fromEntries(keys.map(key => [key, n(total, key)]))
    if (!Object.values(tokens).some(Boolean)) continue
    const price = openaiPrice(model)
    const factor = price && /^(fast|priority)$/i.test(tier || '') ? price.fast || 2 : 1
    add(cost, model || 'unknown', tokens, price ? factor * (tokens.input * price.input + tokens.cacheWrite * price.write + tokens.cacheRead * price.read + tokens.output * price.output) / M : null)
  }
  return done(cost)
}
export function formatUsd(usd) { return usd >= 1000 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}` }
