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

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../scripts/evaluate-decision.js', import.meta.url))

function validBundle() {
  const now = '2026-08-09T08:00:00.000Z'
  return {
    universe: {
      AAA: { sector: 'Technology', ROE: 0.1 },
      BBB: { sector: 'Technology', ROE: 0.2 },
    },
    symbol: 'AAA',
    qualityManifest: {
      schemaVersion: 1,
      generatedAt: now,
      source: 'yfinance',
      requested: 2,
      succeeded: 2,
      failed: 0,
      successRate: 1,
      coverage: { ROE: { available: 2, total: 2, rate: 1 } },
      failedSymbols: [],
    },
    underwriting: {
      longTermGate: 'PASS',
      thesisStatus: 'INTACT',
      valuationStatus: 'PASS',
      timingStatus: 'PASS',
      systemRiskLimit: 0.08,
    },
    portfolio: {
      currentPosition: 0,
      userHardLimit: 0.1,
      sectorRemainingCapacity: 0.07,
      portfolioRemainingCapacity: 0.2,
    },
    policy: {
      research: {
        factorWeights: { returnOnEquity: 1 },
        minimumSectorSampleSize: 2,
        minimumGlobalSampleSize: 2,
        manifestMaxAgeMs: 0,
        maxFutureSkewMs: 0,
        criticalFields: ['ROE'],
        minimumCriticalFieldCoverage: 1,
        minimumResearchCoverage: 1,
      },
      decision: {
        eventRiskMode: 'downgrade',
        pilotPositionLimit: 0.02,
      },
    },
    now,
  }
}

function runCli(ledgerPath) {
  return spawnSync(
    process.execPath,
    [CLI_PATH, '-', '--ledger', ledgerPath],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      input: JSON.stringify(validBundle()),
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
      const ledgerLines = readFileSync(ledgerPath, 'utf8').trim().split('\n')
      assert.equal(ledgerLines.length, 1)
      assert.deepEqual(JSON.parse(ledgerLines[0]), stdoutDecision)
    }
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
