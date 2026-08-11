import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshot } from '../src/domain/contentAddressing.js'
import { evaluateCandidateBatch } from '../src/domain/evaluateCandidateBatch.js'
import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'
import {
  collectRobinhoodRead,
  deriveRobinhoodInputs,
  validateRobinhoodReadV3,
} from '../src/domain/robinhoodRead.js'
import {
  ACCOUNT_NUMBER,
  ROBINHOOD_CAPTURED_AT,
  REGULAR_QUOTE_AS_OF,
  addRead,
  robinhoodEarningsData,
  robinhoodEarningsResult,
  robinhoodPosition,
  robinhoodQuoteResult,
  robinhoodRead,
} from './fixtures/robinhood-read-fixture.js'
import { symbolMarketCase } from './fixtures/symbol-market-case-fixture.js'

const SYMBOL = 'AAA'
const EVALUATED_AT = ROBINHOOD_CAPTURED_AT
const SOURCE_REF = `source:${'1'.repeat(64)}`
const LIQUIDITY_REF = `source:${'2'.repeat(64)}`

function stat() {
  return {
    AAA: { sector: 'Technology', industry: 'Software' },
    BBB: { sector: 'Technology', industry: 'Software' },
  }
}

function capacityPolicy() {
  return {
    policy: {
      sourceRef: SOURCE_REF,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveUntil: '2026-09-01T00:00:00.000Z',
      userHardLimit: 0.1,
      systemRiskLimit: 0.08,
      sectorHardLimit: 0.2,
      industryHardLimit: 0.12,
      portfolioHardLimit: 0.9,
      minimumCashBufferWeight: 0.1,
    },
    liquidity: {
      maxPositionWeight: 0.06,
      asOf: ROBINHOOD_CAPTURED_AT,
      sourceRef: LIQUIDITY_REF,
    },
    freshnessPolicy: {
      maxPortfolioAgeMs: 600_000,
      maxLiquidityAgeMs: 600_000,
      maxFutureSkewMs: 60_000,
    },
  }
}

function derive(read = robinhoodRead(), overrides = {}) {
  return deriveRobinhoodInputs({
    symbol: SYMBOL,
    evaluatedAt: EVALUATED_AT,
    stat: stat(),
    robinhoodRead: read,
    capacityPolicy: capacityPolicy(),
    ...overrides,
  })
}

function source(output, kind) {
  return output.sourceSnapshots.find(snapshot => snapshot.payload.kind === kind)
}

