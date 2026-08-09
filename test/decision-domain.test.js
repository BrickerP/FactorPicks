import test from 'node:test'
import assert from 'node:assert/strict'

import { FACTOR_CATALOG } from '../src/domain/factorCatalog.js'
import { evaluateDecision } from '../src/domain/evaluateDecision.js'
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
    decision: {
      eventRiskMode: 'downgrade',
      pilotPositionLimit: 0.02,
      ...overrides.decision,
    },
  }
}

function research(overrides = {}) {
  return {
    symbol: 'AAA',
    asOf: NOW,
    dataStatus: 'VALID',
    blockers: [],
    coverage: { configuredWeight: 1, observedWeight: 1, ratio: 1 },
    ...overrides,
  }
}

function underwriting(overrides = {}) {
  return {
    longTermGate: 'PASS',
    thesisStatus: 'INTACT',
    valuationStatus: 'PASS',
    timingStatus: 'PASS',
    systemRiskLimit: 0.08,
    ...overrides,
  }
}

function portfolio(overrides = {}) {
  return {
    currentPosition: 0,
    userHardLimit: 0.1,
    sectorRemainingCapacity: 0.07,
    portfolioRemainingCapacity: 0.2,
    ...overrides,
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
    'timing',
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

test('research coverage below policy blocks downstream position advice', () => {
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

  const decision = evaluateDecision({
    research: assessedResearch,
    underwriting: underwriting(),
    portfolio: portfolio(),
    policy: policy(),
    now: NOW,
  })

  assert.equal(decision.dataStatus, 'BLOCKED')
  assert.equal(decision.buyAction, 'NO_ACTION')
  assert.equal(decision.recommendedPosition, null)
  assert.deepEqual(decision.reasonCodes, ['INSUFFICIENT_RESEARCH_COVERAGE'])
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

test('valid quality without a valuation margin stays on WATCH', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting({ valuationStatus: 'FAIL' }),
    portfolio: portfolio(),
    policy: policy(),
    now: NOW,
  })

  assert.deepEqual(result, {
    symbol: 'AAA',
    decidedAt: NOW,
    dataStatus: 'VALID',
    buyAction: 'WATCH',
    holdingRisk: 'NONE',
    recommendedPosition: null,
    capacity: {
      userHardLimit: 0.1,
      systemRiskLimit: 0.08,
      sectorRemainingCapacity: 0.07,
      portfolioRemainingCapacity: 0.2,
      effectiveLimit: 0.07,
    },
    reasonCodes: ['VALUATION_FAILED'],
  })
})

test('an upcoming high-risk event downgrades OPEN to PILOT or WATCH by policy', () => {
  const input = {
    research: research(),
    underwriting: underwriting({ timingStatus: 'EVENT_RISK' }),
    portfolio: portfolio(),
    now: NOW,
  }

  const downgraded = evaluateDecision({ ...input, policy: policy() })
  assert.equal(downgraded.buyAction, 'PILOT')
  assert.equal(downgraded.recommendedPosition, 0.02)
  assert.deepEqual(downgraded.reasonCodes, ['EVENT_RISK'])

  const blocked = evaluateDecision({
    ...input,
    policy: policy({ decision: { eventRiskMode: 'block' } }),
  })
  assert.equal(blocked.buyAction, 'WATCH')
  assert.equal(blocked.recommendedPosition, null)
  assert.deepEqual(blocked.reasonCodes, ['EVENT_RISK'])
})

test('invalid decision policy blocks position advice', () => {
  const cases = [
    {
      name: 'unknown event-risk mode',
      decisionPolicy: { eventRiskMode: 'surprise' },
      reason: 'INVALID_EVENT_RISK_MODE',
    },
    {
      name: 'missing pilot limit',
      decisionPolicy: { pilotPositionLimit: undefined },
      reason: 'INVALID_PILOT_POSITION_LIMIT',
    },
    {
      name: 'non-finite pilot limit',
      decisionPolicy: { pilotPositionLimit: Number.NaN },
      reason: 'INVALID_PILOT_POSITION_LIMIT',
    },
    {
      name: 'non-positive pilot limit',
      decisionPolicy: { pilotPositionLimit: 0 },
      reason: 'INVALID_PILOT_POSITION_LIMIT',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting(),
      portfolio: portfolio(),
      policy: policy({ decision: scenario.decisionPolicy }),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.name)
    assert.equal(result.buyAction, 'NO_ACTION', scenario.name)
    assert.equal(result.recommendedPosition, null, scenario.name)
    assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.name)
  }
})

