import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshot } from '../src/domain/contentAddressing.js'
import { evaluateCandidateBatch } from '../src/domain/evaluateCandidateBatch.js'
import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'
import {
  filterDecisionRecords,
  parseDecisionRecordBatch,
} from '../src/ui/decisionRecords.js'
import {
  decisionInput,
  invalidationRule,
} from './fixtures/decision-v2-fixture.js'
import { robinhoodRead } from './fixtures/robinhood-read-fixture.js'
import { symbolMarketCase } from './fixtures/symbol-market-case-fixture.js'

function record(overrides = {}) {
  return evaluateDecision(decisionInput(overrides))
}

function parse(records, fileName = 'decisions.json') {
  return parseDecisionRecordBatch(JSON.stringify(records), { fileName })
}

function invalidBatch(recordValue, mutate) {
  const candidate = structuredClone(recordValue)
  mutate(candidate)
  assert.throws(
    () => parse([recordValue, candidate]),
    error => error?.code === 'INVALID_DECISION_RECORD_BATCH' &&
      error.message === 'Decision record batch is invalid',
  )
}

test('maps all five supplied actions without recomputing their decision', () => {
  const open = { ...record(), symbol: 'OPEN' }
  const add = { ...record({
    portfolioCapacity: {
      currentPosition: { weight: 0.01 },
      remainingCapacity: { liquidity: 0.02 },
    },
  }), symbol: 'ADD' }
  const pilot = { ...record({
    timingAssessment: { status: 'EVENT_RISK', reasonCodes: ['EARNINGS_SOON'] },
  }), symbol: 'PILOT' }
  const watch = { ...record({ underwriting: { longTermGate: 'FAIL' } }), symbol: 'WATCH' }
  const noAction = { ...record({
    portfolioCapacity: { remainingCapacity: { liquidity: 0 } },
  }), symbol: 'NONE' }

  assert.deepEqual(
    parse([open, add, pilot, watch, noAction]).records
      .map(item => [item.action.code, item.action.label])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['ADD', '增持'],
      ['NO_ACTION', '不操作'],
      ['OPEN', '开仓'],
      ['PILOT', '试仓'],
      ['WATCH', '观察'],
    ],
  )
})

test('keeps evaluation-blocked separate from an ordinary no-action decision', () => {
  const blocked = record({
    portfolioCapacity: { currentPosition: { weight: undefined } },
  })
  const noAction = { ...record({
    portfolioCapacity: { remainingCapacity: { liquidity: 0 } },
  }), symbol: 'BBB' }

  const session = parse([noAction, blocked])

  assert.deepEqual(session.records.map(item => ({
    action: item.action.code,
    dataStatus: item.dataStatus,
    blocked: item.blocked,
  })), [
    { action: 'NO_ACTION', dataStatus: 'EVALUATION_BLOCKED', blocked: true },
    { action: 'NO_ACTION', dataStatus: 'VALID', blocked: false },
  ])
  assert.deepEqual(session.summary.byStatus, {
    VALID: 1,
    EVALUATION_BLOCKED: 1,
  })
})

test('projects the complete decision spine and provenance through an allow-list', () => {
  const source = record({
    underwriting: {
      invalidationRules: [invalidationRule({
        state: 'TRIGGERED',
        severity: 'EXIT_REVIEW',
      })],
    },
    portfolioCapacity: { currentPosition: { weight: 0.02 } },
  })

  const item = parse([source], 'committee.json').records[0]

  assert.equal(item.symbol, 'AAA')
  assert.equal(item.action.code, 'NO_ACTION')
  assert.equal(item.holdingRisk, 'EXIT_REVIEW')
  assert.equal(item.evaluatedPrice.value, 95)
  assert.deepEqual(item.underwriting.valuationRange, source.underwriting.valuationRange)
  assert.deepEqual(item.underwriting.entryRange, source.underwriting.entryRange)
  assert.deepEqual(item.underwriting.invalidationRules, source.underwriting.invalidationRules)
  assert.deepEqual(item.timingAssessment, source.timingAssessment)
  assert.equal(item.capacitySummary.currentPosition.weight, 0.02)
  assert.deepEqual(item.positionSizing, source.positionSizing)
  assert.deepEqual(item.reasonCodes, ['UNDERWRITING_INVALIDATED'])
  assert.deepEqual(item.blockerCodes, [])
  assert.deepEqual(item.provenance, {
    marketSnapshot: source.marketSnapshot,
    qualitySnapshot: source.qualitySnapshot,
    researchSnapshot: source.researchSnapshot,
    underwritingSnapshot: source.underwritingSnapshot,
    portfolioSnapshot: source.capacitySummary.portfolioSnapshotRef,
    capacityPolicy: source.capacitySummary.capacityPolicyRef,
    decisionPolicy: source.decisionPolicyRef,
    evidence: source.evidence,
    capacityDigests: source.capacitySummary.digests,
  })
})