function draft(output, key) {
  return output.evidenceDrafts.find(item => item.key === key)
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

function privateCaseFor(symbol) {
  const privateCase = structuredClone(symbolMarketCase().privateCase)
  const priorSource = privateCase.sourceSnapshots[0]
  const payload = structuredClone(priorSource.payload)
  payload.symbol = symbol
  payload.facts = payload.facts.map(fact => ({
    ...fact,
    scope: { ...fact.scope, symbol },
  }))
  const sourceSnapshot = createSnapshot('source', payload)
  privateCase.sourceSnapshots = [sourceSnapshot.resolved]
  privateCase.evidence.drafts = privateCase.evidence.drafts.map(item => ({
    ...item,
    ...(item.sourceRef === priorSource.id ? { sourceRef: sourceSnapshot.ref.id } : {}),
    ...(item.scope ? { scope: { ...item.scope, symbol } } : {}),
  }))
  privateCase.underwriting.valuationDraft.symbol = symbol
  return privateCase
}

function batchInput(read) {
  const base = symbolMarketCase()
  return {
    schemaVersion: 1,
    evaluatedAt: base.evaluatedAt,
    statArtifact: base.statArtifact,
    qualityManifest: base.qualityManifest,
    robinhoodRead: read,
    candidates: read.targetSymbols.map(symbol => ({ symbol, privateCase: privateCaseFor(symbol) })),
  }
}

test('projects one V3 read into portfolio plus content-addressed market evidence inputs', () => {
  const output = derive()

  assert.equal(output.portfolio.portfolio.positions.length, 0)
  assert.deepEqual(output.portfolio.portfolio.targetClassification,
    { sector: 'Technology', industry: 'Software' })
  assert.deepEqual(output.sourceKinds, {
    ROBINHOOD_EQUITY_QUOTE: 'PRIMARY',
    ROBINHOOD_EARNINGS_CALENDAR: 'PRIMARY',
  })
  assert.deepEqual(output.evidenceDrafts.map(item => item.key),
    ['price', 'market-session', 'earnings-schedule-known'])
  assert.equal(draft(output, 'price').factKey, 'CURRENT_PRICE')
  assert.equal(draft(output, 'price').value, 95)
  assert.equal(draft(output, 'price').asOf, REGULAR_QUOTE_AS_OF)
  assert.equal(draft(output, 'market-session').factKey, 'MARKET_SESSION')
  assert.equal(draft(output, 'market-session').value, 'REGULAR')
  assert.equal(draft(output, 'earnings-schedule-known').factKey, 'EARNINGS_SCHEDULE_KNOWN')
  assert.equal(draft(output, 'earnings-schedule-known').value, true)

  for (const resolved of output.sourceSnapshots) {
    assert.deepEqual(createSnapshot('source', resolved.payload).resolved, resolved)
  }
  assert.equal(source(output, 'ROBINHOOD_EQUITY_QUOTE').payload.observedAt,
    ROBINHOOD_CAPTURED_AT)
})

test('projects the newest trade candidate and exposes its provider session', () => {
  const quote = robinhoodQuoteResult('AAA')
  quote.quote.last_non_reg_trade_price = '55'
  quote.quote.venue_last_non_reg_trade_time = '2026-08-10T20:01:00.000Z'
  const extended = derive(robinhoodRead({
    quoteBatches: [{
      requestedSymbols: ['AAA'],
      observedAt: '2026-08-10T20:01:00.000Z',
      results: [quote],
    }],
  }))
  assert.equal(draft(extended, 'price').value, 55)
  assert.equal(draft(extended, 'market-session').value, 'EXTENDED')

  quote.quote.venue_last_non_reg_trade_time = '2026-08-10T19:58:00.000Z'
  const output = derive(robinhoodRead({
    quoteBatches: [{ requestedSymbols: ['AAA'], results: [quote] }],
  }))
  assert.equal(draft(output, 'price').value, 95)
  assert.equal(draft(output, 'price').asOf, REGULAR_QUOTE_AS_OF)

  quote.quote.venue_last_non_reg_trade_time = REGULAR_QUOTE_AS_OF
  assert.throws(() => derive(robinhoodRead({
    quoteBatches: [{ requestedSymbols: ['AAA'], results: [quote] }],
  })), /Robinhood read input is invalid/)
})

test('requires a structurally valid active traded USD quote and never promotes official close', () => {
  const variants = [
    quote => { quote.quote.venue_last_trade_time = 'not-a-timestamp' },
    quote => { quote.quote.state = 'inactive' },
    quote => { quote.quote.has_traded = false },
    quote => {
      quote.quote.last_trade_price = null
      quote.quote.venue_last_trade_time = null
      quote.close = { symbol: 'AAA', price: '50', date: '2026-08-07' }
    },
  ]
  for (const mutate of variants) {
    const quote = robinhoodQuoteResult('AAA')
    mutate(quote)
    assert.throws(() => derive(robinhoodRead({
      quoteBatches: [{ requestedSymbols: ['AAA'], results: [quote] }],
    })), /Robinhood read input is invalid/)
  }

  const nonUsd = robinhoodRead()
  nonUsd.portfolio.data.currency = 'EUR'
  assert.throws(() => derive(nonUsd), /Robinhood read input is invalid/)
})

test('preserves stale, future, and extended candidates for the sole timing authority', () => {
  for (const asOf of [
    '2026-08-09T19:59:00.000Z',
    '2026-08-10T20:01:00.001Z',
  ]) {
    const quote = robinhoodQuoteResult('AAA', '95', asOf)
    const output = derive(robinhoodRead({
      quoteBatches: [{
        requestedSymbols: ['AAA'],
        observedAt: '2026-08-10T20:02:00.000Z',
        results: [quote],
      }],
    }))
    assert.equal(draft(output, 'price').asOf, asOf)
  }

  const quote = robinhoodQuoteResult('AAA')
  quote.quote.last_non_reg_trade_price = '96'
  quote.quote.venue_last_non_reg_trade_time = '2026-08-10T20:01:00.000Z'
  const extended = derive(robinhoodRead({
    quoteBatches: [{
      requestedSymbols: ['AAA'],
      observedAt: '2026-08-10T20:01:00.000Z',
      results: [quote],
    }],
  }))
  assert.equal(draft(extended, 'market-session').value, 'EXTENDED')
})

test('does not freshness-filter held quotes or capturedAt and observes the real capture time', () => {
  for (const asOf of [
    '2026-08-10T19:30:00.000Z',
    '2026-08-10T20:01:00.001Z',
  ]) {
    const quote = robinhoodQuoteResult('AAA', '95', asOf)
    const quoteBatches = [{
      requestedSymbols: ['AAA'],
      observedAt: '2026-08-10T20:02:00.000Z',
      results: [quote],
    }]
    const unheld = derive(robinhoodRead({ quoteBatches }))
    const held = derive(robinhoodRead({
      positions: [robinhoodPosition('AAA')],
      quoteBatches: structuredClone(quoteBatches),
    }))

    assert.deepEqual(held.sourceSnapshots, unheld.sourceSnapshots)
    assert.deepEqual(held.evidenceDrafts, unheld.evidenceDrafts)
    assert.deepEqual(held.sourceKinds, unheld.sourceKinds)
    assert.equal(held.portfolio.portfolio.positions[0].markPrice, 95)
    assert.equal(held.portfolio.portfolio.positions[0].asOf, asOf)
  }

  const capturedAt = '2026-08-10T19:00:00.000Z'
  const quoteObservedAt = '2026-08-10T19:00:01.000Z'
  const output = derive(robinhoodRead({
    capturedAt,
    quoteBatches: [{
      requestedSymbols: ['AAA'],
      observedAt: quoteObservedAt,
      results: [robinhoodQuoteResult('AAA', '95', '2026-08-10T18:59:00.000Z')],
    }],
  }))
  assert.equal(source(output, 'ROBINHOOD_EQUITY_QUOTE').payload.observedAt, quoteObservedAt)
})

test('orders same-millisecond quote candidates by nanosecond precision', () => {
  const quote = robinhoodQuoteResult('AAA', '95', '2026-08-10T19:59:00.000000001Z')
  quote.quote.last_non_reg_trade_price = '96'
  quote.quote.venue_last_non_reg_trade_time = '2026-08-10T19:59:00.000000002Z'
  const output = derive(robinhoodRead({
    quoteBatches: [{ requestedSymbols: ['AAA'], results: [quote] }],
  }))

  assert.equal(draft(output, 'price').value, 96)
  assert.equal(draft(output, 'price').asOf, '2026-08-10T19:59:00.000000002Z')
  assert.equal(draft(output, 'market-session').value, 'EXTENDED')
})

test('rejects V2, unknown fields, wrong targets, and duplicate/conflicting quotes', () => {
  for (const mutate of [
    read => { read.schemaVersion = 2 },
    read => { read.order = { symbol: 'AAA' } },
    read => { read.targetSymbols = ['BBB'] },
    read => { read.earnings[0].symbol = 'BBB' },
    read => { read.earnings[0].data.results[0].order = { symbol: 'AAA' } },
    read => { read.quoteBatches[0].results[0].quote.order = { symbol: 'AAA' } },
    read => { read.quoteBatches = [] },
    read => { read.quoteBatches[0].results = [] },
    read => { read.quoteBatches[0].results.push(robinhoodQuoteResult('AAA')) },
    read => { read.portfolio.data.total_value = '0' },
  ]) {
    const read = robinhoodRead()
    mutate(read)
    assert.throws(() => derive(read), /Robinhood read input is invalid/)
  }
})

test('V3 validation enforces exact sorted targets and quote batch structure', () => {
  const valid = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
  assert.equal(validateRobinhoodReadV3(valid, ['AAA', 'BBB']), true)
  assert.throws(() => validateRobinhoodReadV3(valid, ['AAA']),
    /Robinhood read input is invalid/)

  for (const mutate of [
    read => { read.targetSymbols = ['BBB', 'AAA'] },
    read => { read.targetSymbols = ['AAA', 'AAA'] },
    read => { read.quoteBatches[0].requestedSymbols = ['BBB', 'AAA'] },
    read => { read.quoteBatches[0].results.push(robinhoodQuoteResult('CCC')) },
    read => { read.quoteBatches[0].results.push(robinhoodQuoteResult('AAA')) },
    read => { delete read.quoteBatches[0].observedAt },
    read => { read.earnings.reverse() },
  ]) {
    const read = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
    mutate(read)
    assert.throws(() => validateRobinhoodReadV3(read), /Robinhood read input is invalid/)
  }

  const v2 = robinhoodRead()
  v2.schemaVersion = 2
  assert.throws(() => validateRobinhoodReadV3(v2), /Robinhood read input is invalid/)
})

test('V3 preflight keeps shared provider semantics candidate-local', () => {
  for (const mutate of [
    read => { read.portfolio.data.crypto_value = '1' },
    read => { read.accounts[0].agentic_allowed = false },
  ]) {
    const read = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
    mutate(read)

    assert.equal(validateRobinhoodReadV3(read, ['AAA', 'BBB']), true)
    const results = evaluateCandidateBatch(batchInput(read))
    assert.deepEqual(results.map(result => [result.symbol, result.dataStatus, result.buyAction]), [
      ['AAA', 'EVALUATION_BLOCKED', 'NO_ACTION'],
      ['BBB', 'EVALUATION_BLOCKED', 'NO_ACTION'],
    ])
  }
})

test('quote observation causality uses nanoseconds and remains target-local', () => {
  const read = robinhoodRead({
    targetSymbols: ['AAA', 'BBB'],
    quoteBatches: [{
      requestedSymbols: ['AAA', 'BBB'],
      observedAt: '2026-08-10T19:59:00.000000001Z',
      results: [
        robinhoodQuoteResult('AAA', '95', '2026-08-10T19:59:00.000000001Z'),
        robinhoodQuoteResult('BBB', '95', '2026-08-10T19:59:00.000000002Z'),
      ],
    }],
  })

  assert.equal(validateRobinhoodReadV3(read, ['AAA', 'BBB']), true)
  assert.equal(derive(read).evidenceDrafts.find(item => item.key === 'price').value, 95)
  assert.throws(() => derive(read, { symbol: 'BBB' }), /Robinhood read input is invalid/)

  read.quoteBatches[0].observedAt = '2026-08-10T19:59:00.000000002Z'
  assert.equal(derive(read, { symbol: 'BBB' })
    .evidenceDrafts.find(item => item.key === 'price').value, 95)

  const sharedHeld = robinhoodRead({
    targetSymbols: ['AAA', 'BBB'],
    positions: [robinhoodPosition('CCC')],
    quoteBatches: [{
      requestedSymbols: ['AAA', 'BBB', 'CCC'],
      observedAt: '2026-08-10T19:59:00.000000001Z',
      results: [
        robinhoodQuoteResult('AAA', '95', '2026-08-10T19:59:00.000000001Z'),
        robinhoodQuoteResult('BBB', '95', '2026-08-10T19:59:00.000000001Z'),
        robinhoodQuoteResult('CCC', '95', '2026-08-10T19:59:00.000000002Z'),
      ],
    }],
  })
  assert.equal(validateRobinhoodReadV3(sharedHeld, ['AAA', 'BBB']), true)
  for (const symbol of ['AAA', 'BBB']) {
    assert.throws(() => derive(sharedHeld, { symbol }), /Robinhood read input is invalid/)
  }
})

test('isolates target-only quote failures while held quotes remain shared capacity dependencies', () => {
  const isolated = robinhoodRead({ targetSymbols: ['AAA', 'BBB'] })
  isolated.quoteBatches[0].results.find(result => result.quote.symbol === 'BBB').quote.state = 'inactive'
  assert.equal(derive(isolated).evidenceDrafts.find(item => item.key === 'price').value, 95)
  assert.throws(() => derive(isolated, { symbol: 'BBB' }), /Robinhood read input is invalid/)

  const missingTarget = robinhoodRead({
    quoteBatches: [{ requestedSymbols: ['AAA'], results: [] }],
  })
  assert.equal(validateRobinhoodReadV3(missingTarget), true)
  const missingResult = evaluateSymbolCase(symbolMarketCase({ robinhoodRead: missingTarget }))
  assert.equal(missingResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(missingResult.buyAction, 'NO_ACTION')

  const sharedHeld = robinhoodRead({
    targetSymbols: ['AAA', 'BBB'],
    positions: [robinhoodPosition('CCC')],
  })
  sharedHeld.quoteBatches[0].results
    .find(result => result.quote.symbol === 'CCC').quote.state = 'inactive'
  for (const symbol of ['AAA', 'BBB']) {
    assert.throws(() => derive(sharedHeld, { symbol }), /Robinhood read input is invalid/)
  }
})

test('projects verified and tentative pending reports without classifying event risk', () => {
  for (const verified of [true, false]) {
    const earnings = robinhoodEarningsData({ results: [
      robinhoodEarningsResult({ actual: 1.2, date: '2026-07-30' }),
      robinhoodEarningsResult({
        quarter: 3,
        actual: null,
        date: '2026-08-24',
        timing: 'am',
        verified,
      }),
    ] })
    const output = derive(robinhoodRead({ earnings }))
    assert.equal(draft(output, 'earnings-schedule-known').value, true)
    assert.deepEqual(draft(output, 'next-earnings-at').value,
      { date: '2026-08-24', timing: 'am', verified })
  }
})

test('leaves the event-window boundary entirely to timingAssessment', () => {
  for (const date of ['2026-08-24', '2026-08-25']) {
    const output = derive(robinhoodRead({
      earnings: robinhoodEarningsData({ results: [
        robinhoodEarningsResult(),
        robinhoodEarningsResult({
          quarter: 3,
          actual: null,
          date,
          timing: 'pm',
          verified: false,
        }),
      ] }),
    }))
    assert.equal(draft(output, 'earnings-schedule-known').value, true)
    assert.deepEqual(draft(output, 'next-earnings-at').value,
      { date, timing: 'pm', verified: false })
  }
})

test('fails closed for empty, not-found, malformed, or ambiguous earnings data', () => {
  const cases = [
    robinhoodEarningsData({ results: [] }),
    robinhoodEarningsData({ notFound: ['AAA'], results: [] }),
    robinhoodEarningsData({ results: [
      robinhoodEarningsResult({ actual: null, date: null }),
    ] }),
    robinhoodEarningsData({ results: [
      robinhoodEarningsResult({ quarter: 3, actual: null, date: '2026-08-20' }),
      robinhoodEarningsResult({ quarter: 4, actual: null, date: '2026-10-20' }),
    ] }),
  ]
  for (const earnings of cases) {
    assert.throws(() => derive(robinhoodRead({ earnings })),
      /Robinhood read input is invalid/)
  }
})

test('fails closed when a future New York report already has an actual EPS', () => {
  const capturedAt = '2026-08-11T01:00:00.000Z'
  const earnings = robinhoodEarningsData({ results: [
    robinhoodEarningsResult({ actual: 1.2, date: '2026-08-11' }),
  ] })
  assert.throws(() => derive(robinhoodRead({ capturedAt, earnings })),
    /Robinhood read input is invalid/)
})

test('replays captured earnings facts without using evaluatedAt as an adapter gate', () => {
  const capturedAt = '2026-08-12T20:00:00.000Z'
  const evaluatedAt = '2026-08-10T20:00:00.000Z'
  const earnings = robinhoodEarningsData({ results: [
    robinhoodEarningsResult({ actual: 1.2, date: '2026-08-11', timing: 'pm' }),
  ] })

  const output = derive(robinhoodRead({ capturedAt, earnings }), { evaluatedAt })
  assert.equal(draft(output, 'earnings-schedule-known').value, true)
  assert.equal(source(output, 'ROBINHOOD_EARNINGS_CALENDAR').payload.observedAt, capturedAt)

  const result = evaluateSymbolCase(symbolMarketCase({
    evaluatedAt,
    robinhoodRead: robinhoodRead({ capturedAt, earnings }),
  }))
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.ok(result.blockerCodes.includes('INVALID_TIMING_ASSESSMENT'))
})

test('blocks same-day actual earnings whose coarse timing cannot prove completion', () => {
  for (const { capturedAt, timing } of [
    { capturedAt: '2026-08-10T20:00:00.000Z', timing: null },
    { capturedAt: '2026-08-10T19:59:59.999Z', timing: 'pm' },
  ]) {
    const earnings = robinhoodEarningsData({ results: [
      robinhoodEarningsResult({ actual: 1.2, date: '2026-08-10', timing }),
    ] })
    const result = evaluateSymbolCase(symbolMarketCase({
      robinhoodRead: robinhoodRead({ capturedAt, earnings }),
    }))

    assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(result.buyAction, 'NO_ACTION')
  }
})

test('accepts same-day actual earnings only after the reported New York session boundary', () => {
  for (const { capturedAt, observedAt, quoteAsOf, quoteObservedAt, timing } of [
    {
      capturedAt: '2026-08-10T12:00:00.000Z',
      observedAt: '2026-08-10T13:30:00.000Z',
      quoteAsOf: '2026-08-10T13:29:00.000Z',
      quoteObservedAt: '2026-08-10T13:29:30.000Z',
      timing: 'am',
    },
    {
      capturedAt: '2026-08-10T19:00:00.000Z',
      observedAt: '2026-08-10T20:00:00.001Z',
      quoteAsOf: REGULAR_QUOTE_AS_OF,
      quoteObservedAt: '2026-08-10T19:59:30.000Z',
      timing: 'pm',
    },
  ]) {
    const earnings = robinhoodEarningsData({ results: [
      robinhoodEarningsResult({ actual: 1.2, date: '2026-08-10', timing }),
    ] })
    const output = derive(robinhoodRead({
      capturedAt,
      earningsWrappers: [{ symbol: 'AAA', observedAt, data: earnings }],
      quoteBatches: [{
        requestedSymbols: ['AAA'],
        observedAt: quoteObservedAt,
        results: [robinhoodQuoteResult('AAA', '95', quoteAsOf)],
      }],
    }))

    assert.equal(draft(output, 'earnings-schedule-known').value, true)
    assert.equal(source(output, 'ROBINHOOD_EARNINGS_CALENDAR').payload.observedAt, observedAt)
  }

  const beforePm = robinhoodRead({
    capturedAt: '2026-08-10T21:00:00.000Z',
    earningsWrappers: [{
      symbol: 'AAA',
      observedAt: '2026-08-10T19:59:59.999Z',
      data: robinhoodEarningsData({ results: [
        robinhoodEarningsResult({ actual: 1.2, date: '2026-08-10', timing: 'pm' }),
      ] }),
    }],
  })
  assert.throws(() => derive(beforePm), /Robinhood read input is invalid/)
})

test('applies capacity freshness independently to each held-position mark', () => {
  const evaluateHeld = asOf => evaluateSymbolCase(symbolMarketCase({
    robinhoodRead: robinhoodRead({
      positions: [robinhoodPosition('BBB')],
      quoteBatches: [{
        requestedSymbols: ['AAA', 'BBB'],
        results: [
          robinhoodQuoteResult('AAA'),
          robinhoodQuoteResult('BBB', '50', asOf),
        ],
      }],
    }),
  }))

  const fresh = evaluateHeld('2026-08-10T19:59:00.000Z')
  assert.equal(fresh.dataStatus, 'VALID')
  assert.equal(fresh.buyAction, 'OPEN')

  for (const asOf of [
    '2026-08-10T19:49:59.999Z',
    '2026-08-10T20:01:00.001Z',
  ]) {
    const result = evaluateHeld(asOf)
    assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
    assert.equal(result.buyAction, 'NO_ACTION')
    assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
  }
})

test('projects later-page holdings and validates pagination, classification, and quote batches', () => {
  const output = derive(addRead())
  assert.equal(output.portfolio.portfolio.positions.length, 2)
  assert.equal(output.portfolio.portfolio.positions.find(item => item.symbol === 'AAA').quantity, 10)

  const incomplete = addRead()
  incomplete.positionPages.pop()
  assert.throws(() => derive(incomplete), /Robinhood read input is invalid/)

  const oversized = robinhoodRead()
  oversized.quoteBatches = [{
    requestedSymbols: Array.from({ length: 21 }, (_, index) => `A${index}`),
    results: [],
  }]
  assert.throws(() => derive(oversized), /Robinhood read input is invalid/)

  const noClassification = stat()
  delete noClassification.BBB.industry
  assert.throws(() => derive(robinhoodRead({ positions: [robinhoodPosition('BBB')] }), {
    stat: noClassification,
  }), /Robinhood read input is invalid/)

  const duplicateCursor = robinhoodRead({
    positionPages: [
      { accountNumber: ACCOUNT_NUMBER, cursor: null,
        next: 'https://api.robinhood.com/positions/?cursor=next', positions: [] },
      { accountNumber: ACCOUNT_NUMBER, cursor: 'next', next: null, positions: [] },
      { accountNumber: ACCOUNT_NUMBER, cursor: null, next: null, positions: [] },
    ],
  })
  assert.throws(() => derive(duplicateCursor), /Robinhood read input is invalid/)
})

test('preserves inputs and keeps account identifiers out of all content-addressed outputs', () => {
  const input = {
    symbol: SYMBOL,
    evaluatedAt: EVALUATED_AT,
    stat: stat(),
    robinhoodRead: addRead(),
    capacityPolicy: capacityPolicy(),
  }
  const before = structuredClone(input)
  const output = deriveRobinhoodInputs(input)
  assert.deepEqual(input, before)

  const serializedMarket = JSON.stringify({
    sourceSnapshots: output.sourceSnapshots,
    evidenceDrafts: output.evidenceDrafts,
    sourceKinds: output.sourceKinds,
    portfolioRef: output.portfolio.portfolio.sourceRef,
  })
  assert.doesNotMatch(serializedMarket, new RegExp(ACCOUNT_NUMBER))
  assert.doesNotMatch(serializedMarket,
    /account_number|selectedAccountNumber|total_value|last_trade_price|venue_last_trade_time/)
})

function collectorClient({
  positionsByCursor,
  quoteCalls = [],
  earningsCalls = [],
  sharedCalls = [],
  methodCalls = [],
  accountOverrides = {},
  transportError = null,
} = {}) {
  const accounts = [{
    account_number: ACCOUNT_NUMBER,
    agentic_allowed: true,
    state: 'active',
    type: 'cash',
    deactivated: false,
    permanently_deactivated: false,
    ...accountOverrides,
  }]
  const portfolio = robinhoodRead().portfolio.data
  return {
    getAccounts: async () => {
      sharedCalls.push('accounts')
      methodCalls.push('accounts')
      return { accounts }
    },
    getPortfolio: async ({ accountNumber }) => {
      sharedCalls.push('portfolio')
      methodCalls.push('portfolio')
      if (transportError) throw transportError
      assert.equal(accountNumber, ACCOUNT_NUMBER)
      return portfolio
    },
    getEquityPositions: async ({ accountNumber, cursor }) => {
      sharedCalls.push(`positions:${cursor ?? 'first'}`)
      methodCalls.push('positions')
      assert.equal(accountNumber, ACCOUNT_NUMBER)
      return positionsByCursor?.get(cursor ?? null) ?? { positions: [], next: null }
    },
    getEquityQuotes: async ({ symbols }) => {
      methodCalls.push('quotes')
      quoteCalls.push([...symbols])
      return {
        results: symbols.map(symbol => robinhoodQuoteResult(
          symbol,
          '50',
          '2026-08-10T19:59:01.596466038Z',
        )),
      }
    },
    getEarningsResults: async ({ symbol }) => {
      methodCalls.push('earnings')
      earningsCalls.push(symbol)
      return robinhoodEarningsData({
        results: [robinhoodEarningsResult({ symbol })],
      })
    },
  }
}

test('collector rejects every ineligible selected account before downstream provider calls', async () => {
  for (const accountOverrides of [
    { agentic_allowed: false },
    { state: 'inactive-secret' },
    { type: 'margin-secret' },
    { deactivated: true },
    { permanently_deactivated: true },
  ]) {
    const methodCalls = []
    await assert.rejects(() => collectRobinhoodRead({
      selectedAccountNumber: ACCOUNT_NUMBER,
      targetSymbols: ['AAA'],
      clock: () => ROBINHOOD_CAPTURED_AT,
      client: collectorClient({ accountOverrides, methodCalls }),
    }), error => {
      assert.equal(error.code, 'INVALID_ROBINHOOD_READ_INPUT')
      assert.equal(error.message, 'Robinhood read input is invalid')
      assert.equal(error.message.includes(ACCOUNT_NUMBER), false)
      assert.equal(error.message.includes('secret'), false)
      return true
    })
    assert.deepEqual(methodCalls, ['accounts'])
  }
})

test('collector follows cursors, quotes held union target once, and collects target earnings', async () => {
  const positionsByCursor = new Map([
    [null, {
      positions: [robinhoodPosition('BBB')],
      next: 'https://api.robinhood.com/positions/?cursor=later',
    }],
    ['later', { positions: [robinhoodPosition('AAA', '10')], next: null }],
  ])
  const quoteCalls = []
  const earningsCalls = []
  const sharedCalls = []
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient({ positionsByCursor, quoteCalls, earningsCalls, sharedCalls }),
  })

  assert.equal(read.schemaVersion, 3)
  assert.deepEqual(read.targetSymbols, ['AAA'])
  assert.equal(read.positionPages.length, 2)
  assert.deepEqual(quoteCalls, [['AAA', 'BBB']])
  assert.deepEqual(earningsCalls, ['AAA'])
  assert.deepEqual(sharedCalls, ['accounts', 'portfolio', 'positions:first', 'positions:later'])
  assert.equal(read.quoteBatches[0].results[0].quote.venue_last_trade_time,
    '2026-08-10T19:59:01.596466038Z')
  assert.equal(derive(read).portfolio.portfolio.positions.length, 2)
})

