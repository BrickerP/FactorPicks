import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { derivePortfolioCapacitySnapshot } from '../src/domain/portfolioCapacity.js'
import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import { decisionInput } from './fixtures/decision-v2-fixture.js'
import {
  CAPACITY_AS_OF,
  capacityInput,
} from './fixtures/portfolio-capacity-fixture.js'
import { digest } from './fixtures/decision-v2-fixture.js'

test('derives the worked capacity literal from one complete USD long-equity snapshot', () => {
  const result = derivePortfolioCapacitySnapshot(capacityInput())

  assert.deepEqual(result.portfolioCapacity.currentPosition.weight, 0.02)
  assert.deepEqual(result.portfolioCapacity.hardLimits, {
    userHardLimit: 0.1,
    systemRiskLimit: 0.08,
    sectorHardLimit: 0.2,
    industryHardLimit: 0.12,
    portfolioHardLimit: 0.9,
    liquidityHardLimit: 0.06,
  })
  assert.deepEqual(result.portfolioCapacity.remainingCapacity, {
    sector: 0.08000000000000002,
    industry: 0.09999999999999999,
    portfolio: 0.48000000000000004,
    liquidity: 0.039999999999999994,
  })
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.06)
  assert.equal(result.portfolioCapacity.capacityToLimit, 0.039999999999999994)
  assert.equal(result.resolvedSnapshots.length, 2)
  assert.ok(result.resolvedSnapshots.every(snapshot => 'payload' in snapshot))
})

test('aggregates duplicate symbols and classifies a new target explicitly', () => {
  const existing = derivePortfolioCapacitySnapshot(capacityInput({
    portfolio: {
      positions: [
        {
          symbol: 'AAA', quantity: 10, markPrice: 100,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Software',
        },
        {
          symbol: 'AAA', quantity: 5, markPrice: 200,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Software',
        },
      ],
    },
  }))
  assert.equal(existing.portfolioCapacity.currentPosition.weight, 0.02)

  const newTarget = derivePortfolioCapacitySnapshot(capacityInput({
    symbol: 'NEW',
    portfolio: {
      positions: [],
      targetClassification: { sector: 'Energy', industry: 'Oil & Gas' },
    },
  }))
  assert.equal(newTarget.portfolioCapacity.currentPosition.weight, 0)
  assert.equal(newTarget.portfolioCapacity.remainingCapacity.sector, 0.2)
  assert.equal(newTarget.portfolioCapacity.remainingCapacity.industry, 0.12)
})

test('cash buffer tightens only portfolio capacity and buying power is ignored', () => {
  const withSentinel = capacityInput({
    portfolio: { positions: [], buyingPower: 99_999_999 },
    symbol: 'NEW',
    policy: { portfolioHardLimit: 0.95, minimumCashBufferWeight: 0.2 },
  })
  withSentinel.portfolio.targetClassification = { sector: 'Energy', industry: 'Oil & Gas' }
  const result = derivePortfolioCapacitySnapshot(withSentinel)

  assert.equal(result.portfolioCapacity.hardLimits.portfolioHardLimit, 0.8)
  assert.equal(result.portfolioCapacity.hardLimits.liquidityHardLimit, 0.06)
  assert.equal(result.portfolioCapacity.remainingCapacity.liquidity, 0.06)
  assert.doesNotMatch(JSON.stringify(result), /buyingPower|99999999/)
})