test('EVENT_RISK caps an oversized pilot limit at effective remaining capacity', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting({ timingStatus: 'EVENT_RISK' }),
    portfolio: portfolio({
      sectorRemainingCapacity: 0.04,
      portfolioRemainingCapacity: 0.015,
    }),
    policy: policy({ decision: { pilotPositionLimit: 0.08 } }),
    now: NOW,
  })

  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.buyAction, 'PILOT')
  assert.equal(result.capacity.effectiveLimit, 0.015)
  assert.equal(result.recommendedPosition, 0.015)
})

test('a non-holding that passes every gate is OPEN within effective capacity', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting(),
    portfolio: portfolio(),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.buyAction, 'OPEN')
  assert.equal(result.holdingRisk, 'NONE')
  assert.equal(result.recommendedPosition, 0.07)
  assert.deepEqual(result.reasonCodes, ['ALL_GATES_PASSED'])
})

test('an intact holding below its effective limit can ADD', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting(),
    portfolio: portfolio({ currentPosition: 0.03 }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.buyAction, 'ADD')
  assert.equal(result.holdingRisk, 'NONE')
  assert.equal(result.recommendedPosition, 0.08)
  assert.deepEqual(result.reasonCodes, ['ALL_GATES_PASSED'])
})

test('remaining capacity extends the current holding into a target limit', () => {
  const cases = [
    { timingStatus: 'PASS', buyAction: 'ADD', reason: 'ALL_GATES_PASSED' },
    { timingStatus: 'EVENT_RISK', buyAction: 'PILOT', reason: 'EVENT_RISK' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting({ timingStatus: scenario.timingStatus }),
      portfolio: portfolio({
        currentPosition: 0.03,
        sectorRemainingCapacity: 0.01,
      }),
      policy: policy({ decision: { pilotPositionLimit: 0.08 } }),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'VALID', scenario.timingStatus)
    assert.equal(result.capacity.effectiveLimit, 0.04, scenario.timingStatus)
    assert.equal(result.buyAction, scenario.buyAction, scenario.timingStatus)
    assert.equal(result.holdingRisk, 'NONE', scenario.timingStatus)
    assert.equal(result.recommendedPosition, 0.04, scenario.timingStatus)
    assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.timingStatus)
  }
})

test('a holding at effective capacity stays NO_ACTION before timing is applied', () => {
  for (const timingStatus of ['PASS', 'EVENT_RISK']) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting({ timingStatus }),
      portfolio: portfolio({ currentPosition: 0.08 }),
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'VALID', timingStatus)
    assert.equal(result.buyAction, 'NO_ACTION', timingStatus)
    assert.equal(result.recommendedPosition, null, timingStatus)
    assert.deepEqual(result.reasonCodes, ['POSITION_AT_EFFECTIVE_LIMIT'], timingStatus)
  }
})

test('timing FAIL watches a non-holding and cannot trade an existing holding', () => {
  const cases = [
    { currentPosition: 0, buyAction: 'WATCH' },
    { currentPosition: 0.03, buyAction: 'NO_ACTION' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting({ timingStatus: 'FAIL' }),
      portfolio: portfolio({ currentPosition: scenario.currentPosition }),
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'VALID')
    assert.equal(result.buyAction, scenario.buyAction)
    assert.equal(result.recommendedPosition, null)
    assert.deepEqual(result.reasonCodes, ['TIMING_FAILED'])
  }
})

test('unknown underwriting enums block rather than defaulting to a passing gate', () => {
  const cases = [
    { field: 'longTermGate', reason: 'INVALID_LONG_TERM_GATE' },
    { field: 'thesisStatus', reason: 'INVALID_THESIS_STATUS' },
    { field: 'valuationStatus', reason: 'INVALID_VALUATION_STATUS' },
    { field: 'timingStatus', reason: 'INVALID_TIMING_STATUS' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting({ [scenario.field]: 'SURPRISE' }),
      portfolio: portfolio(),
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.field)
    assert.equal(result.buyAction, 'NO_ACTION', scenario.field)
    assert.equal(result.recommendedPosition, null, scenario.field)
    assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.field)
  }
})