test('rejects malformed, empty, duplicate, unknown, and privacy-bearing batches atomically', () => {
  const valid = record()

  for (const text of ['', '{', '{}', '[]', 'null']) {
    assert.throws(
      () => parseDecisionRecordBatch(text),
      error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
      text,
    )
  }

  invalidBatch(valid, candidate => { candidate.symbol = ' aaa ' })
  invalidBatch(valid, candidate => { candidate.schemaVersion = 3 })
  invalidBatch(valid, candidate => { candidate.buyAction = 'BUY' })
  invalidBatch(valid, candidate => { candidate.dataStatus = 'UNKNOWN' })
  invalidBatch(valid, candidate => { candidate.accountId = 'private-account-canary' })
  invalidBatch(valid, candidate => {
    candidate.capacitySummary.currentPosition.quantity = 100
  })
  invalidBatch(valid, candidate => {
    candidate.reasonCodes = ['private-reason-canary']
  })
})

test('requires canonical producer symbols without trim or uppercase compatibility', () => {
  const first = record()
  const second = structuredClone(first)
  second.symbol = 'BBB'

  assert.deepEqual(parse([second, first]).records.map(item => item.symbol), ['AAA', 'BBB'])

  for (const noncanonical of ['aaa', ' AAA ', 'aaa ']) {
    const candidate = { ...first, symbol: noncanonical }
    assert.throws(
      () => parse([candidate]),
      error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
      noncanonical,
    )
  }

  assert.throws(() => parse([first, structuredClone(first)]), error =>
    error?.code === 'INVALID_DECISION_RECORD_BATCH')
})

function privateCaseForBatch(symbol) {
  const privateCase = structuredClone(symbolMarketCase().privateCase)
  const priorSource = privateCase.sourceSnapshots[0]
  const payload = structuredClone(priorSource.payload)
  payload.symbol = symbol
  payload.facts = payload.facts.map(fact => ({
    ...fact,
    scope: { ...fact.scope, symbol },
  }))
  const source = createSnapshot('source', payload)
  privateCase.sourceSnapshots = [source.resolved]
  privateCase.evidence.drafts = privateCase.evidence.drafts.map(draft => ({
    ...draft,
    ...(draft.sourceRef === priorSource.id ? { sourceRef: source.ref.id } : {}),
    ...(draft.scope ? { scope: { ...draft.scope, symbol } } : {}),
  }))
  privateCase.underwriting.valuationDraft.symbol = symbol
  return privateCase
}

