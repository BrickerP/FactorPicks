import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import {
  decisionInput,
  EVIDENCE_DIGEST,
  evidence,
  invalidationRule,
  opaqueRef,
  SNAPSHOT_AS_OF,
} from './fixtures/decision-v2-fixture.js'

function assertBlocked(result, blockerCode, message = blockerCode) {
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED', message)
  assert.equal(result.entryStatus, 'PROHIBITED', message)
  assert.equal(result.buyAction, 'NO_ACTION', message)
  assert.equal(result.positionSizing, null, message)
  assert.ok(result.blockerCodes.includes(blockerCode), message)
}

test('all gates passing opens a new position with v2 position sizing', () => {
  const result = evaluateDecision(decisionInput())

  assert.equal(result.schemaVersion, 2)
  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.entryStatus, 'PERMITTED')
  assert.equal(result.buyAction, 'OPEN')
  assert.equal(result.holdingRisk, 'NONE')
  assert.deepEqual(result.positionSizing, {
    targetPosition: 0.03,
    additionalCapacity: 0.03,
  })
  assert.equal(result.capacitySummary.effectiveLimit, 0.03)
  assert.equal('recommendedPosition' in result, false)
})

test('missing stale or unresolvable evidence blocks evaluation without sizing', () => {
  const cases = [
    {
      name: 'missing evidence item',
      input: decisionInput({
        evidence: {
          digest: EVIDENCE_DIGEST,
          items: [evidence('valuation'), evidence('timing')],
        },
      }),
      blockerCode: 'MISSING_EVIDENCE_REFERENCE',
    },
    {
      name: 'stale evidence',
      input: decisionInput({
        evidence: {
          digest: EVIDENCE_DIGEST,
          items: [
            evidence('thesis', { asOf: '2026-08-09T06:00:00.000Z' }),
            evidence('valuation'),
            evidence('timing'),
          ],
        },
      }),
      blockerCode: 'STALE_EVIDENCE',
    },
    {
      name: 'unresolvable evidence source',
      input: decisionInput({
        evidence: {
          digest: EVIDENCE_DIGEST,
          items: [
            evidence('thesis', { source: { kind: 'filing', reference: '' } }),
            evidence('valuation'),
            evidence('timing'),
          ],
        },
      }),
      blockerCode: 'INVALID_EVIDENCE_SOURCE_REFERENCE',
    },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision(scenario.input)

    assertBlocked(result, scenario.blockerCode, scenario.name)
  }
})