test('every actionable recommendation is positive and within effective capacity', () => {
  const inputs = [
    { timingStatus: 'PASS', currentPosition: 0 },
    { timingStatus: 'PASS', currentPosition: 0.03 },
    { timingStatus: 'EVENT_RISK', currentPosition: 0 },
  ]

  for (const input of inputs) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting({ timingStatus: input.timingStatus }),
      portfolio: portfolio({ currentPosition: input.currentPosition }),
      policy: policy(),
      now: NOW,
    })

    assert.ok(['OPEN', 'PILOT', 'ADD'].includes(result.buyAction))
    assert.ok(result.recommendedPosition > 0)
    assert.ok(result.recommendedPosition <= result.capacity.effectiveLimit)
  }
})

test('blocked research stops the decision before every investment gate', () => {
  const result = evaluateDecision({
    research: research({
      dataStatus: 'BLOCKED',
      blockers: [{ code: 'MISSING_CRITICAL_FIELD', field: 'ROE' }],
    }),
    underwriting: underwriting({ thesisStatus: 'INVALIDATED', timingStatus: 'PASS' }),
    portfolio: portfolio({ currentPosition: 0.03 }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.dataStatus, 'BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.equal(result.holdingRisk, 'NONE')
  assert.equal(result.recommendedPosition, null)
  assert.deepEqual(result.reasonCodes, ['MISSING_CRITICAL_FIELD'])
})

test('simultaneous failures use data, long-term, holding, valuation, capacity, timing priority', () => {
  const cases = [
    {
      name: 'data before every underwriting and capacity gate',
      research: research({
        dataStatus: 'BLOCKED',
        blockers: [{ code: 'DATA_UNAVAILABLE' }],
      }),
      underwriting: underwriting({
        longTermGate: 'FAIL',
        thesisStatus: 'INVALIDATED',
        valuationStatus: 'FAIL',
        timingStatus: 'FAIL',
        systemRiskLimit: 0,
      }),
      portfolio: portfolio({ currentPosition: 0.03, userHardLimit: 0 }),
      expected: ['BLOCKED', 'NO_ACTION', 'NONE', 'DATA_UNAVAILABLE'],
    },
    {
      name: 'long-term before holding, valuation, capacity, and timing',
      research: research(),
      underwriting: underwriting({
        longTermGate: 'FAIL',
        thesisStatus: 'INVALIDATED',
        valuationStatus: 'FAIL',
        timingStatus: 'FAIL',
        systemRiskLimit: 0,
      }),
      portfolio: portfolio({ currentPosition: 0.03 }),
      expected: ['VALID', 'NO_ACTION', 'REVIEW', 'LONG_TERM_GATE_FAILED'],
    },
    {
      name: 'holding risk before valuation, capacity, and timing',
      research: research(),
      underwriting: underwriting({
        thesisStatus: 'INVALIDATED',
        valuationStatus: 'FAIL',
        timingStatus: 'FAIL',
        systemRiskLimit: 0,
      }),
      portfolio: portfolio({ currentPosition: 0.03 }),
      expected: ['VALID', 'NO_ACTION', 'EXIT_REVIEW', 'THESIS_INVALIDATED'],
    },
    {
      name: 'valuation before capacity and timing',
      research: research(),
      underwriting: underwriting({
        valuationStatus: 'FAIL',
        timingStatus: 'FAIL',
        systemRiskLimit: 0,
      }),
      portfolio: portfolio(),
      expected: ['VALID', 'WATCH', 'NONE', 'VALUATION_FAILED'],
    },
    {
      name: 'capacity before timing',
      research: research(),
      underwriting: underwriting({ timingStatus: 'FAIL', systemRiskLimit: 0 }),
      portfolio: portfolio(),
      expected: ['BLOCKED', 'NO_ACTION', 'NONE', 'SYSTEM_RISK_LIMIT_REQUIRED'],
    },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: scenario.research,
      underwriting: scenario.underwriting,
      portfolio: scenario.portfolio,
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, scenario.expected[0], scenario.name)
    assert.equal(result.buyAction, scenario.expected[1], scenario.name)
    assert.equal(result.holdingRisk, scenario.expected[2], scenario.name)
    assert.deepEqual(result.reasonCodes, [scenario.expected[3]], scenario.name)
  }
})

test('an invalidated thesis on an existing holding requires an exit review', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting({ thesisStatus: 'INVALIDATED' }),
    portfolio: portfolio({ currentPosition: 0.03 }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.buyAction, 'NO_ACTION')
  assert.equal(result.holdingRisk, 'EXIT_REVIEW')
  assert.equal(result.recommendedPosition, null)
  assert.deepEqual(result.reasonCodes, ['THESIS_INVALIDATED'])
})

test('timing can never promote a decision past a failed long-term gate', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting({ longTermGate: 'FAIL', timingStatus: 'EVENT_RISK' }),
    portfolio: portfolio(),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.buyAction, 'WATCH')
  assert.equal(result.holdingRisk, 'NONE')
  assert.equal(result.recommendedPosition, null)
  assert.deepEqual(result.reasonCodes, ['LONG_TERM_GATE_FAILED'])
})

