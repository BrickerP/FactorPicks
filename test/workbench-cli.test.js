import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { NOW, symbolMarketCase } from './fixtures/symbol-market-case-fixture.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/evaluate-workbench.js')

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

async function startMarketServer({ statArtifact, qualityManifest }, responses = {}, onRequest) {
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
      const configured = responses[name]
      const payload = name === 'stat.json'
        ? statArtifact
        : name === 'data-quality.json'
          ? JSON.stringify(qualityManifest)
          : null
      onRequest?.({ name, request })
      response.statusCode = configured?.status ?? (payload === null ? 404 : 200)
      if (configured?.statusMessage) response.statusMessage = configured.statusMessage
      response.setHeader('content-type', 'application/json')
      response.end(configured?.body ?? payload)
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

function bindStatArtifact(input, statArtifact) {
  input.statArtifact = statArtifact
  input.qualityManifest.statArtifact = {
    sha256: createHash('sha256').update(statArtifact).digest('hex'),
    bytes: Buffer.byteLength(statArtifact),
    symbols: Object.keys(JSON.parse(statArtifact)).length,
  }
}

function defaultMarketEnvironment(directory, localOrigin) {
  const preloadPath = join(directory, 'redirect-default-market.mjs')
  writeFileSync(preloadPath, `
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input)
  if (url.origin === 'https://brickerp.github.io') {
    const local = new URL(process.env.FACTORPICKS_TEST_MARKET_ORIGIN)
    url.protocol = local.protocol
    url.hostname = local.hostname
    url.port = local.port
  }
  return nativeFetch(url, init)
}
`)
  return {
    FACTORPICKS_TEST_MARKET_ORIGIN: localOrigin,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(preloadPath).href}`,
    ].filter(Boolean).join(' '),
  }
}

test('workbench CLI preserves raw stat bytes and evaluates against two public market GETs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-symbol-case-'))
  const inputPath = join(directory, 'private-case.json')
  const input = symbolMarketCase()
  bindStatArtifact(input, `\n${input.statArtifact}\n`)
  const market = await startMarketServer(input)
  try {
    writeFileSync(inputPath, JSON.stringify(input.privateCase))
    const result = await run([
      '--symbol', 'aaa',
      '--case', inputPath,
      '--market-url', market.baseUrl.replace(/\/$/, ''),
      '--evaluated-at', NOW,
    ])

    assert.equal(result.status, 0, result.stderr)
    const decision = JSON.parse(result.stdout)
    assert.equal(decision.symbol, 'AAA')
    assert.equal(decision.buyAction, 'OPEN')
    assert.deepEqual(market.requests, [
      { method: 'GET', url: '/market/stat.json', body: '' },
      { method: 'GET', url: '/market/data-quality.json', body: '' },
    ])
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workbench CLI uses the canonical default market URL and reads a case from stdin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-default-market-'))
  const input = symbolMarketCase()
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA',
      '--case', '-',
      '--evaluated-at', NOW,
    ], JSON.stringify(input.privateCase), {
      env: defaultMarketEnvironment(directory, new URL(market.baseUrl).origin),
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).buyAction, 'OPEN')
    assert.deepEqual(market.requests.map(request => request.url), [
      '/FactorPicks/stat.json',
      '/FactorPicks/data-quality.json',
    ])
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('semantic market-data problems emit a blocked DecisionRecord with exit zero', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-blocked-ledger-'))
  const ledger = join(directory, 'blocked.jsonl')
  const input = symbolMarketCase()
  input.statArtifact = '{}'
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA',
      '--case', '-',
      '--market-url', market.baseUrl,
      '--evaluated-at', NOW,
      '--ledger', ledger,
    ], JSON.stringify(input.privateCase))

    assert.equal(result.status, 0, result.stderr)
    const decision = JSON.parse(result.stdout)
    assert.equal(decision.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(decision.buyAction, 'NO_ACTION')
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.doesNotMatch(result.stdout,
      /netLiquidationValue|quantity|accountId|condition|response|predicate|sourceSnapshots/)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP failures and malicious public JSON are generic and never expose private data', async () => {
  const input = symbolMarketCase()
  input.privateCase.portfolio.portfolio.sourceRef = 'private-case-do-not-echo'
  const unavailable = await startMarketServer(input, {
    'stat.json': { status: 503, statusMessage: 'remote-do-not-echo' },
  })
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', unavailable.baseUrl,
    ], JSON.stringify(input.privateCase))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /public market data/i)
    assert.doesNotMatch(result.stderr, /private-case-do-not-echo|remote-do-not-echo/)
  } finally {
    await unavailable.close()
  }

  const malicious = await startMarketServer(input, {
    'stat.json': { body: '{"remoteSecret":"malicious-do-not-echo"' },
  })
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', malicious.baseUrl,
    ], JSON.stringify(input.privateCase))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /public market data/i)
    assert.doesNotMatch(result.stderr, /private-case-do-not-echo|malicious-do-not-echo/)
  } finally {
    await malicious.close()
  }
})

test('unknown, missing, malformed, and invalid top-level inputs exit one without echoing data', async () => {
  const input = symbolMarketCase()
  const unknown = await run([
    '--symbol', 'AAA', '--case', '-', '--private-secret', 'argv-do-not-echo',
  ], JSON.stringify(input.privateCase))
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Usage:/)
  assert.doesNotMatch(unknown.stderr, /argv-do-not-echo/)

  const missing = await run(['--symbol', 'AAA'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Usage:/)

  const malformed = await run(['--symbol', 'AAA', '--case', '-'],
    '{"privateSecret":"json-do-not-echo"')
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /valid JSON/i)
  assert.doesNotMatch(malformed.stderr, /json-do-not-echo/)

  const invalidUrl = await run([
    '--symbol', 'AAA', '--case', '-', '--market-url', 'file:///url-do-not-echo',
  ], JSON.stringify(input.privateCase))
  assert.equal(invalidUrl.status, 1)
  assert.match(invalidUrl.stderr, /public market data/i)
  assert.doesNotMatch(invalidUrl.stderr, /url-do-not-echo/)

  const market = await startMarketServer(input)
  try {
    const invalid = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', market.baseUrl,
    ], JSON.stringify({ ...input.privateCase, privateSecret: 'top-level-do-not-echo' }))
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /evaluate symbol case/i)
    assert.doesNotMatch(invalid.stderr, /top-level-do-not-echo/)
  } finally {
    await market.close()
  }
})

test('ledger appends exactly one private-safe 0600 line identical to stdout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-symbol-ledger-'))
  const ledger = join(directory, 'decisions.jsonl')
  const input = symbolMarketCase()
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(input.privateCase))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.equal(statSync(ledger).mode & 0o077, 0)
    assert.doesNotMatch(result.stdout,
      /netLiquidationValue|quantity|accountId|condition|response|predicate|sourceSnapshots/)

    const second = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(input.privateCase))
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout + second.stdout)
    assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 2)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ledger rejects a validated parent replaced by a symlink before the fd write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-symbol-ledger-race-'))
  const validatedParent = join(directory, 'validated-parent')
  const movedParent = join(directory, 'moved-parent')
  const attackerParent = join(directory, 'attacker-parent')
  const ledger = join(validatedParent, 'decisions.jsonl')
  const attackerLedger = join(attackerParent, 'decisions.jsonl')
  const sentinel = 'external-target-must-not-change\n'
  mkdirSync(validatedParent)
  mkdirSync(attackerParent)
  writeFileSync(attackerLedger, sentinel, { mode: 0o600 })
  const input = symbolMarketCase()
  let swapped = false
  const market = await startMarketServer(input, {}, () => {
    if (swapped) return
    renameSync(validatedParent, movedParent)
    symlinkSync(attackerParent, validatedParent)
    swapped = true
  })
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(input.privateCase))

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Ledger/)
    assert.equal(readFileSync(attackerLedger, 'utf8'), sentinel)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ledger rejects repository, permissive, symlinked, and device paths before HTTP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-symbol-ledger-safety-'))
  const input = symbolMarketCase()
  const ledger = join(directory, 'ledger.jsonl')
  const parent = join(directory, 'parent')
  const parentLink = join(directory, 'parent-link')
  const target = join(directory, 'target.jsonl')
  const targetLink = join(directory, 'target-link')
  const market = await startMarketServer(input)
  const args = path => [
    '--symbol', 'AAA', '--case', '-', '--market-url', market.baseUrl, '--ledger', path,
  ]
  try {
    writeFileSync(ledger, '')
    chmodSync(ledger, 0o644)
    const permissive = await run(args(ledger), JSON.stringify(input.privateCase))
    assert.equal(permissive.status, 1)

    writeFileSync(target, '', { mode: 0o600 })
    symlinkSync(target, targetLink)
    const linkedTarget = await run(args(targetLink), JSON.stringify(input.privateCase))
    assert.equal(linkedTarget.status, 1)

    mkdirSync(parent)
    symlinkSync(parent, parentLink)
    const linked = await run(args(join(parentLink, 'decisions.jsonl')),
      JSON.stringify(input.privateCase))
    assert.equal(linked.status, 1)

    const inside = await run(args(join(ROOT, 'private-do-not-create.jsonl')),
      JSON.stringify(input.privateCase))
    assert.equal(inside.status, 1)

    const device = await run(args('/dev/null'), JSON.stringify(input.privateCase))
    assert.equal(device.status, 1)
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