test('collector quotes the target and resolves earnings even when the account has no positions', async () => {
  const quoteCalls = []
  const earningsCalls = []
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient({ quoteCalls, earningsCalls }),
  })

  assert.deepEqual(quoteCalls, [['AAA']])
  assert.deepEqual(earningsCalls, ['AAA'])
  assert.deepEqual(read.positionPages[0].positions, [])
  assert.equal(read.quoteBatches[0].results[0].quote.symbol, 'AAA')
})

test('collector preserves a missing target quote for per-symbol blocked semantics', async () => {
  const client = collectorClient()
  client.getEquityQuotes = async () => ({ results: [] })
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client,
  })

  assert.deepEqual(read.quoteBatches[0].requestedSymbols, ['AAA'])
  assert.deepEqual(read.quoteBatches[0].results, [])
  assert.equal(validateRobinhoodReadV3(read, ['AAA']), true)
  assert.throws(() => derive(read), /Robinhood read input is invalid/)
})

test('collector batches exactly twenty and twenty-one sorted targets', async () => {
  for (const count of [20, 21]) {
    const targetSymbols = Array.from(
      { length: count },
      (_, index) => `S${String(index).padStart(2, '0')}`,
    )
    const quoteCalls = []
    const earningsCalls = []
    const read = await collectRobinhoodRead({
      selectedAccountNumber: ACCOUNT_NUMBER,
      targetSymbols,
      clock: () => ROBINHOOD_CAPTURED_AT,
      client: collectorClient({ quoteCalls, earningsCalls }),
    })

    assert.deepEqual(quoteCalls.map(batch => batch.length), count === 20 ? [20] : [20, 1])
    assert.deepEqual(quoteCalls.flat(), targetSymbols)
    assert.deepEqual(earningsCalls, targetSymbols)
    assert.deepEqual(read.targetSymbols, targetSymbols)
  }
})

