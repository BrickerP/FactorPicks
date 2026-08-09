import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { capacityInput } from './fixtures/portfolio-capacity-fixture.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_PATH = fileURLToPath(
  new URL('../scripts/derive-portfolio-capacity.js', import.meta.url),
)

function sensitiveInput() {
  return capacityInput({
    portfolio: {
      accountId: 'cli-sensitive-account',
      buyingPower: 12_345_678,
      costBasis: 8_765_432,
    },
  })
}

test('capacity CLI accepts stdin or one JSON file and emits only sanitized output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-capacity-'))
  const inputPath = join(directory, 'capacity.json')
  const input = sensitiveInput()
  writeFileSync(inputPath, JSON.stringify(input))

  try {
    for (const invocation of [
      { args: ['-'], input: JSON.stringify(input) },
      { args: [inputPath], input: undefined },
    ]) {
      const result = spawnSync(process.execPath, [CLI_PATH, ...invocation.args], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        input: invocation.input,
      })
      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      assert.equal(output.portfolioCapacity.currentPosition.weight, 0.02)
      assert.equal(output.resolvedSnapshots.length, 2)
      assert.doesNotMatch(
        result.stdout,
        /netLiquidationValue|quantity|markPrice|accountId|buyingPower|costBasis/i,
      )
      assert.doesNotMatch(result.stdout, /cli-sensitive-account|12345678|8765432/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('capacity CLI fails closed without echoing invalid raw facts', () => {
  const input = sensitiveInput()
  input.portfolio.netLiquidationValue = -777_777
  const result = spawnSync(process.execPath, [CLI_PATH, '-'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Portfolio capacity input is invalid/)
  assert.doesNotMatch(result.stderr, /777777|cli-sensitive-account|accountId/i)
  assert.equal(result.stdout, '')
})

test('capacity CLI supports implicit stdin and rejects malformed invocations safely', () => {
  const implicitStdin = spawnSync(process.execPath, [CLI_PATH], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(sensitiveInput()),
  })
  assert.equal(implicitStdin.status, 0, implicitStdin.stderr)
  assert.equal(JSON.parse(implicitStdin.stdout).portfolioCapacity.symbol, 'AAA')

  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-secret-path-'))
  const missing = join(directory, 'account-777777.json')
  try {
    const cases = [
      { args: ['-'], input: '{"accountId":"secret",' },
      { args: [missing], input: undefined },
      { args: ['-', 'extra-sensitive-argument'], input: '{}' },
      { args: ['--accountId=secret'], input: '{}' },
    ]
    for (const scenario of cases) {
      const result = spawnSync(process.execPath, [CLI_PATH, ...scenario.args], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        input: scenario.input,
      })
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.doesNotMatch(
        result.stderr,
        /secret|777777|accountId|extra-sensitive-argument/i,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