test('a holding above its hard limit cannot add and requires reduction review', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting(),
    portfolio: portfolio({ currentPosition: 0.11 }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.buyAction, 'NO_ACTION')
  assert.equal(result.holdingRisk, 'REDUCE_REVIEW')
  assert.equal(result.recommendedPosition, null)
  assert.deepEqual(result.reasonCodes, ['POSITION_ABOVE_EFFECTIVE_LIMIT'])
})

test('every invalid capacity input blocks position advice', () => {
  const cases = [
    { field: 'userHardLimit', owner: 'portfolio', reason: 'USER_HARD_LIMIT_REQUIRED' },
    { field: 'systemRiskLimit', owner: 'underwriting', reason: 'SYSTEM_RISK_LIMIT_REQUIRED' },
    {
      field: 'sectorRemainingCapacity',
      owner: 'portfolio',
      reason: 'SECTOR_REMAINING_CAPACITY_REQUIRED',
    },
    {
      field: 'portfolioRemainingCapacity',
      owner: 'portfolio',
      reason: 'PORTFOLIO_REMAINING_CAPACITY_REQUIRED',
    },
  ]

  for (const scenario of cases) {
    for (const invalidValue of [undefined, Number.NaN, -0.01]) {
      const underwritingInput = scenario.owner === 'underwriting'
        ? underwriting({ [scenario.field]: invalidValue })
        : underwriting()
      const portfolioInput = scenario.owner === 'portfolio'
        ? portfolio({ [scenario.field]: invalidValue })
        : portfolio()

      const result = evaluateDecision({
        research: research(),
        underwriting: underwritingInput,
        portfolio: portfolioInput,
        policy: policy(),
        now: NOW,
      })

      assert.equal(result.dataStatus, 'BLOCKED', scenario.field)
      assert.equal(result.buyAction, 'NO_ACTION', scenario.field)
      assert.equal(result.recommendedPosition, null, scenario.field)
      assert.equal(result.capacity.effectiveLimit, null, scenario.field)
      assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.field)
    }
  }
})

test('zero user and system risk limits block position advice', () => {
  const cases = [
    { field: 'userHardLimit', owner: 'portfolio', reason: 'USER_HARD_LIMIT_REQUIRED' },
    { field: 'systemRiskLimit', owner: 'underwriting', reason: 'SYSTEM_RISK_LIMIT_REQUIRED' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision({
      research: research(),
      underwriting: scenario.owner === 'underwriting'
        ? underwriting({ [scenario.field]: 0 })
        : underwriting(),
      portfolio: scenario.owner === 'portfolio'
        ? portfolio({ [scenario.field]: 0 })
        : portfolio(),
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'BLOCKED', scenario.field)
    assert.equal(result.buyAction, 'NO_ACTION', scenario.field)
    assert.equal(result.recommendedPosition, null, scenario.field)
    assert.equal(result.capacity.effectiveLimit, null, scenario.field)
    assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.field)
  }
})

test('zero remaining capacity is valid but cannot recommend a position', () => {
  for (const field of ['sectorRemainingCapacity', 'portfolioRemainingCapacity']) {
    const result = evaluateDecision({
      research: research(),
      underwriting: underwriting(),
      portfolio: portfolio({ [field]: 0 }),
      policy: policy(),
      now: NOW,
    })

    assert.equal(result.dataStatus, 'VALID', field)
    assert.equal(result.buyAction, 'NO_ACTION', field)
    assert.equal(result.recommendedPosition, null, field)
    assert.equal(result.capacity.effectiveLimit, 0, field)
    assert.deepEqual(result.reasonCodes, ['NO_EFFECTIVE_CAPACITY'], field)
  }
})

test('a missing user hard limit blocks position advice', () => {
  const result = evaluateDecision({
    research: research(),
    underwriting: underwriting(),
    portfolio: portfolio({ userHardLimit: undefined }),
    policy: policy(),
    now: NOW,
  })

  assert.equal(result.dataStatus, 'BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.equal(result.holdingRisk, 'NONE')
  assert.equal(result.recommendedPosition, null)
  assert.equal(result.capacity.effectiveLimit, null)
  assert.deepEqual(result.reasonCodes, ['USER_HARD_LIMIT_REQUIRED'])
})