test('collector records bundle, quote, and per-target earnings observation clocks independently', async () => {
  const times = [
    '2026-08-10T20:00:00.000Z',
    '2026-08-10T20:00:01.000Z',
    '2026-08-10T20:00:02.000Z',
    '2026-08-10T20:00:03.000Z',
  ]
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA', 'BBB'],
    clock: () => times.shift(),
    client: collectorClient(),
  })

  assert.equal(read.capturedAt, '2026-08-10T20:00:00.000Z')
  assert.equal(read.quoteBatches[0].observedAt, '2026-08-10T20:00:01.000Z')
  assert.deepEqual(read.earnings.map(wrapper => [wrapper.symbol, wrapper.observedAt]), [
    ['AAA', '2026-08-10T20:00:02.000Z'],
    ['BBB', '2026-08-10T20:00:03.000Z'],
  ])
  assert.equal(times.length, 0)
})

test('collector accepts exactly five read methods and never an order capability', async () => {
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbol: 'AAA',
    capturedAt: ROBINHOOD_CAPTURED_AT,
    client: collectorClient(),
  }), /Robinhood read input is invalid/)

  const client = { ...collectorClient(), placeOrder() {} }
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client,
  }), /Robinhood read input is invalid/)

  const missing = collectorClient()
  delete missing.getEarningsResults
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: missing,
  }), /Robinhood read input is invalid/)
})

