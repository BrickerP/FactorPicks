import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decisionInput } from './fixtures/decision-v2-fixture.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../scripts/evaluate-decision.js', import.meta.url))

function validBundle() {
  const bundle = decisionInput()
  bundle.evaluatedPrice.sentinel = 'do-not-copy'
  Object.assign(bundle.portfolioCapacity.currentPosition, {
    quantity: 42,
    marketValue: 1_000,
    accountId: 'secret-account',
    netLiquidationValue: 500_000,
  })
  return bundle
}

function runCli(ledgerPath, bundle = validBundle()) {
  return spawnSync(
    process.execPath,
    [CLI_PATH, '-', '--ledger', ledgerPath],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      input: JSON.stringify(bundle),
    },
  )
}

function assertLedgerRejected(ledgerPath, message) {
  const result = runCli(ledgerPath)
  assert.notEqual(result.status, 0, ledgerPath)
  assert.match(result.stderr, message, ledgerPath)
}

test('ledger rejects every repository-internal destination without creating a file', () => {
  const unique = `${process.pid}-${Date.now()}`
  const distDirectory = join(REPOSITORY_ROOT, 'dist')
  const distExisted = existsSync(distDirectory)
  const paths = [
    join(REPOSITORY_ROOT, 'public', `.decision-ledger-${unique}.jsonl`),
    join(distDirectory, `.decision-ledger-${unique}.jsonl`),
    join(REPOSITORY_ROOT, 'test', `.decision-ledger-${unique}.jsonl`),
  ]

  try {
    for (const ledgerPath of paths) {
      mkdirSync(dirname(ledgerPath), { recursive: true })
      try {
        assertLedgerRejected(
          ledgerPath,
          /ledger path must be outside the repository/i,
        )
        assert.equal(existsSync(ledgerPath), false, ledgerPath)
      } finally {
        rmSync(ledgerPath, { force: true })
      }
    }
  } finally {
    if (!distExisted) rmSync(distDirectory, { recursive: true, force: true })
  }
})

test('ledger appends only to an external absolute or resolved path', () => {
  const externalDirectory = mkdtempSync(join(tmpdir(), 'factorpicks-ledger-'))
  writeFileSync(join(externalDirectory, 'absolute.jsonl'), '')
  const cases = [
    join(externalDirectory, 'absolute.jsonl'),
    relative(REPOSITORY_ROOT, join(externalDirectory, 'resolved.jsonl')),
  ]

  try {
    for (const ledgerArgument of cases) {
      const result = runCli(ledgerArgument)
      const ledgerPath = resolve(REPOSITORY_ROOT, ledgerArgument)

      assert.equal(result.status, 0, result.stderr)
      const stdoutDecision = JSON.parse(result.stdout)
      assert.equal(stdoutDecision.schemaVersion, 2)
      assert.equal(stdoutDecision.buyAction, 'OPEN')
      assert.equal('recommendedPosition' in stdoutDecision, false)
      const ledgerLines = readFileSync(ledgerPath, 'utf8').trim().split('\n')
      assert.equal(ledgerLines.length, 1)
      const ledgerDecision = JSON.parse(ledgerLines[0])
      assert.deepEqual(ledgerDecision, stdoutDecision)
      for (const decision of [stdoutDecision, ledgerDecision]) {
        assert.doesNotMatch(
          JSON.stringify(decision),
          /netLiquidationValue|quantity|marketValue|accountId|sentinel/i,
        )
      }
    }
  } finally {
    rmSync(externalDirectory, { recursive: true, force: true })
  }
})

test('external blocker and reason codes cannot leak through stdout or ledger', () => {
  const externalDirectory = mkdtempSync(join(tmpdir(), 'factorpicks-ledger-'))
  const ledgerPath = join(externalDirectory, 'decision.jsonl')
  const bundle = validBundle()
  bundle.research.dataStatus = 'EVALUATION_BLOCKED'
  bundle.research.blockerCodes = ['accountId:RH-123']
  bundle.timingAssessment.reasonCodes = ['sentinel-private-code']

  try {
    const result = runCli(ledgerPath, bundle)
    assert.equal(result.status, 0, result.stderr)
    const stdoutDecision = JSON.parse(result.stdout)
    const ledgerDecision = JSON.parse(readFileSync(ledgerPath, 'utf8').trim())

    assert.deepEqual(ledgerDecision, stdoutDecision)
    assert.ok(stdoutDecision.blockerCodes.includes('RESEARCH_BLOCKED'))
    assert.ok(stdoutDecision.timingAssessment.reasonCodes.includes('TIMING_RESTRICTED'))
    assert.doesNotMatch(
      `${result.stdout}\n${JSON.stringify(ledgerDecision)}`,
      /RH-123|sentinel-private-code|accountId/i,
    )
  } finally {
    rmSync(externalDirectory, { recursive: true, force: true })
  }
})

test('ledger rejects symbolic links and paths resolving back into the repository', () => {
  const externalDirectory = mkdtempSync(join(tmpdir(), 'factorpicks-ledger-'))
  const realLedger = join(externalDirectory, 'real.jsonl')
  const linkedLedger = join(externalDirectory, 'linked.jsonl')
  const linkedRepositoryDirectory = join(externalDirectory, 'repository-link')
  const repositoryLedger = join(linkedRepositoryDirectory, '.decision-ledger-bypass.jsonl')

  try {
    writeFileSync(realLedger, '')
    symlinkSync(realLedger, linkedLedger)
    assertLedgerRejected(linkedLedger, /ledger path must not be a symbolic link/i)
    assert.equal(readFileSync(realLedger, 'utf8'), '')

    symlinkSync(join(REPOSITORY_ROOT, 'public'), linkedRepositoryDirectory, 'dir')
    assertLedgerRejected(repositoryLedger, /ledger path must be outside the repository/i)
    assert.equal(existsSync(repositoryLedger), false)
  } finally {
    rmSync(repositoryLedger, { force: true })
    rmSync(externalDirectory, { recursive: true, force: true })
  }
})

test('ledger rejects device paths such as /dev/stdout', () => {
  assert.equal(existsSync('/dev/stdout'), true)
  assertLedgerRejected('/dev/stdout', /symbolic link|regular file/i)
})