test('every hard limit can independently become the effective minimum', () => {
  const base = capacityInput({
    portfolio: { positions: [] , targetClassification: { sector: 'Energy', industry: 'Oil & Gas' } },
    symbol: 'NEW',
    policy: {
      userHardLimit: 1,
      systemRiskLimit: 1,
      sectorHardLimit: 1,
      industryHardLimit: 1,
      portfolioHardLimit: 1,
      minimumCashBufferWeight: 0,
    },
    liquidity: { maxPositionWeight: 1 },
  })
  const cases = [
    ['user hard limit', { policy: { userHardLimit: 0.11 } }, 0.11],
    ['system hard limit', { policy: { systemRiskLimit: 0.12 } }, 0.12],
    ['sector hard limit', { policy: { sectorHardLimit: 0.13 } }, 0.13],
    ['industry hard limit', { policy: { industryHardLimit: 0.14 } }, 0.14],
    ['portfolio hard limit', { policy: { portfolioHardLimit: 0.15 } }, 0.15],
    ['liquidity hard limit', { liquidity: { maxPositionWeight: 0.16 } }, 0.16],
  ]

  for (const [name, override, expected] of cases) {
    const result = derivePortfolioCapacitySnapshot({
      ...base,
      policy: { ...base.policy, ...override.policy },
      liquidity: { ...base.liquidity, ...override.liquidity },
    })
    assert.equal(result.portfolioCapacity.effectiveLimit, expected, name)
  }
})

test('an over-limit holding is valid with zero capacity', () => {
  const result = derivePortfolioCapacitySnapshot(capacityInput({
    policy: { userHardLimit: 0.01 },
  }))
  assert.equal(result.portfolioCapacity.currentPosition.weight, 0.02)
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.01)
  assert.equal(result.portfolioCapacity.capacityToLimit, 0)
})

test('fails closed for incomplete incoherent or unsupported account facts without echoing raw values', () => {
  const cases = [
    ['NLV zero', { portfolio: { netLiquidationValue: 0 } }],
    ['NLV null', { portfolio: { netLiquidationValue: null } }],
    ['incomplete', { portfolio: { completeness: 'PARTIAL' } }],
    ['multiple accounts', { portfolio: { accountCount: 2 } }],
    ['margin', { portfolio: { accountType: 'MARGIN' } }],
    ['options', { portfolio: { hasOptions: true } }],
    ['crypto', { portfolio: { hasCrypto: true } }],
    ['currency', { portfolio: { currency: 'EUR' } }],
    ['quote mismatch', {
      portfolio: {
        positions: [{
          symbol: 'AAA', quantity: 1, markPrice: 777_777,
          asOf: '2026-08-09T07:54:00.000Z', currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Software',
        }],
      },
    }],
    ['short', {
      portfolio: {
        positions: [{
          symbol: 'AAA', quantity: 1, markPrice: 777_777,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'SHORT', sector: 'Technology', industry: 'Software',
        }],
      },
    }],
    ['missing quote', {
      portfolio: {
        positions: [{
          symbol: 'AAA', quantity: 1, markPrice: null,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Software',
        }],
      },
    }],
    ['missing classification', {
      portfolio: {
        positions: [{
          symbol: 'AAA', quantity: 1, markPrice: 777_777,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: null, industry: 'Software',
        }],
      },
    }],
    ['new target classification', { symbol: 'NEW' }],
  ]

  for (const [name, overrides] of cases) {
    const input = capacityInput(overrides)
    assert.throws(
      () => derivePortfolioCapacitySnapshot(input),
      error => {
        assert.equal(error.code, 'INVALID_PORTFOLIO_CAPACITY_INPUT', name)
        assert.doesNotMatch(error.message, /777777|PARTIAL|MARGIN|EUR|SHORT/i, name)
        return true
      },
    )
  }
})

test('does not mutate input or expose raw account facts in derived output', () => {
  const input = capacityInput({
    portfolio: {
      accountId: 'sensitive-account-sentinel',
      buyingPower: 12_345_678,
      costBasis: 8_765_432,
    },
  })
  const before = structuredClone(input)
  const result = derivePortfolioCapacitySnapshot(input)
  const serialized = JSON.stringify(result)

  assert.deepEqual(input, before)
  assert.doesNotMatch(serialized, /netLiquidationValue|quantity|markPrice|accountId|buyingPower|costBasis/i)
  assert.doesNotMatch(serialized, /sensitive-account-sentinel|12345678|8765432/)
})

