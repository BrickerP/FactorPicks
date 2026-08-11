import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
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

async function startMarketServer(input) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body })
      if (request.url.endsWith('/stat.json')) {
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.end(input.statArtifact)
        return
      }
      if (request.url.endsWith('/data-quality.json')) {
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(input.qualityManifest))
        return
      }
      response.statusCode = 404
      response.end('not found')
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

function writePrivateCase(directory) {
  const input = symbolMarketCase()
  const casePath = join(directory, 'private-case.json')
  writeFileSync(casePath, JSON.stringify(input.privateCase))
  return { input, casePath }
}

function baseArgs(casePath, marketUrl) {
  return [
    '--symbol', 'AAA',
    '--case', casePath,
    '--market-url', marketUrl,
    '--evaluated-at', NOW,
  ]
}

test('reports RobinhoodReadV2 stdin transport failures generically while the private case is a file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-file-case-'))
  const { input, casePath } = writePrivateCase(directory)
  const market = await startMarketServer(input)
  try {
    const providerCanary = '{"providerSecret":"robinhood-provider-canary"'
    const result = await run(baseArgs(casePath, market.baseUrl), providerCanary)

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stderr, /Usage:/)
    assert.equal(result.stderr, 'Unable to load Robinhood read input\n')
    assert.doesNotMatch(result.stderr, /robinhood-provider-canary/)
    assert.equal(result.stdout, '')
    assert.equal(market.requests.length, 0)

    const missingCollection = await run(baseArgs(casePath, market.baseUrl), '')
    assert.equal(missingCollection.status, 1)
    assert.equal(missingCollection.stderr, 'Unable to load Robinhood read input\n')
    assert.equal(missingCollection.stdout, '')
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects --case - before consuming implicit RobinhoodReadV2 stdin or fetching public market data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-case-stdin-'))
  const { input } = writePrivateCase(directory)
  const market = await startMarketServer(input)
  try {
    const providerCanary = '{"providerSecret":"case-stdin-canary"}'
    const result = await run([
      '--symbol', 'AAA', '--case', '-',
      '--market-url', market.baseUrl, '--evaluated-at', NOW,
    ], providerCanary)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /case-stdin-canary/)
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects the retired --robinhood flag before implicit stdin or network access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-arg-'))
  const { input, casePath } = writePrivateCase(directory)
  const market = await startMarketServer(input)
  try {
    const scenarios = [
      ['stdin sentinel', [...baseArgs(casePath, market.baseUrl), '--robinhood', '-']],
      ['provider file path', [
        ...baseArgs(casePath, market.baseUrl),
        '--robinhood', join(directory, 'robinhood.json'),
      ]],
      ['provider flag without value', [...baseArgs(casePath, market.baseUrl), '--robinhood']],
    ]
    for (const [name, args] of scenarios) {
      const result = await run(args, '{"providerSecret":"arg-canary"}')
      assert.equal(result.status, 1, name)
      assert.match(result.stderr, /Usage:/, name)
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /arg-canary/, name)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects unknown and trading flags before consuming provider input or fetching market data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-robinhood-trade-flags-'))
  const { input, casePath } = writePrivateCase(directory)
  const market = await startMarketServer(input)
  try {
    const scenarios = [
      ['unknown', '--mystery', 'unknown-flag-canary'],
      ['order', '--order', 'OPEN'],
      ['action', '--action', 'BUY'],
      ['quantity', '--quantity', '1'],
      ['cancel', '--cancel'],
    ]
    for (const [name, ...flag] of scenarios) {
      const args = [...baseArgs(casePath, market.baseUrl)]
      args.splice(4, 0, ...flag)
      const result = await run(args, '{"providerSecret":"trade-stdin-canary"}')
      assert.equal(result.status, 1, name)
      assert.match(result.stderr, /Usage:/, name)
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /trade-stdin-canary|unknown-flag-canary/, name)
    }
    assert.equal(market.requests.length, 0)
  } finally {
    await market.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