test('a failed long-term gate cannot be promoted by passing timing', () => {
  const cases = [
    { weight: 0, buyAction: 'WATCH', holdingRisk: 'NONE' },
    { weight: 0.02, buyAction: 'NO_ACTION', holdingRisk: 'REVIEW' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision(decisionInput({
      underwriting: { longTermGate: 'FAIL' },
      timingAssessment: { status: 'PASS' },
      portfolioCapacity: { currentPosition: { weight: scenario.weight } },
    }))

    assert.equal(result.dataStatus, 'VALID')
    assert.equal(result.entryStatus, 'PROHIBITED')
    assert.equal(result.buyAction, scenario.buyAction)
    assert.equal(result.holdingRisk, scenario.holdingRisk)
    assert.deepEqual(result.reasonCodes, ['LONG_TERM_GATE_FAILED'])
  }
})

test('a price outside the entry range watches only a non-holder', () => {
  const cases = [
    { weight: 0, buyAction: 'WATCH', holdingRisk: 'NONE' },
    { weight: 0.02, buyAction: 'NO_ACTION', holdingRisk: 'REVIEW' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision(decisionInput({
      evaluatedPrice: {
        value: 110,
        currency: 'USD',
        asOf: SNAPSHOT_AS_OF,
        source: opaqueRef('source', 'consolidated-quote'),
      },
      portfolioCapacity: { currentPosition: { weight: scenario.weight } },
    }))

    assert.equal(result.entryStatus, 'PROHIBITED')
    assert.equal(result.buyAction, scenario.buyAction)
    assert.equal(result.holdingRisk, scenario.holdingRisk)
    assert.deepEqual(result.reasonCodes, ['PRICE_OUTSIDE_ENTRY_RANGE'])
  }
})

test('event risk permits PILOT only for the first position', () => {
  const firstPosition = evaluateDecision(decisionInput({
    timingAssessment: { status: 'EVENT_RISK', reasonCodes: ['EARNINGS_SOON'] },
  }))
  assert.equal(firstPosition.entryStatus, 'PERMITTED')
  assert.equal(firstPosition.buyAction, 'PILOT')
  assert.equal(firstPosition.holdingRisk, 'NONE')
  assert.deepEqual(firstPosition.positionSizing, {
    targetPosition: 0.01,
    additionalCapacity: 0.01,
  })

  const existingHolding = evaluateDecision(decisionInput({
    timingAssessment: { status: 'EVENT_RISK', reasonCodes: ['EARNINGS_SOON'] },
    portfolioCapacity: { currentPosition: { weight: 0.02 } },
  }))
  assert.equal(existingHolding.entryStatus, 'PROHIBITED')
  assert.equal(existingHolding.buyAction, 'NO_ACTION')
  assert.equal(existingHolding.holdingRisk, 'REVIEW')
})

test('zero capacity is valid but prohibits a purchase', () => {
  const result = evaluateDecision(decisionInput({
    portfolioCapacity: { remainingCapacity: { liquidity: 0 } },
  }))

  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.entryStatus, 'PROHIBITED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.deepEqual(result.positionSizing, {
    targetPosition: 0,
    additionalCapacity: 0,
  })
  assert.deepEqual(result.reasonCodes, ['NO_EFFECTIVE_CAPACITY'])
})

test('triggered invalidation maps to review or exit review by severity', () => {
  const cases = [
    { severity: 'REVIEW', holdingRisk: 'REVIEW' },
    { severity: 'PROHIBIT_ENTRY', holdingRisk: 'REVIEW' },
    { severity: 'EXIT_REVIEW', holdingRisk: 'EXIT_REVIEW' },
  ]

  for (const scenario of cases) {
    const result = evaluateDecision(decisionInput({
      underwriting: {
        invalidationRules: [invalidationRule({
          state: 'TRIGGERED',
          severity: scenario.severity,
        })],
      },
      portfolioCapacity: { currentPosition: { weight: 0.02 } },
    }))

    assert.equal(result.entryStatus, 'PROHIBITED', scenario.severity)
    assert.equal(result.buyAction, 'NO_ACTION', scenario.severity)
    assert.equal(result.holdingRisk, scenario.holdingRisk, scenario.severity)
    assert.deepEqual(result.reasonCodes, ['UNDERWRITING_INVALIDATED'], scenario.severity)
  }
})

test('position sizing clips the policy target and derives only the addable amount', () => {
  const result = evaluateDecision(decisionInput({
    portfolioCapacity: {
      currentPosition: { weight: 0.02 },
      remainingCapacity: { liquidity: 0.02 },
    },
    decisionPolicy: { targetPosition: 0.09 },
  }))

  assert.equal(result.capacitySummary.effectiveLimit, 0.04)
  assert.equal(result.buyAction, 'ADD')
  assert.equal(result.entryStatus, 'PERMITTED')
  assert.deepEqual(result.positionSizing, {
    targetPosition: 0.04,
    additionalCapacity: 0.02,
  })
  assert.ok(result.positionSizing.targetPosition <= result.capacitySummary.effectiveLimit)
})

test('unknown capacity blocks without converting the missing weight to zero', () => {
  const result = evaluateDecision(decisionInput({
    portfolioCapacity: { currentPosition: { weight: undefined } },
  }))

  assertBlocked(result, 'INVALID_PORTFOLIO_CAPACITY')
  assert.equal(result.capacitySummary, null)
})