test('collector propagates transport failures and rejects cursor cycles without mutating responses', async () => {
  const transportError = new Error('transport probe')
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient({ transportError }),
  }), error => error === transportError)

  const page = {
    positions: [robinhoodPosition('BBB')],
    next: 'https://api.robinhood.com/positions/?cursor=cycle',
  }
  const before = structuredClone(page)
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient({
      positionsByCursor: new Map([[null, page], ['cycle', page]]),
    }),
  }), /Robinhood read input is invalid/)
  assert.deepEqual(page, before)
})

test('collector projects nanosecond provider responses without mutating them', async () => {
  const rawQuote = robinhoodQuoteResult(
    'AAA',
    '95',
    '2026-08-10T19:59:01.596466038Z',
  )
  const rawEarnings = robinhoodEarningsData()
  const before = structuredClone({ rawQuote, rawEarnings })
  const client = collectorClient()
  client.getEquityQuotes = async () => ({ results: [rawQuote] })
  client.getEarningsResults = async () => rawEarnings

  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client,
  })

  assert.deepEqual({ rawQuote, rawEarnings }, before)
  assert.equal(read.quoteBatches[0].results[0].quote.venue_last_trade_time,
    '2026-08-10T19:59:01.596466038Z')
})

test('collector rejects repeated positions, malformed quotes, and malformed earnings', async () => {
  const duplicate = robinhoodPosition('BBB')
  const duplicatePages = new Map([
    [null, {
      positions: [duplicate],
      next: 'https://api.robinhood.com/positions/?cursor=overlap',
    }],
    ['overlap', { positions: [structuredClone(duplicate)], next: null }],
  ])
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient({ positionsByCursor: duplicatePages }),
  }), /Robinhood read input is invalid/)

  const badQuote = collectorClient()
  badQuote.getEquityQuotes = async () => ({ results: [robinhoodQuoteResult('BBB')] })
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: badQuote,
  }), /Robinhood read input is invalid/)

  const badEarnings = collectorClient()
  badEarnings.getEarningsResults = async () => ({ results: 'not-an-array' })
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: badEarnings,
  }), /Robinhood read input is invalid/)
})

test('public Robinhood read and derived inputs are recursively immutable', async () => {
  const output = derive()
  assertDeepFrozen(output)
  assert.throws(() => { output.sourceKinds.ROBINHOOD_EQUITY_QUOTE = 'SECONDARY' }, TypeError)
  assert.throws(() => { output.evidenceDrafts[0].scope.symbol = 'BBB' }, TypeError)

  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    targetSymbols: ['AAA'],
    clock: () => ROBINHOOD_CAPTURED_AT,
    client: collectorClient(),
  })
  assertDeepFrozen(read)
  assert.throws(() => { read.positionPages[0].positions.push(robinhoodPosition('BBB')) }, TypeError)
  assert.throws(() => { read.earnings[0].data.results[0].eps.actual = 2 }, TypeError)
})