test('parses a real multi-candidate batch with valid and semantic-blocked decisions', () => {
  const marketCase = symbolMarketCase()
  const read = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
  read.quoteBatches[0].results = read.quoteBatches[0].results
    .filter(result => result.quote.symbol !== 'BBB')
  const produced = evaluateCandidateBatch({
    schemaVersion: 1,
    evaluatedAt: marketCase.evaluatedAt,
    statArtifact: marketCase.statArtifact,
    qualityManifest: marketCase.qualityManifest,
    robinhoodRead: read,
    candidates: ['AAA', 'BBB'].map(symbol => ({
      symbol,
      privateCase: privateCaseForBatch(symbol),
    })),
  })

  const session = parseDecisionRecordBatch(JSON.stringify(produced), {
    fileName: 'candidate-decisions.json',
  })

  assert.deepEqual(produced.map(item => [item.symbol, item.buyAction, item.dataStatus]), [
    ['AAA', 'OPEN', 'VALID'],
    ['BBB', 'NO_ACTION', 'EVALUATION_BLOCKED'],
  ])
  assert.deepEqual(session.records.map(item => [
    item.symbol,
    item.action.code,
    item.blocked,
  ]), [
    ['BBB', 'NO_ACTION', true],
    ['AAA', 'OPEN', false],
  ])
})

test('accepts real producer records whose Robinhood quote keeps nanosecond precision', () => {
  const marketCase = symbolMarketCase()
  const read = robinhoodRead()
  read.quoteBatches[0].results[0].quote.venue_last_trade_time =
    '2026-08-10T19:59:00.123456789Z'
  const produced = evaluateSymbolCase({ ...marketCase, robinhoodRead: read })

  assert.equal(produced.evaluatedPrice.asOf, '2026-08-10T19:59:00.123456789Z')

  const session = parseDecisionRecordBatch(JSON.stringify([produced]))

  assert.equal(
    session.records[0].evaluatedPrice.asOf,
    '2026-08-10T19:59:00.123456789Z',
  )
})

test('preserves zero as data and preserves unavailable values as null', () => {
  const zero = record({
    portfolioCapacity: { remainingCapacity: { liquidity: 0 } },
  })
  const unavailable = record({
    evaluatedPrice: { value: undefined },
    portfolioCapacity: { currentPosition: { weight: undefined } },
  })

  const session = parse([zero, { ...unavailable, symbol: 'BBB' }])
  const zeroItem = session.records.find(item => item.symbol === 'AAA')
  const unavailableItem = session.records.find(item => item.symbol === 'BBB')

  assert.equal(zeroItem.capacitySummary.currentPosition.weight, 0)
  assert.equal(zeroItem.positionSizing.targetPosition, 0)
  assert.equal(zeroItem.positionSizing.additionalCapacity, 0)
  assert.equal(unavailableItem.evaluatedPrice, null)
  assert.equal(unavailableItem.capacitySummary, null)
  assert.equal(unavailableItem.positionSizing, null)
})

test('sorts by review priority and filters deterministically across decision facets', () => {
  const open = record()
  const add = { ...record({
    portfolioCapacity: {
      currentPosition: { weight: 0.01 },
      remainingCapacity: { liquidity: 0.02 },
    },
  }), symbol: 'ADD' }
  const pilot = { ...record({
    timingAssessment: { status: 'EVENT_RISK', reasonCodes: ['EARNINGS_SOON'] },
  }), symbol: 'PILOT' }
  const watch = { ...record({ underwriting: { longTermGate: 'FAIL' } }), symbol: 'WATCH' }
  const noAction = { ...record({
    portfolioCapacity: { remainingCapacity: { liquidity: 0 } },
  }), symbol: 'NONE' }
  const blocked = { ...record({
    portfolioCapacity: { currentPosition: { weight: undefined } },
  }), symbol: 'BLOCK' }
  const review = { ...record({
    evaluatedPrice: { value: 110 },
    portfolioCapacity: { currentPosition: { weight: 0.02 } },
  }), symbol: 'RISK' }

  const session = parse([watch, noAction, open, blocked, pilot, review, add])

  assert.deepEqual(session.records.map(item => item.symbol), [
    'RISK', 'BLOCK', 'AAA', 'ADD', 'PILOT', 'WATCH', 'NONE',
  ])
  assert.deepEqual(session.summary.byAction, {
    WATCH: 1,
    PILOT: 1,
    OPEN: 1,
    ADD: 1,
    NO_ACTION: 3,
  })
  assert.deepEqual(
    filterDecisionRecords(session.records, {
      query: 'risk',
      actions: ['NO_ACTION'],
      dataStatuses: ['VALID'],
      timingStatuses: ['PASS'],
      holdingRisks: ['REVIEW'],
    }).map(item => item.symbol),
    ['RISK'],
  )
  assert.deepEqual(
    filterDecisionRecords(session.records, { dataStatuses: ['EVALUATION_BLOCKED'] })
      .map(item => item.symbol),
    ['BLOCK'],
  )
  assert.deepEqual(filterDecisionRecords(session.records), session.records)
})