test('blocked research always retains a usable blocker code', () => {
  const result = evaluateDecision(decisionInput({
    research: {
      dataStatus: 'EVALUATION_BLOCKED',
      blockerCodes: ['', null, '  '],
    },
  }))

  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.deepEqual(result.blockerCodes, ['RESEARCH_BLOCKED'])
  assert.deepEqual(result.reasonCodes, ['RESEARCH_BLOCKED'])
})

test('DecisionRecordV2 allow-lists every nested output field', () => {
  const input = decisionInput()
  input.evaluatedPrice.accountId = 'secret-account'
  input.research.marketSnapshot.quantity = 42
  input.underwriting.snapshotRef.marketValue = 1_000
  input.underwriting.valuationRange.sentinel = 'do-not-copy'
  input.underwriting.valuationRange.netLiquidationValue = 500_000
  input.underwriting.entryRange.derivedFrom.sentinel = 'do-not-copy'
  input.underwriting.entryRange.derivedFrom.netLiquidationValue = 500_000
  input.underwriting.invalidationRules[0].predicate.sentinel = 'do-not-copy'
  input.timingAssessment.marketValue = 1_000
  input.portfolioCapacity.currentPosition.quantity = 42
  input.portfolioCapacity.currentPosition.accountId = 'secret-account'
  input.portfolioCapacity.portfolioSnapshotRef.netLiquidationValue = 500_000
  input.decisionPolicy.ref.sentinel = 'do-not-copy'

  const result = evaluateDecision(input)
  const serialized = JSON.stringify(result)

  for (const forbidden of [
    'quantity',
    'marketValue',
    'accountId',
    'netLiquidationValue',
    'sentinel',
    'do-not-copy',
    'secret-account',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'), forbidden)
  }
  assert.doesNotMatch(serialized, /resolvedSnapshots|payload/)
  assert.deepEqual(Object.keys(result.capacitySummary.currentPosition).sort(), [
    'positionRef',
    'weight',
  ])
  assert.deepEqual(Object.keys(result.timingAssessment).sort(), [
    'asOf',
    'evidenceIds',
    'reasonCodes',
    'status',
  ])
})

test('invalidation rules enforce complete METRIC and MANUAL branches', () => {
  const manualPredicate = {
    kind: 'MANUAL',
    metric: null,
    operator: null,
    threshold: null,
    lookback: null,
    consecutive: null,
    source: null,
  }
  const invalidRules = [
    invalidationRule({ predicate: { ...invalidationRule().predicate, metric: null } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, operator: 'BETWEEN' } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, threshold: Number.NaN } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, threshold: '  ' } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, lookback: null } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, consecutive: 0 } }),
    invalidationRule({ predicate: { ...invalidationRule().predicate, source: '' } }),
    invalidationRule({ manualStatus: 'PENDING' }),
    invalidationRule({
      predicate: manualPredicate,
      manualStatus: 'CONFIRMED',
      state: 'UNTRIGGERED',
    }),
    invalidationRule({
      predicate: { ...manualPredicate, metric: 'should-be-null' },
      manualStatus: 'CONFIRMED',
      state: 'TRIGGERED',
    }),
  ]

  for (const rule of invalidRules) {
    const result = evaluateDecision(decisionInput({
      underwriting: { invalidationRules: [rule] },
    }))
    assertBlocked(result, 'INVALID_INVALIDATION_RULE')
  }

  const confirmed = evaluateDecision(decisionInput({
    underwriting: {
      invalidationRules: [invalidationRule({
        predicate: manualPredicate,
        manualStatus: 'CONFIRMED',
        state: 'TRIGGERED',
      })],
    },
  }))
  assert.equal(confirmed.dataStatus, 'VALID')
  assert.equal(confirmed.buyAction, 'WATCH')
})

