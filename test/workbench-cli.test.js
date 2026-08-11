import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createSnapshot } from '../src/domain/contentAddressing.js'
import {
  NOW,
  STAT_ARTIFACT,
  symbolMarketCase,
} from './fixtures/symbol-market-case-fixture.js'
import {
  robinhoodQuoteResult,
  robinhoodRead,
} from './fixtures/robinhood-read-fixture.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/evaluate-workbench.js')
const PRIVATE_OUTPUT = /account_number|selectedAccountNumber|netLiquidationValue|\bNLV\b|total_value|quantity|average_buy_price|cursor|last_trade_price|last_non_reg_trade_price|venue_last_trade_time|venue_last_non_reg_trade_time|not_found|\beps\b|estimate|actual|verified|RH-PRIVATE-4321|private-case-canary|provider-canary/i

function run(args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT, ...args], {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

function artifactFixture() {
  const rows = JSON.parse(STAT_ARTIFACT)
  rows.CCC = { ...rows.BBB, name: 'CCC', ROE: 0.15 }
  const statArtifact = JSON.stringify(rows)
  const qualityManifest = structuredClone(symbolMarketCase().qualityManifest)
  qualityManifest.requested = 3
  qualityManifest.succeeded = 3
  qualityManifest.failed = 0
  qualityManifest.successRate = 1
  qualityManifest.failedSymbols = []
  qualityManifest.coverage = Object.fromEntries(
    Object.keys(qualityManifest.coverage)
      .map(field => [field, { available: 3, total: 3, rate: 1 }]),
  )
  qualityManifest.statArtifact = {
    sha256: createHash('sha256').update(statArtifact, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(statArtifact, 'utf8'),
    symbols: 3,
  }
  return { statArtifact, qualityManifest }
}

function privateCaseFor(symbol) {
  const privateCase = structuredClone(symbolMarketCase().privateCase)
  const priorSource = privateCase.sourceSnapshots[0]
  const payload = structuredClone(priorSource.payload)
  payload.symbol = symbol
  payload.facts = payload.facts.map(fact => ({
    ...fact,
    scope: { ...fact.scope, symbol },
  }))
  const source = createSnapshot('source', payload)
  privateCase.sourceSnapshots = [source.resolved]
  privateCase.evidence.drafts = privateCase.evidence.drafts.map(draft => ({
    ...draft,
    ...(draft.sourceRef === priorSource.id ? { sourceRef: source.ref.id } : {}),
    ...(draft.scope ? { scope: { ...draft.scope, symbol } } : {}),
  }))
  privateCase.underwriting.valuationDraft.symbol = symbol
  privateCase.privateCanary = undefined
  return privateCase
}

function candidateCases(symbols = ['AAA']) {
  return {
    schemaVersion: 1,
    candidates: symbols.map(symbol => ({
      symbol,
      privateCase: privateCaseFor(symbol.trim().toUpperCase()),
    })),
  }
}

function writeCases(directory, value = candidateCases(), mode = 0o600, name = 'cases.json') {
  const path = join(directory, name)
  writeFileSync(path, JSON.stringify(value), { mode })
  chmodSync(path, mode)
  return path
}

async function startMarketServer(input, { responses = {}, onRequest } = {}) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body })
      const name = request.url.endsWith('/stat.json')
        ? 'stat.json'
        : request.url.endsWith('/data-quality.json')
          ? 'data-quality.json'
          : null
      const payload = name === 'stat.json'
        ? input.statArtifact
        : name === 'data-quality.json'
          ? JSON.stringify(input.qualityManifest)
          : null
      onRequest?.({ name, request })
      response.statusCode = responses[name]?.status ?? (payload === null ? 404 : 200)
      response.setHeader('content-type', 'application/json')
      response.end(responses[name]?.body ?? payload)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/market/`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

function args(casesPath, marketUrl, ledger) {
  return [
    '--cases', casesPath,
    '--market-url', marketUrl,
    '--evaluated-at', NOW,
    ...(ledger ? ['--ledger', ledger] : []),
  ]
}

test('evaluates one candidate with one public GET per artifact and emits one JSON array line', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-one-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory)
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim().split('\n').length, 1)
    const decisions = JSON.parse(result.stdout)
    assert.ok(Array.isArray(decisions))
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].symbol, 'AAA')
    assert.equal(decisions[0].buyAction, 'OPEN')
    assert.deepEqual(market.requests, [
      { method: 'GET', url: '/market/stat.json', body: '' },
      { method: 'GET', url: '/market/data-quality.json', body: '' },
    ])
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('evaluates CCC/AAA/BBB once and returns the domain-sorted symbol array', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-three-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory, candidateCases(['CCC', ' aaa ', 'BBB']))
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl), JSON.stringify(robinhoodRead({
      targetSymbols: ['AAA', 'BBB', 'CCC'],
    })))

    assert.equal(result.status, 0, result.stderr)
    const decisions = JSON.parse(result.stdout)
    assert.deepEqual(decisions.map(decision => decision.symbol), ['AAA', 'BBB', 'CCC'])
    assert.equal(market.requests.length, 2)
    assert.deepEqual(market.requests.map(request => request.url), [
      '/market/stat.json',
      '/market/data-quality.json',
    ])
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps per-candidate semantic failure in an exit-zero DecisionRecord array', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-blocked-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory, candidateCases(['AAA', 'BBB']))
  const read = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
  read.quoteBatches[0].results = read.quoteBatches[0].results
    .filter(result => result.quote.symbol !== 'BBB')
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl), JSON.stringify(read))

    assert.equal(result.status, 0, result.stderr)
    const decisions = JSON.parse(result.stdout)
    assert.equal(decisions.length, 2)
    assert.equal(decisions.find(decision => decision.symbol === 'AAA').dataStatus, 'VALID')
    const blocked = decisions.find(decision => decision.symbol === 'BBB')
    assert.equal(blocked.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(blocked.buyAction, 'NO_ACTION')
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects target-set mismatch and retired V2 globally without stdout or ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-global-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory)
  const market = await startMarketServer(marketInput)
  try {
    for (const [name, read] of [
      ['target mismatch', robinhoodRead({ targetSymbols: ['BBB'] })],
      ['retired V2', { ...robinhoodRead({ targetSymbols: ['AAA'] }), schemaVersion: 2 }],
    ]) {
      const ledger = join(directory, `${name.replace(' ', '-')}.jsonl`)
      const result = await run(args(casesPath, market.baseUrl, ledger), JSON.stringify(read))
      assert.equal(result.status, 1, name)
      assert.equal(result.stdout, '', name)
      assert.equal(result.stderr, 'Unable to evaluate candidate batch\n', name)
      assert.equal(existsSync(ledger), false, name)
      assert.doesNotMatch(result.stderr, PRIVATE_OUTPUT, name)
    }
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('appends the exact sanitized array line once to a new 0600 ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-ledger-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory, candidateCases(['AAA', 'BBB']))
  const ledger = join(directory, 'decisions.jsonl')
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl, ledger), JSON.stringify(robinhoodRead({
      targetSymbols: ['AAA', 'BBB'],
    })))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.equal(statSync(ledger).mode & 0o777, 0o600)
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.doesNotMatch(result.stdout, PRIVATE_OUTPUT)
    assert.doesNotMatch(readFileSync(ledger, 'utf8'), PRIVATE_OUTPUT)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects a hard-linked ledger before network or evaluation without changing cases bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-hard-link-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory)
  const originalCases = readFileSync(casesPath)
  const ledger = join(directory, 'decisions.jsonl')
  linkSync(casesPath, ledger)
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl, ledger),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Ledger/)
    assert.deepEqual(readFileSync(casesPath), originalCases)
    assert.deepEqual(readFileSync(ledger), originalCases)
    assert.equal(market.requests.length, 0)
    assert.doesNotMatch(result.stdout + result.stderr, PRIVATE_OUTPUT)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('accepts a 0400 cases file and never re-reads it after public I/O begins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-read-once-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory, candidateCases(), 0o400)
  let replaced = false
  const market = await startMarketServer(marketInput, {
    onRequest: () => {
      if (replaced) return
      chmodSync(casesPath, 0o600)
      writeFileSync(casesPath, '{"private-case-canary":"must-not-be-read"}')
      chmodSync(casesPath, 0o400)
      replaced = true
    },
  })
  try {
    const result = await run(args(casesPath, market.baseUrl),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)[0].symbol, 'AAA')
    assert.doesNotMatch(result.stdout + result.stderr, /private-case-canary/)
  } finally {
    await market.close()
    chmodSync(casesPath, 0o600)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects malformed shape and canonical duplicates before stdin, network, or ledger write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-cases-shape-'))
  const marketInput = artifactFixture()
  const market = await startMarketServer(marketInput)
  const scenarios = [
    ['malformed', '{"private-case-canary":'],
    ['extra top-level', { ...candidateCases(), extra: 'private-case-canary' }],
    ['extra candidate field', {
      schemaVersion: 1,
      candidates: [{ ...candidateCases().candidates[0], extra: 'private-case-canary' }],
    }],
    ['canonical duplicate', {
      schemaVersion: 1,
      candidates: [
        { symbol: 'aaa', privateCase: privateCaseFor('AAA') },
        { symbol: ' AAA ', privateCase: privateCaseFor('AAA') },
      ],
    }],
  ]
  try {
    for (const [name, value] of scenarios) {
      const casesPath = join(directory, `${name.replaceAll(' ', '-')}.json`)
      writeFileSync(casesPath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
      chmodSync(casesPath, 0o600)
      const ledger = join(directory, `${name.replaceAll(' ', '-')}.jsonl`)
      const result = await run(args(casesPath, market.baseUrl, ledger), 'provider-canary')
      assert.equal(result.status, 1, name)
      assert.equal(result.stdout, '', name)
      assert.equal(result.stderr, 'Unable to load candidate cases\n', name)
      assert.equal(existsSync(ledger), false, name)
      assert.doesNotMatch(result.stdout + result.stderr, PRIVATE_OUTPUT, name)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects permissive, final/ancestor symlink, device, and repository cases paths before network', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-cases-safety-'))
  const target = writeCases(directory, candidateCases(), 0o600, 'target.json')
  const permissive = writeCases(directory, candidateCases(), 0o644, 'permissive.json')
  const targetLink = join(directory, 'target-link.json')
  symlinkSync(target, targetLink)
  const parent = join(directory, 'parent')
  const parentLink = join(directory, 'parent-link')
  mkdirSync(parent)
  writeCases(parent, candidateCases(), 0o600)
  symlinkSync(parent, parentLink)
  const marketInput = artifactFixture()
  const market = await startMarketServer(marketInput)
  const paths = [
    permissive,
    targetLink,
    join(parentLink, 'cases.json'),
    '/dev/null',
    join(ROOT, 'package.json'),
  ]
  try {
    for (const path of paths) {
      const result = await run(args(path, market.baseUrl), 'provider-canary')
      assert.equal(result.status, 1, path)
      assert.equal(result.stdout, '', path)
      assert.match(result.stderr, /Cases file/, path)
      assert.doesNotMatch(result.stdout + result.stderr, PRIVATE_OUTPUT, path)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects a cases parent swapped to a symlink during verified-fd open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-cases-race-'))
  const validatedParent = join(directory, 'validated-parent')
  const movedParent = join(directory, 'moved-parent')
  const attackerParent = join(directory, 'attacker-parent')
  mkdirSync(validatedParent)
  mkdirSync(attackerParent)
  const casesPath = writeCases(validatedParent)
  writeCases(attackerParent, {
    schemaVersion: 1,
    candidates: [{ symbol: 'AAA', privateCase: { privateCanary: 'private-case-canary' } }],
  })
  const preloadPath = join(directory, 'swap-cases-parent.mjs')
  writeFileSync(preloadPath, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const nativeOpen = fs.promises.open.bind(fs.promises)
let swapped = false
fs.promises.open = async (path, ...args) => {
  if (!swapped && path === process.env.FACTORPICKS_RACE_CASES_PATH) {
    fs.renameSync(process.env.FACTORPICKS_RACE_PARENT, process.env.FACTORPICKS_RACE_MOVED)
    fs.symlinkSync(process.env.FACTORPICKS_RACE_ATTACKER, process.env.FACTORPICKS_RACE_PARENT)
    swapped = true
  }
  return nativeOpen(path, ...args)
}
syncBuiltinESMExports()
`)
  const marketInput = artifactFixture()
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl), 'provider-canary', {
      env: {
        FACTORPICKS_RACE_CASES_PATH: realpathSync(casesPath),
        FACTORPICKS_RACE_PARENT: validatedParent,
        FACTORPICKS_RACE_MOVED: movedParent,
        FACTORPICKS_RACE_ATTACKER: attackerParent,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${pathToFileURL(preloadPath).href}`,
        ].filter(Boolean).join(' '),
      },
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Cases file path changed/)
    assert.equal(market.requests.length, 0)
    assert.doesNotMatch(result.stdout + result.stderr, PRIVATE_OUTPUT)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects a validated ledger parent swapped before the single append', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-ledger-race-'))
  const validatedParent = join(directory, 'validated-parent')
  const movedParent = join(directory, 'moved-parent')
  const attackerParent = join(directory, 'attacker-parent')
  mkdirSync(validatedParent)
  mkdirSync(attackerParent)
  const ledger = join(validatedParent, 'decisions.jsonl')
  const attackerLedger = join(attackerParent, 'decisions.jsonl')
  const sentinel = 'external-target-must-not-change\n'
  writeFileSync(attackerLedger, sentinel, { mode: 0o600 })
  const casesPath = writeCases(directory)
  const marketInput = artifactFixture()
  let swapped = false
  const market = await startMarketServer(marketInput, {
    onRequest: () => {
      if (swapped) return
      renameSync(validatedParent, movedParent)
      symlinkSync(attackerParent, validatedParent)
      swapped = true
    },
  })
  try {
    const result = await run(args(casesPath, market.baseUrl, ledger),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Ledger/)
    assert.equal(readFileSync(attackerLedger, 'utf8'), sentinel)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('provider and public transport errors are generic and never create the ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-transport-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory)
  const market = await startMarketServer(marketInput, {
    responses: { 'stat.json': { status: 503, body: 'remote-private-case-canary' } },
  })
  try {
    const malformedLedger = join(directory, 'malformed.jsonl')
    const malformed = await run(args(casesPath, market.baseUrl, malformedLedger),
      '{"provider-canary":')
    assert.equal(malformed.status, 1)
    assert.equal(malformed.stdout, '')
    assert.equal(malformed.stderr, 'Unable to load Robinhood read input\n')
    assert.equal(existsSync(malformedLedger), false)
    assert.equal(market.requests.length, 0)

    const publicLedger = join(directory, 'public.jsonl')
    const unavailable = await run(args(casesPath, market.baseUrl, publicLedger),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))
    assert.equal(unavailable.status, 1)
    assert.equal(unavailable.stdout, '')
    assert.equal(unavailable.stderr, 'Unable to load public market data\n')
    assert.equal(existsSync(publicLedger), false)
    assert.doesNotMatch(unavailable.stdout + unavailable.stderr, PRIVATE_OUTPUT)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects a globally invalid private case with no partial output or ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-private-global-'))
  const marketInput = artifactFixture()
  const value = candidateCases()
  value.candidates[0].privateCase = { privateCanary: 'private-case-canary' }
  const casesPath = writeCases(directory, value)
  const ledger = join(directory, 'decisions.jsonl')
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl, ledger),
      JSON.stringify(robinhoodRead({ targetSymbols: ['AAA'] })))
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Unable to evaluate candidate batch\n')
    assert.equal(existsSync(ledger), false)
    assert.doesNotMatch(result.stdout + result.stderr, PRIVATE_OUTPUT)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('official close remains unusable as a target quote in batch output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-close-'))
  const marketInput = artifactFixture()
  const casesPath = writeCases(directory)
  const read = robinhoodRead({
    targetSymbols: ['AAA'],
    quoteBatches: [{
      requestedSymbols: ['AAA'],
      results: [{
        ...robinhoodQuoteResult('AAA'),
        quote: {
          ...robinhoodQuoteResult('AAA').quote,
          has_traded: false,
          last_trade_price: null,
          venue_last_trade_time: null,
        },
        close: { symbol: 'AAA', date: '2026-08-07', price: '95' },
      }],
    }],
  })
  const market = await startMarketServer(marketInput)
  try {
    const result = await run(args(casesPath, market.baseUrl), JSON.stringify(read))
    assert.equal(result.status, 0, result.stderr)
    const decision = JSON.parse(result.stdout)[0]
    assert.equal(decision.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(decision.buyAction, 'NO_ACTION')
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
