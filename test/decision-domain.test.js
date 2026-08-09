import test from 'node:test'
import assert from 'node:assert/strict'

import { FACTOR_CATALOG } from '../src/domain/factorCatalog.js'
import { evaluateResearch } from '../src/domain/evaluateResearch.js'

const NOW = '2026-08-09T08:00:00.000Z'
const RESEARCH_UNIVERSE = {
  AAA: { sector: 'Technology', ROE: 0.1 },
  BBB: { sector: 'Technology', ROE: 0.2 },
  CCC: { sector: 'Healthcare', ROE: 0.3 },
}
const PYTHON_CRITICAL_FIELDS = [
  'Close',
  'name',
  'sector',
  'industry',
  'Market Cap',
  'P/E',
  'ROE',
  'Debt/Eq',
  'FCFF/EV',
]

function canonicalCoverage(total = 3) {
  return Object.fromEntries(PYTHON_CRITICAL_FIELDS.map(field => [
    field,
    { available: total, total, rate: total === 0 ? 0 : 1 },
  ]))
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-09T07:00:00.000Z',
    source: 'yfinance',
    requested: 3,
    succeeded: 3,
    failed: 0,
    successRate: 1,
    coverage: canonicalCoverage(),
    failedSymbols: [],
    ...overrides,
  }
}

function policy(overrides = {}) {
  return {
    research: {
      factorWeights: { returnOnEquity: 1 },
      minimumSectorSampleSize: 2,
      minimumGlobalSampleSize: 2,
      manifestMaxAgeMs: 3_600_000,
      maxFutureSkewMs: 0,
      criticalFields: ['ROE'],
      minimumCriticalFieldCoverage: 1,
      minimumResearchCoverage: 1,
      ...overrides.research,
    },
  }
}

