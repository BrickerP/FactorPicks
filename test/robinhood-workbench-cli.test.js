import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NOW, symbolMarketCase } from './fixtures/symbol-market-case-fixture.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/evaluate-workbench.js')

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env },
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

function writeCases(directory) {
  const input = symbolMarketCase()
  const path = join(directory, 'cases.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    candidates: [{ symbol: 'AAA', privateCase: input.privateCase }],
  }), { mode: 0o600 })
  chmodSync(path, 0o600)
  return { input, path }
}

async function startMarketServer(input) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    if (request.url.endsWith('/stat.json')) {
      response.statusCode = 200
      response.end(input.statArtifact)
      return
    }
    if (request.url.endsWith('/data-quality.json')) {
      response.statusCode = 200
      response.end(JSON.stringify(input.qualityManifest))
      return
    }
    response.statusCode = 404
    response.end('not found')
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

function baseArgs(casesPath, marketUrl) {
  return [
    '--cases', casesPath,
    '--market-url', marketUrl,
    '--evaluated-at', NOW,
  ]
}

test('reports missing and malformed RobinhoodReadV3 stdin generically before public I/O', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-provider-'))
  const { input, path } = writeCases(directory)
  const market = await startMarketServer(input)
  try {
    for (const providerInput of ['', '{"provider-canary":', '[]']) {
      const result = await run(baseArgs(path, market.baseUrl), providerInput)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, 'Unable to load Robinhood read input\n')
      assert.doesNotMatch(result.stderr, /provider-canary/)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('requires a named --cases file and rejects stdin cases before provider or network access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-cases-arg-'))
  const { input } = writeCases(directory)
  const market = await startMarketServer(input)
  try {
    for (const args of [
      ['--evaluated-at', NOW],
      ['--cases', '-'],
      ['--cases'],
    ]) {
      const result = await run(args, 'provider-canary')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Usage:/)
      assert.equal(result.stdout, '')
      assert.doesNotMatch(result.stderr, /provider-canary/)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects retired single-symbol and Robinhood flags before reading files, stdin, or network', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-retired-flags-'))
  const { input, path } = writeCases(directory)
  const market = await startMarketServer(input)
  const scenarios = [
    ['symbol', '--symbol', 'AAA'],
    ['case', '--case', path],
    ['robinhood', '--robinhood', '-'],
  ]
  try {
    for (const [name, ...flag] of scenarios) {
      const result = await run([...baseArgs(path, market.baseUrl), ...flag],
        'provider-canary')
      assert.equal(result.status, 1, name)
      assert.match(result.stderr, /Usage:/, name)
      assert.equal(result.stdout, '', name)
      assert.doesNotMatch(result.stderr, /provider-canary/, name)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects unknown and trading flags before cases, provider input, or public I/O', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-batch-trading-flags-'))
  const { input, path } = writeCases(directory)
  const market = await startMarketServer(input)
  const scenarios = [
    ['unknown', '--mystery', 'unknown-flag-canary'],
    ['order', '--order', 'OPEN'],
    ['action', '--action', 'BUY'],
    ['quantity', '--quantity', '1'],
    ['cancel', '--cancel'],
  ]
  try {
    for (const [name, ...flag] of scenarios) {
      const result = await run([...baseArgs(path, market.baseUrl), ...flag],
        'provider-canary')
      assert.equal(result.status, 1, name)
      assert.match(result.stderr, /Usage:/, name)
      assert.equal(result.stdout, '', name)
      assert.doesNotMatch(result.stderr, /provider-canary|unknown-flag-canary/, name)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
