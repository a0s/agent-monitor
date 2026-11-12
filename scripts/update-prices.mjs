// Reads both pricing pages and writes lib/prices.json, the tables a release ships with.
// Run before a release: npm run prices
import { refreshPrices } from '../lib/cost.mjs'
const path = new URL('../lib/prices.json', import.meta.url).pathname
await refreshPrices(path, { force: true })
process.stdout.write(`prices written to ${path}\n`)