test('decision inputs fail closed when stale future-dated or temporally incoherent', () => {
  function withAsOf(component, asOf) {
    const input = decisionInput()
    if (component === 'quote') input.evaluatedPrice.asOf = asOf
    if (component === 'timing') input.timingAssessment.asOf = asOf
    if (component === 'capacity') {
      input.portfolioCapacity.asOf = asOf
      input.portfolioCapacity.denominator.asOf = asOf
    }
    if (component === 'ranges') {
      input.underwriting.valuationRange.asOf = asOf
      input.underwriting.entryRange.asOf = asOf
      input.underwriting.entryRange.derivedFrom.asOf = asOf
    }
    return input
  }

  for (const component of ['quote', 'timing', 'capacity', 'ranges']) {
    const stale = evaluateDecision(withAsOf(component, '2020-01-01T00:00:00.000Z'))
    assertBlocked(stale, 'STALE_DECISION_INPUT', `${component} stale`)

    const future = evaluateDecision(withAsOf(component, '2026-08-09T08:05:00.000Z'))
    assertBlocked(future, 'FUTURE_DECISION_INPUT', `${component} future`)
  }

  const quoteTimingMismatch = decisionInput()
  quoteTimingMismatch.timingAssessment.asOf = '2026-08-09T07:56:00.000Z'
  const mismatchedQuote = evaluateDecision(quoteTimingMismatch)
  assert.ok(mismatchedQuote.blockerCodes.includes('INCOHERENT_AS_OF'))

  const valuationEntryMismatch = decisionInput()
  valuationEntryMismatch.underwriting.entryRange.asOf = '2026-08-09T07:56:00.000Z'
  const mismatchedRange = evaluateDecision(valuationEntryMismatch)
  assert.ok(mismatchedRange.blockerCodes.includes('INCOHERENT_AS_OF'))

  const capacityMismatch = decisionInput()
  capacityMismatch.portfolioCapacity.denominator.asOf = '2026-08-09T07:56:00.000Z'
  const mismatchedCapacity = evaluateDecision(capacityMismatch)
  assert.ok(mismatchedCapacity.blockerCodes.includes('INCOHERENT_AS_OF'))
})

test('every snapshot identity requires an independently resolved matching payload', () => {
  const cases = [
    {
      name: 'missing resolved snapshot',
      mutate(input) {
        input.resolvedSnapshots = input.resolvedSnapshots.filter(
          resolved => resolved.id !== input.research.marketSnapshot.id,
        )
      },
      blockerCode: 'MISSING_RESOLVED_SNAPSHOT',
    },
    {
      name: 'version mismatch',
      mutate(input) {
        const resolved = input.resolvedSnapshots.find(
          item => item.id === input.research.qualitySnapshot.id,
        )
        resolved.version = input.research.marketSnapshot.version
      },
      blockerCode: 'SNAPSHOT_IDENTITY_MISMATCH',
    },
    {
      name: 'missing payload',
      mutate(input) {
        const resolved = input.resolvedSnapshots.find(
          item => item.id === input.underwriting.snapshotRef.id,
        )
        delete resolved.payload
      },
      blockerCode: 'MISSING_RESOLVED_SNAPSHOT_PAYLOAD',
    },
    {
      name: 'payload digest mismatch',
      mutate(input) {
        const resolved = input.resolvedSnapshots.find(
          item => item.id === input.portfolioCapacity.portfolioSnapshotRef.id,
        )
        resolved.payload = { ...resolved.payload, tampered: true }
      },
      blockerCode: 'SNAPSHOT_DIGEST_MISMATCH',
    },
  ]

  for (const scenario of cases) {
    const input = decisionInput()
    scenario.mutate(input)
    const result = evaluateDecision(input)

    assertBlocked(result, scenario.blockerCode, scenario.name)
    assert.doesNotMatch(JSON.stringify(result), /resolvedSnapshots|payload/)
  }
})

test('duplicate resolved snapshot IDs always block identity resolution', () => {
  const input = decisionInput()
  input.resolvedSnapshots.push(structuredClone(input.resolvedSnapshots[0]))

  const result = evaluateDecision(input)
  assertBlocked(result, 'DUPLICATE_RESOLVED_SNAPSHOT_ID')
})