test('builder output merges directly into the decision bundle and tampering blocks', () => {
  function bundleFromDerived() {
    const input = decisionInput()
    const derived = derivePortfolioCapacitySnapshot(capacityInput())
    const oldIds = new Set([
      input.portfolioCapacity.portfolioSnapshotRef.id,
      input.portfolioCapacity.capacityPolicyRef.id,
    ])
    input.portfolioCapacity = structuredClone(derived.portfolioCapacity)
    input.resolvedSnapshots = input.resolvedSnapshots
      .filter(snapshot => !oldIds.has(snapshot.id))
      .concat(structuredClone(derived.resolvedSnapshots))
    return input
  }

  const accepted = evaluateDecision(bundleFromDerived())
  assert.equal(accepted.dataStatus, 'VALID')
  assert.equal(accepted.buyAction, 'ADD')

  const derivedTamper = bundleFromDerived()
  derivedTamper.portfolioCapacity.effectiveLimit = 0.5
  const derivedResult = evaluateDecision(derivedTamper)
  assert.equal(derivedResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(derivedResult.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))

  const digestTamper = bundleFromDerived()
  digestTamper.portfolioCapacity.digests.capacity = `sha256:${'0'.repeat(64)}`
  const digestResult = evaluateDecision(digestTamper)
  assert.equal(digestResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(digestResult.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

test('decision capacity is bound to the research symbol', () => {
  const input = decisionInput()
  const derived = derivePortfolioCapacitySnapshot(capacityInput({ symbol: 'BBB' }))
  const oldIds = new Set([
    input.portfolioCapacity.portfolioSnapshotRef.id,
    input.portfolioCapacity.capacityPolicyRef.id,
  ])
  input.portfolioCapacity = derived.portfolioCapacity
  input.resolvedSnapshots = input.resolvedSnapshots
    .filter(snapshot => !oldIds.has(snapshot.id))
    .concat(derived.resolvedSnapshots)

  const result = evaluateDecision(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

test('resolved portfolio and policy facts are authoritative over synchronized derived tampering', () => {
  const input = decisionInput()
  const derived = derivePortfolioCapacitySnapshot(capacityInput())
  const oldIds = new Set([
    input.portfolioCapacity.portfolioSnapshotRef.id,
    input.portfolioCapacity.capacityPolicyRef.id,
  ])
  input.portfolioCapacity = structuredClone(derived.portfolioCapacity)
  input.resolvedSnapshots = input.resolvedSnapshots
    .filter(snapshot => !oldIds.has(snapshot.id))
    .concat(structuredClone(derived.resolvedSnapshots))

  input.portfolioCapacity.hardLimits.userHardLimit = 0.01
  input.portfolioCapacity.effectiveLimit = 0.01
  input.portfolioCapacity.capacityToLimit = 0
  const projection = {
    asOf: input.portfolioCapacity.asOf,
    symbol: input.portfolioCapacity.symbol,
    currentPosition: input.portfolioCapacity.currentPosition,
    hardLimits: input.portfolioCapacity.hardLimits,
    remainingCapacity: input.portfolioCapacity.remainingCapacity,
    effectiveLimit: input.portfolioCapacity.effectiveLimit,
    capacityToLimit: input.portfolioCapacity.capacityToLimit,
    portfolioSnapshotRef: input.portfolioCapacity.portfolioSnapshotRef,
    capacityPolicyRef: input.portfolioCapacity.capacityPolicyRef,
  }
  input.portfolioCapacity.digests.capacity = digest(projection)

  const result = evaluateDecision(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

test('content-addressed payloads bind portfolio liquidity and policy provenance', () => {
  const input = capacityInput()
  const result = derivePortfolioCapacitySnapshot(input)
  const portfolioPayload = result.resolvedSnapshots.find(
    snapshot => snapshot.id === result.portfolioCapacity.portfolioSnapshotRef.id,
  ).payload
  const policyPayload = result.resolvedSnapshots.find(
    snapshot => snapshot.id === result.portfolioCapacity.capacityPolicyRef.id,
  ).payload

  assert.equal(portfolioPayload.sourceRef, input.portfolio.sourceRef)
  assert.equal(portfolioPayload.positionRef, result.portfolioCapacity.currentPosition.positionRef)
  assert.deepEqual(portfolioPayload.exposures, {
    current: 0.02,
    sector: 0.12,
    industry: 0.02,
    portfolio: 0.42,
  })
  assert.equal(policyPayload.sourceRef, input.policy.sourceRef)
  assert.equal(policyPayload.effectiveFrom, input.policy.effectiveFrom)
  assert.equal(policyPayload.effectiveUntil, input.policy.effectiveUntil)
  assert.deepEqual(policyPayload.liquidity, input.liquidity)
  assert.deepEqual(policyPayload.freshnessPolicy, input.freshnessPolicy)
  assert.equal(policyPayload.evaluatedAt, input.evaluatedAt)
})

test('capacity derivation enforces canonical tickers and coherent policy and freshness windows', () => {
  const cases = [
    ['lowercase target', { symbol: 'aaa' }],
    ['lowercase position', {
      portfolio: { positions: [{
        symbol: 'aaa', quantity: 1, markPrice: 1, asOf: CAPACITY_AS_OF,
        currency: 'USD', assetType: 'EQUITY', side: 'LONG',
        sector: 'Technology', industry: 'Software',
      }] },
    }],
    ['future portfolio', { evaluatedAt: '2026-08-09T07:50:00.000Z' }],
    ['stale portfolio', { evaluatedAt: '2026-08-09T09:00:00.000Z' }],
    ['liquidity mismatch', { liquidity: { asOf: '2026-08-09T07:54:00.000Z' } }],
    ['policy not effective', { policy: { effectiveFrom: '2026-08-10T00:00:00.000Z' } }],
    ['missing evaluatedAt', { evaluatedAt: undefined }],
    ['missing freshness', { freshnessPolicy: undefined }],
  ]

  for (const [name, overrides] of cases) {
    assert.throws(
      () => derivePortfolioCapacitySnapshot(capacityInput(overrides)),
      error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
      name,
    )
  }
})

test('duplicate symbols with conflicting classification and non-finite inputs fail closed', () => {
  const conflicting = capacityInput({
    portfolio: {
      positions: [
        {
          symbol: 'AAA', quantity: 1, markPrice: 1, asOf: CAPACITY_AS_OF,
          currency: 'USD', assetType: 'EQUITY', side: 'LONG',
          sector: 'Technology', industry: 'Software',
        },
        {
          symbol: 'AAA', quantity: 1, markPrice: 1, asOf: CAPACITY_AS_OF,
          currency: 'USD', assetType: 'EQUITY', side: 'LONG',
          sector: 'Financials', industry: 'Banks',
        },
      ],
    },
  })
  assert.throws(
    () => derivePortfolioCapacitySnapshot(conflicting),
    error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
  )

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const field of ['netLiquidationValue', 'quantity', 'markPrice']) {
      const input = capacityInput()
      if (field === 'netLiquidationValue') input.portfolio[field] = value
      else input.portfolio.positions[0][field] = value
      assert.throws(
        () => derivePortfolioCapacitySnapshot(input),
        error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
        `${field}:${value}`,
      )
    }
    for (const field of [
      'userHardLimit',
      'systemRiskLimit',
      'sectorHardLimit',
      'industryHardLimit',
      'portfolioHardLimit',
      'minimumCashBufferWeight',
    ]) {
      const input = capacityInput({ policy: { [field]: value } })
      assert.throws(
        () => derivePortfolioCapacitySnapshot(input),
        error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
        `${field}:${value}`,
      )
    }
    for (const [section, field] of [
      ['liquidity', 'maxPositionWeight'],
      ['freshnessPolicy', 'maxPortfolioAgeMs'],
      ['freshnessPolicy', 'maxLiquidityAgeMs'],
      ['freshnessPolicy', 'maxFutureSkewMs'],
    ]) {
      const input = capacityInput({ [section]: { [field]: value } })
      assert.throws(
        () => derivePortfolioCapacitySnapshot(input),
        error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
        `${section}.${field}:${value}`,
      )
    }
  }
})

test('rejects zero-quantity rows and zero-priced positive holdings', () => {
  for (const position of [
    {
      symbol: 'AAA', quantity: 0, markPrice: 100, asOf: CAPACITY_AS_OF,
      currency: 'USD', assetType: 'EQUITY', side: 'LONG',
      sector: 'Technology', industry: 'Software',
    },
    {
      symbol: 'AAA', quantity: 1, markPrice: 0, asOf: CAPACITY_AS_OF,
      currency: 'USD', assetType: 'EQUITY', side: 'LONG',
      sector: 'Technology', industry: 'Software',
    },
  ]) {
    assert.throws(
      () => derivePortfolioCapacitySnapshot(capacityInput({
        portfolio: { positions: [position] },
      })),
      error => error.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT',
    )
  }
})

function overLimitInput(overrides = {}) {
  return capacityInput({
    portfolio: {
      positions: [{
        symbol: 'AAA', quantity: 20_000, markPrice: 1, asOf: CAPACITY_AS_OF,
        currency: 'USD', assetType: 'EQUITY', side: 'LONG',
        sector: 'Technology', industry: 'Software',
      }],
    },
    policy: {
      userHardLimit: 1,
      systemRiskLimit: 1,
      sectorHardLimit: 1,
      industryHardLimit: 1,
      portfolioHardLimit: 1,
      minimumCashBufferWeight: 0,
      ...overrides.policy,
    },
    liquidity: { maxPositionWeight: overrides.liquidityLimit ?? 1 },
  })
}

test('sector hard limit independently binds an already over-limit holding', () => {
  const result = derivePortfolioCapacitySnapshot(overLimitInput({
    policy: { sectorHardLimit: 0.1 },
  }))
  assert.equal(result.portfolioCapacity.currentPosition.weight, 0.2)
  assert.equal(result.portfolioCapacity.remainingCapacity.sector, 0)
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.1)
})

test('industry hard limit independently binds an already over-limit holding', () => {
  const result = derivePortfolioCapacitySnapshot(overLimitInput({
    policy: { industryHardLimit: 0.11 },
  }))
  assert.equal(result.portfolioCapacity.currentPosition.weight, 0.2)
  assert.equal(result.portfolioCapacity.remainingCapacity.industry, 0)
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.11)
})

test('portfolio hard limit independently binds an already over-limit holding', () => {
  const result = derivePortfolioCapacitySnapshot(overLimitInput({
    policy: { portfolioHardLimit: 0.12 },
  }))
  assert.equal(result.portfolioCapacity.currentPosition.weight, 0.2)
  assert.equal(result.portfolioCapacity.remainingCapacity.portfolio, 0)
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.12)
})

test('liquidity hard limit independently binds an already over-limit holding', () => {
  const result = derivePortfolioCapacitySnapshot(overLimitInput({
    liquidityLimit: 0.13,
  }))
  assert.equal(result.portfolioCapacity.currentPosition.weight, 0.2)
  assert.equal(result.portfolioCapacity.remainingCapacity.liquidity, 0)
  assert.equal(result.portfolioCapacity.effectiveLimit, 0.13)
})

test('evaluateDecision delegates capacity formulas to the capacity module', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/domain/evaluateDecision.js', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(source, /HARD_LIMIT_KEYS|REMAINING_CAPACITY_KEYS/)
  assert.doesNotMatch(source, /function capacityFor/)
})
