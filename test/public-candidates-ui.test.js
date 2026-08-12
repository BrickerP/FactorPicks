import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  mergePublicCandidatesWithDecisions,
  parsePublicCandidateSession,
} from '../src/ui/publicCandidates.js'

const GENERATED_AT = '2026-08-13T08:00:00.000Z'
const ROW_TIME = '2026-08-13T07:59:00.123456789Z'
const CRITICAL_FIELDS = [
  'Close', 'name', 'sector', 'industry', 'Market Cap', 'P/E', 'PEG', 'ROE',
  'Debt/Eq', 'FCFF/EV',
]

function artifact(rows = {
  BBB: {
    name: 'Beta', sector: '2', industry: '20', Close: 25, currency: 'USD',
    asOf: ROW_TIME, observedAt: GENERATED_AT, 'Market Cap': '-', 'P/E': 12,
    PEG: '-', ROE: 0.1, 'Debt/Eq': 0.4, 'FCFF/EV': 0.03,
  },
  AAA: {
    name: 'Alpha', sector: '0', industry: '10', Close: 100, currency: 'USD',
    asOf: ROW_TIME, observedAt: GENERATED_AT, 'Market Cap': 1_000_000, 'P/E': 20,
    PEG: 1.5, ROE: 0.2, 'Debt/Eq': 0.1, 'FCFF/EV': 0.05,
  },
}) {
  const raw = JSON.stringify(rows)
  const succeeded = Object.keys(rows).length
  const coverage = Object.fromEntries(CRITICAL_FIELDS.map(field => {
    const available = Object.values(rows).filter(row => row[field] !== '-').length
    return [field, { available, total: succeeded, rate: available / succeeded }]
  }))
  return {
    raw,
    manifest: {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      source: 'yfinance',
      requested: succeeded,
      succeeded,
      failed: 0,
      successRate: 1,
      coverage,
      failedSymbols: [],
      statArtifact: {
        sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(raw, 'utf8'),
        symbols: succeeded,
      },
    },
  }
}

test('projects an integrity-bound public research universe in ASCII symbol order', async () => {
  const input = artifact()
  const session = await parsePublicCandidateSession(input.raw, input.manifest)

  assert.deepEqual(session.candidates, [
    {
      symbol: 'AAA', name: 'Alpha', sector: '0', industry: '10', close: 100,
      currency: 'USD', asOf: ROW_TIME, observedAt: GENERATED_AT,
      fundamentals: {
        marketCap: 1_000_000, priceToEarnings: 20, peg: 1.5,
        returnOnEquity: 0.2, debtToEquity: 0.1, freeCashFlowToEnterpriseValue: 0.05,
      },
    },
    {
      symbol: 'BBB', name: 'Beta', sector: '2', industry: '20', close: 25,
      currency: 'USD', asOf: ROW_TIME, observedAt: GENERATED_AT,
      fundamentals: {
        marketCap: null, priceToEarnings: 12, peg: null,
        returnOnEquity: 0.1, debtToEquity: 0.4, freeCashFlowToEnterpriseValue: 0.03,
      },
    },
  ])
  assert.deepEqual(session.quality, {
    generatedAt: GENERATED_AT,
    source: 'yfinance',
    requested: 2,
    succeeded: 2,
    failed: 0,
    successRate: 1,
    coverage: input.manifest.coverage,
    failedSymbols: [],
  })
  assert.ok(Object.isFrozen(session))
  assert.ok(Object.isFrozen(session.candidates[0].fundamentals))
})

test('fails closed when exact stat bytes, symbol count, counts, timestamps, or quality disagree', async () => {
  const input = artifact()
  const falseCoverage = structuredClone(input.manifest)
  falseCoverage.coverage.PEG = { available: 2, total: 2, rate: 1 }
  const invalidInputs = [
    [input.raw + ' ', input.manifest],
    [input.raw, { ...structuredClone(input.manifest), succeeded: 1 }],
    [input.raw, { ...structuredClone(input.manifest), generatedAt: 'not-a-time' }],
    [input.raw, { ...structuredClone(input.manifest), successRate: 0.5 }],
    [input.raw, falseCoverage],
  ]
  for (const [raw, manifest] of invalidInputs) {
    await assert.rejects(
      parsePublicCandidateSession(raw, manifest),
      error => error?.code === 'INVALID_PUBLIC_CANDIDATE_SESSION',
    )
  }
})

test('rejects private or decision-like fields instead of exposing or inferring them', async () => {
  const input = artifact()
  const rows = JSON.parse(input.raw)
  rows.AAA.buyAction = 'OPEN'
  const tainted = artifact(rows)
  await assert.rejects(
    parsePublicCandidateSession(tainted.raw, tainted.manifest),
    error => error?.code === 'INVALID_PUBLIC_CANDIDATE_SESSION',
  )
})

test('merges public candidates and supplied decisions with union semantics and no field rewrite', async () => {
  const session = await parsePublicCandidateSession(artifact().raw, artifact().manifest)
  const aaa = Object.freeze({ symbol: 'AAA', action: Object.freeze({ code: 'OPEN', label: '开仓' }) })
  const ccc = Object.freeze({ symbol: 'CCC', action: Object.freeze({ code: 'WATCH', label: '观察' }) })

  const merged = mergePublicCandidatesWithDecisions(session, [ccc, aaa])

  assert.deepEqual(merged.map(item => item.symbol), ['AAA', 'BBB', 'CCC'])
  assert.strictEqual(merged[0].decisionRecord, aaa)
  assert.strictEqual(merged[2].decisionRecord, ccc)
  assert.equal(merged[1].decisionRecord, null)
  assert.equal(merged[2].publicCandidate, null)
  assert.ok(!('action' in merged[1]))
  assert.ok(Object.isFrozen(merged))
})