test('research uses sector percentiles when the sector sample is sufficient', () => {
  const result = evaluateResearch({
    universe: RESEARCH_UNIVERSE,
    symbol: 'AAA',
    qualityManifest: manifest(),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.dataStatus, 'VALID')
  assert.deepEqual(result.metrics.returnOnEquity, {
    field: 'ROE',
    group: 'quality',
    value: 0.1,
    percentile: 0,
    peerScope: 'sector',
    peerCount: 2,
    weight: 1,
  })
  assert.equal(result.coverage.ratio, 1)
})

test('research applies the sample threshold for the peer scope it selected', () => {
  function universeWith(totalPeers, sectorPeers) {
    return Object.fromEntries(Array.from({ length: totalPeers }, (_, index) => [
      index === 0 ? 'AAA' : `P${index}`,
      {
        sector: index < sectorPeers ? 'Technology' : 'Healthcare',
        ROE: (index + 1) / 100,
      },
    ]))
  }

  const cases = [
    { name: 'three sector peers within nine global peers', total: 9, sector: 3, scope: 'sector', count: 3 },
    { name: 'nine global peers are insufficient', total: 9, sector: 2, scope: null, count: 0 },
    { name: 'ten global peers meet the fallback threshold', total: 10, sector: 2, scope: 'global', count: 10 },
  ]

  for (const scenario of cases) {
    const result = evaluateResearch({
      universe: universeWith(scenario.total, scenario.sector),
      symbol: 'AAA',
      qualityManifest: manifest(),
      policy: policy({
        research: {
          minimumSectorSampleSize: 3,
          minimumGlobalSampleSize: 10,
        },
      }),
      now: NOW,
    })

    assert.equal(result.metrics.returnOnEquity?.peerScope ?? null, scenario.scope, scenario.name)
    assert.equal(result.metrics.returnOnEquity?.peerCount ?? 0, scenario.count, scenario.name)
  }
})

test('factor catalog assigns every metric to exactly one primary group', () => {
  const fields = FACTOR_CATALOG.map(factor => factor.field)
  const groups = new Set(FACTOR_CATALOG.map(factor => factor.group))

  assert.equal(new Set(fields).size, fields.length)
  assert.deepEqual([...groups].sort(), [
    'financialSafety',
    'growth',
    'quality',
    'valuation',
  ])
})

test('research falls back globally and does not redistribute a missing factor weight', () => {
  const universe = {
    AAA: { sector: 'Technology', ROE: 0.2 },
    BBB: { sector: 'Healthcare', ROE: 0.1, 'P/E': 10 },
    CCC: { sector: 'Healthcare', ROE: 0.3, 'P/E': 20 },
  }

  const result = evaluateResearch({
    universe,
    symbol: 'AAA',
    qualityManifest: manifest(),
    policy: policy({
      research: {
        factorWeights: { returnOnEquity: 1, priceToEarnings: 1 },
        minimumResearchCoverage: 0.5,
      },
    }),
    now: NOW,
  })

  assert.equal(result.metrics.returnOnEquity.peerScope, 'global')
  assert.deepEqual(result.metrics.priceToEarnings, {
    field: 'P/E',
    group: 'valuation',
    value: null,
    percentile: null,
    peerScope: null,
    peerCount: 0,
    weight: 1,
  })
  assert.equal(result.coverage.ratio, 0.5)
  assert.equal(result.compositeScore, 25)
})

test('research coverage below policy blocks fundamental research', () => {
  const universe = {
    AAA: { sector: 'Technology', ROE: 0.2 },
    BBB: { sector: 'Healthcare', ROE: 0.1, 'P/E': 10 },
    CCC: { sector: 'Healthcare', ROE: 0.3, 'P/E': 20 },
  }

  const assessedResearch = evaluateResearch({
    universe,
    symbol: 'AAA',
    qualityManifest: manifest(),
    policy: policy({
      research: {
        factorWeights: { returnOnEquity: 1, priceToEarnings: 1 },
        minimumResearchCoverage: 0.75,
      },
    }),
    now: NOW,
  })

  assert.equal(assessedResearch.coverage.ratio, 0.5)
  assert.equal(assessedResearch.dataStatus, 'BLOCKED')
  assert.ok(assessedResearch.blockers.some(
    blocker => blocker.code === 'INSUFFICIENT_RESEARCH_COVERAGE',
  ))

})

test('manifest success rate accepts the producer six-decimal rounding', () => {
  const result = evaluateResearch({
    universe: RESEARCH_UNIVERSE,
    symbol: 'AAA',
    qualityManifest: manifest({
      requested: 6,
      succeeded: 5,
      failed: 1,
      successRate: 0.833333,
      coverage: canonicalCoverage(5),
      failedSymbols: ['ZZZ'],
    }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.dataStatus, 'VALID')
  assert.ok(!result.blockers.some(
    blocker => blocker.code === 'MANIFEST_SUCCESS_RATE_CONFLICT',
  ))
})

test('JS manifest validation mirrors Python producer quality minima and critical fields', () => {
  const missingCriticalCoverage = canonicalCoverage()
  delete missingCriticalCoverage.Close
  const lowCriticalCoverage = canonicalCoverage()
  lowCriticalCoverage.Close = { available: 1, total: 3, rate: 0.333333 }
  const cases = [
    {
      name: 'missing Python critical coverage field',
      qualityManifest: manifest({ coverage: missingCriticalCoverage }),
      code: 'MISSING_CANONICAL_COVERAGE_FIELD',
    },
    {
      name: 'success below Python producer minimum',
      qualityManifest: manifest({
        requested: 5,
        succeeded: 3,
        failed: 2,
        successRate: 0.6,
        failedSymbols: ['DDD', 'EEE'],
      }),
      code: 'MANIFEST_SUCCESS_RATE_BELOW_MINIMUM',
    },
    {
      name: 'critical coverage below Python producer minimum',
      qualityManifest: manifest({ coverage: lowCriticalCoverage }),
      code: 'MANIFEST_CRITICAL_FIELD_COVERAGE_BELOW_MINIMUM',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateResearch({
      universe: RESEARCH_UNIVERSE,
      symbol: 'AAA',
      qualityManifest: scenario.qualityManifest,
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.name)
    assert.ok(result.blockers.some(blocker => blocker.code === scenario.code), scenario.name)
  }
})

test('research rejects forged or internally inconsistent quality manifests', () => {
  const cases = [
    {
      name: 'unsupported schema',
      qualityManifest: manifest({ schemaVersion: 2 }),
      code: 'UNSUPPORTED_QUALITY_MANIFEST_SCHEMA',
    },
    {
      name: 'forged source',
      qualityManifest: manifest({ source: 'forged-producer' }),
      code: 'UNEXPECTED_QUALITY_MANIFEST_SOURCE',
    },
    {
      name: 'negative count',
      qualityManifest: manifest({ requested: 2, succeeded: 3, failed: -1 }),
      code: 'INVALID_MANIFEST_COUNTS',
    },
    {
      name: 'coverage total differs from succeeded',
      qualityManifest: manifest({
        coverage: { ROE: { available: 2, total: 2, rate: 1 } },
      }),
      code: 'MANIFEST_COVERAGE_COUNTS_CONFLICT',
    },
    {
      name: 'coverage rate differs from counts',
      qualityManifest: manifest({
        coverage: { ROE: { available: 2, total: 3, rate: 1 } },
      }),
      code: 'MANIFEST_COVERAGE_RATE_CONFLICT',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateResearch({
      universe: RESEARCH_UNIVERSE,
      symbol: 'AAA',
      qualityManifest: scenario.qualityManifest,
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.name)
    assert.ok(result.blockers.some(blocker => blocker.code === scenario.code), scenario.name)
    assert.equal(result.compositeScore, null, scenario.name)
  }
})

test('research rejects invalid policy before scoring', () => {
  const cases = [
    {
      name: 'empty factor weights',
      researchPolicy: { factorWeights: {} },
      code: 'MISSING_POSITIVE_FACTOR_WEIGHT',
    },
    {
      name: 'only unknown factor key',
      researchPolicy: { factorWeights: { inventedFactor: 1 } },
      code: 'UNKNOWN_FACTOR_WEIGHT',
    },
    {
      name: 'negative factor weight',
      researchPolicy: { factorWeights: { returnOnEquity: -1 } },
      code: 'INVALID_FACTOR_WEIGHT',
    },
    {
      name: 'non-finite factor weight',
      researchPolicy: { factorWeights: { returnOnEquity: Number.NaN } },
      code: 'INVALID_FACTOR_WEIGHT',
    },
    {
      name: 'zero minimum research coverage',
      researchPolicy: { minimumResearchCoverage: 0 },
      code: 'INVALID_MINIMUM_RESEARCH_COVERAGE',
    },
    {
      name: 'minimum research coverage above one',
      researchPolicy: { minimumResearchCoverage: 1.01 },
      code: 'INVALID_MINIMUM_RESEARCH_COVERAGE',
    },
    {
      name: 'non-positive sector sample size',
      researchPolicy: { minimumSectorSampleSize: 0 },
      code: 'INVALID_RESEARCH_SAMPLE_SIZE',
    },
    {
      name: 'fractional global sample size',
      researchPolicy: { minimumGlobalSampleSize: 1.5 },
      code: 'INVALID_RESEARCH_SAMPLE_SIZE',
    },
    {
      name: 'negative manifest age',
      researchPolicy: { manifestMaxAgeMs: -1 },
      code: 'INVALID_RESEARCH_MANIFEST_AGE',
    },
    {
      name: 'non-finite future skew',
      researchPolicy: { maxFutureSkewMs: Number.NaN },
      code: 'INVALID_RESEARCH_MANIFEST_AGE',
    },
    {
      name: 'empty critical fields',
      researchPolicy: { criticalFields: [] },
      code: 'INVALID_CRITICAL_FIELDS',
    },
    {
      name: 'critical coverage above one',
      researchPolicy: { minimumCriticalFieldCoverage: 1.01 },
      code: 'INVALID_CRITICAL_FIELD_COVERAGE',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateResearch({
      universe: RESEARCH_UNIVERSE,
      symbol: 'AAA',
      qualityManifest: manifest(),
      policy: policy({ research: scenario.researchPolicy }),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.name)
    assert.ok(result.blockers.some(blocker => blocker.code === scenario.code), scenario.name)
    assert.equal(result.compositeScore, null, scenario.name)
  }
})

test('research quality gates have deterministic age and critical-data boundaries', () => {
  const base = { universe: RESEARCH_UNIVERSE, symbol: 'AAA', policy: policy() }

  const atMaxAge = evaluateResearch({
    ...base,
    qualityManifest: manifest(),
    now: NOW,
  })
  assert.equal(atMaxAge.dataStatus, 'VALID')

  const cases = [
    {
      name: 'missing manifest',
      qualityManifest: null,
      now: NOW,
      code: 'MISSING_QUALITY_MANIFEST',
    },
    {
      name: 'one millisecond stale',
      qualityManifest: manifest(),
      now: '2026-08-09T08:00:00.001Z',
      code: 'STALE_QUALITY_MANIFEST',
    },
    {
      name: 'critical coverage below policy',
      qualityManifest: manifest({ coverage: { ROE: { available: 2, total: 3, rate: 2 / 3 } } }),
      now: NOW,
      code: 'INSUFFICIENT_CRITICAL_FIELD_COVERAGE',
    },
    {
      name: 'symbol failed collection',
      qualityManifest: manifest({ failedSymbols: ['AAA'] }),
      now: NOW,
      code: 'QUALITY_FAILURE_FOR_SYMBOL',
    },
    {
      name: 'manifest counts conflict',
      qualityManifest: manifest({ succeeded: 2 }),
      now: NOW,
      code: 'MANIFEST_COUNTS_CONFLICT',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateResearch({ ...base, ...scenario })
    assert.equal(result.dataStatus, 'BLOCKED', scenario.name)
    assert.ok(result.blockers.some(blocker => blocker.code === scenario.code), scenario.name)
  }
})