test('snapshot hashing matches an independent hard-coded canonical SHA-256 vector', () => {
  const snapshotRef = {
    id: `snapshot:${'1'.repeat(64)}`,
    version: `version:${'2'.repeat(64)}`,
    digest: 'sha256:3ce634904076603d9a8326d4e0a7a653af7ea60255b4660db9f135982c4fbdbd',
  }
  const payload = {
    z: [3, { b: true, a: 'x' }],
    a: { d: null, c: [1, 2] },
  }

  function inputWithPayload(resolvedPayload) {
    const input = decisionInput()
    const originalId = input.research.marketSnapshot.id
    input.research.marketSnapshot = snapshotRef
    input.resolvedSnapshots = input.resolvedSnapshots
      .filter(resolved => resolved.id !== originalId)
      .concat({ id: snapshotRef.id, version: snapshotRef.version, payload: resolvedPayload })
    return input
  }

  assert.equal(evaluateDecision(inputWithPayload(payload)).buyAction, 'OPEN')

  const tamperedPayload = structuredClone(payload)
  tamperedPayload.z[1].a = 'y'
  assertBlocked(
    evaluateDecision(inputWithPayload(tamperedPayload)),
    'SNAPSHOT_DIGEST_MISMATCH',
  )
})

test('invalid ranges and incomplete capacity facts block the public seam', () => {
  const invalidValuation = decisionInput()
  invalidValuation.underwriting.valuationRange.low = 130
  invalidValuation.underwriting.entryRange.derivedFrom.low = 130
  const valuationResult = evaluateDecision(invalidValuation)
  assert.ok(valuationResult.blockerCodes.includes('INVALID_VALUATION_RANGE'))

  const invalidEntry = decisionInput()
  invalidEntry.underwriting.entryRange.lower = 110
  const entryResult = evaluateDecision(invalidEntry)
  assert.ok(entryResult.blockerCodes.includes('INVALID_ENTRY_RANGE'))

  for (const field of [
    'userHardLimit',
    'systemRiskLimit',
    'sectorHardLimit',
    'industryHardLimit',
    'portfolioHardLimit',
    'liquidityHardLimit',
  ]) {
    const input = decisionInput()
    delete input.portfolioCapacity.hardLimits[field]
    const result = evaluateDecision(input)
    assertBlocked(result, 'INVALID_PORTFOLIO_CAPACITY', field)
  }

  for (const field of ['sector', 'industry', 'portfolio', 'liquidity']) {
    const input = decisionInput()
    delete input.portfolioCapacity.remainingCapacity[field]
    const result = evaluateDecision(input)
    assertBlocked(result, 'INVALID_PORTFOLIO_CAPACITY', field)
  }
})

test('evidence and invalidation observations enforce freshness and temporal order', () => {
  const cases = [
    {
      name: 'stale evidence observation',
      mutate(input) { input.evidence.items[0].observedAt = '2020-01-01T00:00:00.000Z' },
      blockerCode: 'STALE_EVIDENCE',
    },
    {
      name: 'future evidence observation',
      mutate(input) { input.evidence.items[0].observedAt = '2026-08-09T08:05:00.000Z' },
      blockerCode: 'FUTURE_EVIDENCE',
    },
    {
      name: 'evidence observed before its as-of',
      mutate(input) { input.evidence.items[0].observedAt = '2026-08-09T07:54:00.000Z' },
      blockerCode: 'INCOHERENT_EVIDENCE_AS_OF',
    },
    {
      name: 'stale invalidation observation',
      mutate(input) {
        input.underwriting.invalidationRules[0].observedAt = '2020-01-01T00:00:00.000Z'
      },
      blockerCode: 'STALE_INVALIDATION_OBSERVATION',
    },
    {
      name: 'future invalidation observation',
      mutate(input) {
        input.underwriting.invalidationRules[0].observedAt = '2026-08-09T08:05:00.000Z'
      },
      blockerCode: 'FUTURE_INVALIDATION_OBSERVATION',
    },
    {
      name: 'invalidation observed before derived facts',
      mutate(input) {
        input.underwriting.invalidationRules[0].observedAt = '2026-08-09T07:54:00.000Z'
      },
      blockerCode: 'INCOHERENT_INVALIDATION_AS_OF',
    },
  ]

  for (const scenario of cases) {
    const input = decisionInput()
    scenario.mutate(input)
    const result = evaluateDecision(input)
    assertBlocked(result, scenario.blockerCode, scenario.name)
  }
})

