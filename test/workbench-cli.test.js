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
  readdirSync,
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
import {
  ACCOUNT_NUMBER,
  addRead,
  robinhoodRead as robinhoodReadFixture,
} from './fixtures/robinhood-portfolio-fixture.js'

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

function privateCaseForCli(input) {
  return structuredClone(input.privateCase)
}

function writePrivateCase(directory, input, value = privateCaseForCli(input)) {
  const path = join(directory, 'private-case.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

function robinhoodRead(overrides = {}) {
  const base = robinhoodReadFixture()
  return { ...base, ...structuredClone(overrides) }
}

const PRIVATE_OUTPUT = /account_number|selectedAccountNumber|netLiquidationValue|\bNLV\b|total_value|quantity|markPrice|average_buy_price|cursor|RH-PRIVATE-4321|account-number-do-not-echo/i

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
    writeFileSync(inputPath, JSON.stringify(privateCaseForCli(input)))
    const result = await run([
      '--symbol', 'aaa',
      '--case', inputPath,
      '--robinhood', '-',
      '--market-url', market.baseUrl.replace(/\/$/, ''),
      '--evaluated-at', NOW,
    ], JSON.stringify(robinhoodRead()))

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

test('workbench CLI derives ADD from a later Robinhood position page without exposing provider facts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-add-'))
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const market = await startMarketServer(input)
  const providerRead = addRead()
  providerRead.positionPages[1].positions[0].average_buy_price = 'provider-cost-do-not-echo'
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
      '--market-url', market.baseUrl, '--evaluated-at', NOW,
    ], JSON.stringify(providerRead))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).buyAction, 'ADD')
    assert.equal(result.stderr, '')
    assert.doesNotMatch(result.stdout, PRIVATE_OUTPUT)
    assert.doesNotMatch(result.stdout, /provider-cost-do-not-echo/)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workbench CLI uses the canonical default market URL with file case and Robinhood stdin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-default-market-'))
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA',
      '--case', inputPath,
      '--robinhood', '-',
      '--evaluated-at', NOW,
    ], JSON.stringify(robinhoodRead()), {
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
  const inputPath = writePrivateCase(directory, input)
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA',
      '--case', inputPath,
      '--robinhood', '-',
      '--market-url', market.baseUrl,
      '--evaluated-at', NOW,
      '--ledger', ledger,
    ], JSON.stringify(robinhoodRead()))

    assert.equal(result.status, 0, result.stderr)
    const decision = JSON.parse(result.stdout)
    assert.equal(decision.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(decision.buyAction, 'NO_ACTION')
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.doesNotMatch(result.stdout, PRIVATE_OUTPUT)
    assert.doesNotMatch(result.stdout,
      /accountId|condition|response|predicate|sourceSnapshots/)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('semantic collector-bundle problems emit only a blocked DecisionRecord and never persist collected input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-blocked-'))
  const ledger = join(directory, 'blocked.jsonl')
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const privateCaseBefore = readFileSync(inputPath, 'utf8')
  const providerRead = robinhoodRead()
  providerRead.payloadCanary = 'collected-payload-canary'
  providerRead.portfolio.data.total_value = '123456.78'
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
      '--market-url', market.baseUrl, '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(providerRead))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const decision = JSON.parse(result.stdout)
    assert.equal(decision.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(decision.buyAction, 'NO_ACTION')
    assert.ok(decision.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.equal(readFileSync(inputPath, 'utf8'), privateCaseBefore)
    assert.deepEqual(readdirSync(directory).sort(), ['blocked.jsonl', 'private-case.json'])
    for (const output of [result.stdout, result.stderr, readFileSync(ledger, 'utf8')]) {
      assert.doesNotMatch(output, PRIVATE_OUTPUT)
      assert.doesNotMatch(output, /collected-payload-canary|123456\.78/)
    }
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP failures and malicious public JSON are generic and never expose private data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-http-private-'))
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const providerInput = JSON.stringify(robinhoodRead({
    selectedAccountNumber: 'private-provider-do-not-echo',
    accounts: [{
      account_number: 'private-provider-do-not-echo',
      agentic_allowed: true,
      state: 'active',
      type: 'cash',
      deactivated: false,
      permanently_deactivated: false,
    }],
    positionPages: [{
      accountNumber: 'private-provider-do-not-echo',
      cursor: null,
      next: null,
      positions: [],
    }],
  }))
  const unavailable = await startMarketServer(input, {
    'stat.json': { status: 503, statusMessage: 'remote-do-not-echo' },
  })
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
      '--market-url', unavailable.baseUrl,
    ], providerInput)
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
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
      '--market-url', malicious.baseUrl,
    ], providerInput)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /public market data/i)
    assert.doesNotMatch(result.stderr, /private-case-do-not-echo|malicious-do-not-echo/)
  } finally {
    await malicious.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unknown, missing, malformed, and invalid top-level inputs exit one without echoing data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-invalid-input-'))
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const providerInput = JSON.stringify(robinhoodRead())
  const unknown = await run([
    '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
    '--private-secret', 'argv-do-not-echo',
  ], providerInput)
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Usage:/)
  assert.doesNotMatch(unknown.stderr, /argv-do-not-echo/)

  const missing = await run(['--symbol', 'AAA'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Usage:/)

  const malformedPath = join(directory, 'malformed-case.json')
  writeFileSync(malformedPath, '{"privateSecret":"json-do-not-echo"')
  const malformed = await run([
    '--symbol', 'AAA', '--case', malformedPath, '--robinhood', '-',
  ], providerInput)
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /valid JSON/i)
  assert.doesNotMatch(malformed.stderr, /json-do-not-echo/)

  const malformedRobinhood = await run([
    '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
  ], '{"providerSecret":"provider-json-do-not-echo"')
  assert.equal(malformedRobinhood.status, 1)
  assert.equal(malformedRobinhood.stderr, 'Unable to load collected portfolio input\n')
  assert.doesNotMatch(malformedRobinhood.stderr, /provider-json-do-not-echo/)

  const invalidUrl = await run([
    '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
    '--market-url', 'file:///url-do-not-echo',
  ], providerInput)
  assert.equal(invalidUrl.status, 1)
  assert.match(invalidUrl.stderr, /public market data/i)
  assert.doesNotMatch(invalidUrl.stderr, /url-do-not-echo/)

  const market = await startMarketServer(input)
  try {
    const invalidPath = writePrivateCase(directory, input, {
      ...privateCaseForCli(input),
      privateSecret: 'top-level-do-not-echo',
    })
    const invalid = await run([
      '--symbol', 'AAA', '--case', invalidPath, '--robinhood', '-',
      '--market-url', market.baseUrl,
    ], providerInput)
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /evaluate symbol case/i)
    assert.doesNotMatch(invalid.stderr, /top-level-do-not-echo/)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ledger appends exactly one private-safe 0600 line identical to stdout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-symbol-ledger-'))
  const ledger = join(directory, 'decisions.jsonl')
  const input = symbolMarketCase()
  const inputPath = writePrivateCase(directory, input)
  const market = await startMarketServer(input)
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(robinhoodRead()))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.equal(statSync(ledger).mode & 0o077, 0)
    assert.doesNotMatch(result.stdout, PRIVATE_OUTPUT)
    assert.doesNotMatch(result.stdout,
      /accountId|condition|response|predicate|sourceSnapshots/)

    const second = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(robinhoodRead()))
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
  const inputPath = writePrivateCase(directory, input)
  let swapped = false
  const market = await startMarketServer(input, {}, () => {
    if (swapped) return
    renameSync(validatedParent, movedParent)
    symlinkSync(attackerParent, validatedParent)
    swapped = true
  })
  try {
    const result = await run([
      '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-', '--market-url', market.baseUrl,
      '--evaluated-at', NOW, '--ledger', ledger,
    ], JSON.stringify(robinhoodRead()))

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
  const inputPath = writePrivateCase(directory, input)
  const market = await startMarketServer(input)
  const args = path => [
    '--symbol', 'AAA', '--case', inputPath, '--robinhood', '-',
    '--market-url', market.baseUrl, '--ledger', path,
  ]
  try {
    writeFileSync(ledger, '')
    chmodSync(ledger, 0o644)
    const permissive = await run(args(ledger), JSON.stringify(robinhoodRead()))
    assert.equal(permissive.status, 1)

    writeFileSync(target, '', { mode: 0o600 })
    symlinkSync(target, targetLink)
    const linkedTarget = await run(args(targetLink), JSON.stringify(robinhoodRead()))
    assert.equal(linkedTarget.status, 1)

    mkdirSync(parent)
    symlinkSync(parent, parentLink)
    const linked = await run(args(join(parentLink, 'decisions.jsonl')),
      JSON.stringify(robinhoodRead()))
    assert.equal(linked.status, 1)

    const inside = await run(args(join(ROOT, 'private-do-not-create.jsonl')),
      JSON.stringify(robinhoodRead()))
    assert.equal(inside.status, 1)

    const device = await run(args('/dev/null'), JSON.stringify(robinhoodRead()))
    assert.equal(device.status, 1)
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the collected portfolio bundle is required on stdin while the private case must be a file', async () => {
  const input = symbolMarketCase()
  const canary = 'provider-payload-do-not-echo'

  const missing = await run([
    '--symbol', 'AAA', '--case', '/private-case-do-not-read.json',
  ], canary)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Usage:/)
  assert.doesNotMatch(missing.stdout + missing.stderr, new RegExp(canary))

  const caseStdin = await run([
    '--symbol', 'AAA', '--case', '-', '--robinhood', '-',
  ], canary)
  assert.equal(caseStdin.status, 1)
  assert.match(caseStdin.stderr, /Usage:/)
  assert.doesNotMatch(caseStdin.stdout + caseStdin.stderr, new RegExp(canary))

  const robinhoodPath = await run([
    '--symbol', 'AAA', '--case', '/private-case-do-not-read.json',
    '--robinhood', '/provider-payload-do-not-read.json',
  ], JSON.stringify(input.privateCase))
  assert.equal(robinhoodPath.status, 1)
  assert.match(robinhoodPath.stderr, /Usage:/)
})