test('uses ASCII symbol order within the same decision priority', () => {
  const symbols = ['BRK.B', 'BRK-B', 'BRKB', 'BRK1']
  const session = parse(symbols.map(symbol => ({ ...record(), symbol })))

  assert.deepEqual(session.records.map(item => item.symbol), [
    'BRK-B', 'BRK.B', 'BRK1', 'BRKB',
  ])
})

test('returns a deeply immutable projection with no raw or private fields', () => {
  const source = record()
  const session = parse([source], '/private/path/decisions.json')
  const serialized = JSON.stringify(session)

  assert.ok(Object.isFrozen(session))
  assert.ok(Object.isFrozen(session.records))
  assert.ok(Object.isFrozen(session.records[0]))
  assert.ok(Object.isFrozen(session.records[0].underwriting.entryRange.derivedFrom))
  assert.throws(() => { session.records[0].symbol = 'BBB' }, TypeError)
  assert.doesNotMatch(serialized, /privateCase|resolvedSnapshots|payload|quantity|accountId/i)
  assert.doesNotMatch(serialized, /\/private\/path/)
  assert.equal(session.fileName, 'decisions.json')
})

test('fails closed on invalid parser options and filters', () => {
  const source = record()
  const session = parse([source])

  assert.throws(
    () => parseDecisionRecordBatch(JSON.stringify([source]), null),
    error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
  )
  for (const filters of [null, { query: 42 }, { unknown: true }, { actions: ['BUY'] }]) {
    assert.throws(
      () => filterDecisionRecords(session.records, filters),
      error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
    )
  }
})

test('preserves canonical supplied decisions without replaying domain action rules', () => {
  const supplied = structuredClone(record())
  supplied.buyAction = 'WATCH'
  supplied.entryStatus = 'PROHIBITED'
  supplied.reasonCodes = ['TIMING_FAILED']
  supplied.holdingRisk = 'REVIEW'
  supplied.capacitySummary.currentPosition.weight = 0.01
  supplied.positionSizing = null

  const projected = parse([supplied]).records[0]

  assert.equal(projected.action.code, 'WATCH')
  assert.equal(projected.entryStatus, 'PROHIBITED')
  assert.deepEqual(projected.reasonCodes, ['TIMING_FAILED'])
  assert.equal(projected.holdingRisk, 'REVIEW')
  assert.equal(projected.capacitySummary.currentPosition.weight, 0.01)
  assert.equal(projected.positionSizing, null)
})

test('enforces strict UTC RFC3339 timestamps and rejects privacy-bearing direct filter input', () => {
  const valid = record()
  for (const value of [
    '2026-08-10',
    'August 10, 2026',
    '2026-08-10T20:00:00+00:00',
    '2026-02-30T20:00:00Z',
    '2026-08-10T20:00:00.1234567890Z',
  ]) {
    const candidate = structuredClone(valid)
    candidate.decidedAt = value
    assert.throws(
      () => parse([candidate]),
      error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
    )
  }

  assert.throws(
    () => filterDecisionRecords([{
      symbol: 'AAA',
      action: { code: 'OPEN', label: '开仓' },
      dataStatus: 'VALID',
      holdingRisk: 'NONE',
      accountId: 'private-account-canary',
    }]),
    error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
  )
  const projected = parse([valid]).records[0]
  const frozenForgery = Object.freeze({
    ...projected,
    accountId: 'private-account-canary',
  })
  assert.throws(
    () => filterDecisionRecords([frozenForgery]),
    error => error?.code === 'INVALID_DECISION_RECORD_BATCH',
  )
})