test('persisted identifiers reject plaintext and credential-bearing references', () => {
  const cases = [
    {
      name: 'price source carries an account id',
      mutate(input) { input.evaluatedPrice.source = 'accountId:RH-123' },
      secret: 'RH-123',
    },
    {
      name: 'position ref carries an account id',
      mutate(input) { input.portfolioCapacity.currentPosition.positionRef = 'accountId:RH-123' },
      secret: 'RH-123',
    },
    {
      name: 'snapshot id carries an account id',
      mutate(input) { input.research.marketSnapshot.id = 'accountId:RH-123' },
      secret: 'RH-123',
    },
    {
      name: 'source ref contains a token query',
      mutate(input) {
        input.portfolioCapacity.denominator.sourceRef =
          'https://broker.test/account?token=secret-token'
      },
      secret: 'secret-token',
    },
    {
      name: 'evidence id contains plaintext',
      mutate(input) { input.evidence.items[0].id = 'evidence:quarterly-filing' },
      secret: 'quarterly-filing',
    },
    {
      name: 'evidence digest is not hexadecimal',
      mutate(input) { input.evidence.digest = 'sha256:evidence-set' },
      secret: 'evidence-set',
    },
  ]

  for (const scenario of cases) {
    const input = decisionInput()
    scenario.mutate(input)
    const result = evaluateDecision(input)
    assert.equal(result.dataStatus, 'EVALUATION_BLOCKED', scenario.name)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(scenario.secret, 'i'), scenario.name)
  }
})

test('metric invalidation thresholds accept strings and null only for equality', () => {
  for (const threshold of ['BBB-', null]) {
    const result = evaluateDecision(decisionInput({
      underwriting: {
        invalidationRules: [invalidationRule({
          predicate: {
            ...invalidationRule().predicate,
            operator: 'EQ',
            threshold,
          },
        })],
      },
    }))
    assert.equal(result.dataStatus, 'VALID', String(threshold))
  }

  const invalidNullOrdering = evaluateDecision(decisionInput({
    underwriting: {
      invalidationRules: [invalidationRule({
        predicate: { ...invalidationRule().predicate, threshold: null },
      })],
    },
  }))
  assert.ok(invalidNullOrdering.blockerCodes.includes('INVALID_INVALIDATION_RULE'))
})

test('evidence digest binds the allow-listed normalized evidence set', () => {
  const cases = [
    input => { input.evidence.items[0].claim = 'Tampered claim' },
    input => { input.evidence.items[0].stance = 'CHALLENGES' },
    input => {
      input.evidence.items[0].source.reference =
        'https://example.test/evidence/tampered'
    },
  ]

  for (const mutate of cases) {
    const input = decisionInput()
    mutate(input)
    const result = evaluateDecision(input)
    assertBlocked(result, 'EVIDENCE_DIGEST_MISMATCH')
  }
})

test('external research and timing codes cannot persist arbitrary strings', () => {
  const blockedResearch = evaluateDecision(decisionInput({
    research: {
      dataStatus: 'EVALUATION_BLOCKED',
      blockerCodes: ['accountId:RH-123', 'MISSING_QUALITY_MANIFEST'],
    },
  }))
  assert.ok(blockedResearch.blockerCodes.includes('RESEARCH_BLOCKED'))
  assert.doesNotMatch(JSON.stringify(blockedResearch), /RH-123|accountId/i)

  const timing = evaluateDecision(decisionInput({
    timingAssessment: {
      reasonCodes: ['sentinel-private-code', 'EARNINGS_SOON'],
    },
  }))
  assert.ok(timing.timingAssessment.reasonCodes.includes('TIMING_RESTRICTED'))
  assert.doesNotMatch(JSON.stringify(timing), /sentinel-private-code/i)
})
