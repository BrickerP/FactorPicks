import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshot } from '../src/domain/contentAddressing.js'
import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'
import {
  AS_OF,
  NOW,
  STAT_ARTIFACT_VECTORS,
  symbolMarketCase,
} from './fixtures/symbol-market-case-fixture.js'
import {
  robinhoodEarningsData,
  robinhoodEarningsResult,
  robinhoodQuoteResult,
  robinhoodRead,
} from './fixtures/robinhood-read-fixture.js'

function assertBlocked(result) {
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
}

function useArtifact(input, vector) {
  input.statArtifact = vector.raw
  input.qualityManifest.statArtifact = { ...vector.contract }
  return input
}

test('evaluates a canonical symbol case through the DecisionRecordV2 seam', () => {
  const input = symbolMarketCase()
  assert.deepEqual(input.qualityManifest.statArtifact, {
    sha256: '782c11f2438d8599138a9ce7143442df9e17f519dcb81908eae36ccfe34a0449',
    bytes: 463,
    symbols: 2,
  })
  const result = evaluateSymbolCase(input)

  assert.deepEqual({
    schemaVersion: result.schemaVersion,
    symbol: result.symbol,
    decidedAt: result.decidedAt,
    dataStatus: result.dataStatus,
    buyAction: result.buyAction,
    price: result.evaluatedPrice && {
      value: result.evaluatedPrice.value,
      currency: result.evaluatedPrice.currency,
      asOf: result.evaluatedPrice.asOf,
    },
  }, {
    schemaVersion: 2,
    symbol: 'AAA',
    decidedAt: NOW,
    dataStatus: 'VALID',
    buyAction: 'OPEN',
    price: { value: 95, currency: 'USD', asOf: AS_OF },
  })
})

test('normalizes the symbol before selecting its universe row', () => {
  const input = symbolMarketCase({ symbol: '  aaa  ' })
  input.privateCase.researchPolicy.minimumSectorSampleSize = 2
  input.privateCase.researchPolicy.minimumGlobalSampleSize = 2
  const result = evaluateSymbolCase(input)

  assert.equal(result.symbol, 'AAA')
  assert.equal(result.dataStatus, 'VALID')
})

test('missing research rows block while Yahoo Close is not a timing authority', () => {
  const missing = useArtifact(symbolMarketCase(), STAT_ARTIFACT_VECTORS.missingAaa)
  missing.qualityManifest.requested = 1
  missing.qualityManifest.succeeded = 1
  missing.qualityManifest.coverage = Object.fromEntries(
    Object.keys(missing.qualityManifest.coverage)
      .map(field => [field, { available: 1, total: 1, rate: 1 }]),
  )
  assertBlocked(evaluateSymbolCase(missing))

  const invalid = useArtifact(symbolMarketCase(), STAT_ARTIFACT_VECTORS.invalidPrice)
  const result = evaluateSymbolCase(invalid)
  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.evaluatedPrice.value, 95)
  assert.equal(result.evaluatedPrice.asOf, AS_OF)
})

test('Yahoo row timestamps never replace or invalidate the Robinhood quote', () => {
  for (const vector of [
    STAT_ARTIFACT_VECTORS.invalidAsOf,
    STAT_ARTIFACT_VECTORS.lowercaseObservedAt,
    STAT_ARTIFACT_VECTORS.spacedAsOf,
  ]) {
    const result = evaluateSymbolCase(useArtifact(symbolMarketCase(), vector))
    assert.equal(result.dataStatus, 'VALID')
    assert.equal(result.evaluatedPrice.value, 95)
    assert.equal(result.evaluatedPrice.asOf, AS_OF)
  }
})

test('future and stale Yahoo row times remain research-only metadata', () => {
  for (const vector of [STAT_ARTIFACT_VECTORS.future, STAT_ARTIFACT_VECTORS.stale]) {
    const result = evaluateSymbolCase(useArtifact(symbolMarketCase(), vector))
    assert.equal(result.dataStatus, 'VALID')
    assert.equal(result.evaluatedPrice.value, 95)
    assert.equal(result.evaluatedPrice.asOf, AS_OF)
  }
})

test('rejects private CURRENT_PRICE sources and drafts even when values agree', () => {
  const privateSource = symbolMarketCase()
  const privatePrice = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [{ factKey: 'CURRENT_PRICE', value: 95, asOf: AS_OF,
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  privateSource.privateCase.sourceSnapshots.push(privatePrice.resolved)
  assert.throws(() => evaluateSymbolCase(privateSource), /Symbol case input is invalid/)

  const privateDraft = symbolMarketCase()
  privateDraft.privateCase.evidence.drafts.push({
    key: 'private-current-price', claimKey: 'PRICE', factKey: 'CURRENT_PRICE', value: 95,
    sourceRef: privatePrice.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1,
  })
  assert.throws(() => evaluateSymbolCase(privateDraft), /Symbol case input is invalid/)
})

test('rejects a private price alias as the timing price authority', () => {
  const input = symbolMarketCase()
  const privatePrice = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [{ factKey: 'PRIVATE_PRICE', value: 5, asOf: AS_OF,
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  input.privateCase.sourceSnapshots.push(privatePrice.resolved)
  input.privateCase.evidence.drafts.push({
    key: 'private-price-alias', claimKey: 'PRICE', factKey: 'PRIVATE_PRICE', value: 5,
    sourceRef: privatePrice.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1,
  })
  input.privateCase.timing.policy.currentPriceFactKey = 'PRIVATE_PRICE'

  assert.throws(() => evaluateSymbolCase(input), /Symbol case input is invalid/)
})

test('rejects any private draft occupying the adapter price namespace', () => {
  const input = symbolMarketCase()
  const privatePrice = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [{ factKey: 'PRIVATE_PRICE', value: 5, asOf: AS_OF,
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  input.privateCase.sourceSnapshots.push(privatePrice.resolved)
  input.privateCase.evidence.drafts.push({
    key: 'alias-price', claimKey: 'PRICE', factKey: 'PRIVATE_PRICE', value: 5,
    sourceRef: privatePrice.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1,
  })

  assert.throws(() => evaluateSymbolCase(input), /Symbol case input is invalid/)

  const reservedKey = symbolMarketCase()
  reservedKey.privateCase.sourceSnapshots.push(privatePrice.resolved)
  reservedKey.privateCase.evidence.drafts.push({
    key: 'price', claimKey: 'PRIVATE_PRICE', factKey: 'PRIVATE_PRICE', value: 5,
    sourceRef: privatePrice.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1,
  })
  assert.throws(() => evaluateSymbolCase(reservedKey), /Symbol case input is invalid/)
})

test('non-authoritative private price-like facts never replace the Robinhood price', () => {
  const sourceOnly = symbolMarketCase()
  const privatePrice = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [{ factKey: 'PRIVATE_PRICE', value: 5, asOf: AS_OF,
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  sourceOnly.privateCase.sourceSnapshots.push(privatePrice.resolved)
  assert.equal(evaluateSymbolCase(sourceOnly).evaluatedPrice.value, 95)

  const target = symbolMarketCase()
  const targetPrice = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [{ factKey: 'TARGET_PRICE', value: 120, asOf: AS_OF,
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  target.privateCase.sourceSnapshots.push(targetPrice.resolved)
  target.privateCase.evidence.drafts.push({
    key: 'analyst-target', claimKey: 'VALUATION_TARGET', factKey: 'TARGET_PRICE', value: 120,
    sourceRef: targetPrice.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1,
  })
  assert.equal(evaluateSymbolCase(target).evaluatedPrice.value, 95)
})

test('a failed symbol in the quality manifest blocks the decision', () => {
  const input = symbolMarketCase()
  input.qualityManifest = {
    ...input.qualityManifest,
    requested: 3,
    succeeded: 2,
    failed: 1,
    successRate: 0.666667,
    failedSymbols: ['AAA'],
  }

  const result = evaluateSymbolCase(input)

  assertBlocked(result)
  assert.ok(result.blockerCodes.includes('QUALITY_FAILURE_FOR_SYMBOL'))
})

test('quality-manifest failures remain semantic blocked decisions', () => {
  const input = symbolMarketCase()
  input.qualityManifest.source = 'unknown-producer'

  const result = evaluateSymbolCase(input)

  assertBlocked(result)
  assert.ok(result.blockerCodes.includes('UNEXPECTED_QUALITY_MANIFEST_SOURCE'))
})

test('binds the exact UTF-8 stat artifact bytes to the quality manifest', () => {
  const unicode = useArtifact(symbolMarketCase(), STAT_ARTIFACT_VECTORS.unicode)
  assert.equal(unicode.statArtifact.length, 461)
  assert.equal(unicode.qualityManifest.statArtifact.bytes, 463)
  assert.equal(evaluateSymbolCase(unicode).dataStatus, 'VALID')

  const tamperedArtifact = symbolMarketCase()
  tamperedArtifact.statArtifact = tamperedArtifact.statArtifact.replace('"Close":95', '"Close":96')
  const tamperedResult = evaluateSymbolCase(tamperedArtifact)
  assertBlocked(tamperedResult)
  assert.equal(tamperedResult.evaluatedPrice.value, 95)
  assert.equal(tamperedResult.evaluatedPrice.asOf, AS_OF)

  const mixedGeneration = symbolMarketCase()
  mixedGeneration.qualityManifest.statArtifact = {
    ...STAT_ARTIFACT_VECTORS.unicode.contract,
  }
  const mixedResult = evaluateSymbolCase(mixedGeneration)
  assertBlocked(mixedResult)
  assert.equal(mixedResult.evaluatedPrice.value, 95)
  assert.equal(mixedResult.evaluatedPrice.asOf, AS_OF)
})

test('requires artifact symbols, manifest success count, and parsed rows to agree', () => {
  const wrongSymbols = symbolMarketCase()
  wrongSymbols.qualityManifest.statArtifact.symbols = 1
  assertBlocked(evaluateSymbolCase(wrongSymbols))

  const wrongSuccessCount = symbolMarketCase()
  wrongSuccessCount.qualityManifest.succeeded = 1
  assertBlocked(evaluateSymbolCase(wrongSuccessCount))

  const nonCanonicalContract = symbolMarketCase()
  nonCanonicalContract.qualityManifest.statArtifact.generation = 'mixed'
  assertBlocked(evaluateSymbolCase(nonCanonicalContract))
})

test('requires canonical evaluatedAt while Yahoo currency cannot become quote currency', () => {
  for (const evaluatedAt of [
    '2026-02-30T08:00:00.000Z',
    '2026-08-10T08:00:00.000z',
    ' 2026-08-10T08:00:00.000Z',
    '2026-08-10T08:00:00Z',
  ]) {
    assert.throws(
      () => evaluateSymbolCase(symbolMarketCase({ evaluatedAt })),
      /Symbol case input is invalid/,
    )
  }

  const nonUsd = evaluateSymbolCase(useArtifact(
    symbolMarketCase(),
    STAT_ARTIFACT_VECTORS.nonUsd,
  ))
  assert.equal(nonUsd.dataStatus, 'VALID')
  assert.equal(nonUsd.evaluatedPrice.currency, 'USD')
  assert.equal(nonUsd.evaluatedPrice.value, 95)
})

test('does not mutate private source snapshots or evidence drafts', () => {
  const input = symbolMarketCase()
  const before = structuredClone(input.privateCase)

  const result = evaluateSymbolCase(input)

  assert.equal(result.dataStatus, 'VALID')
  assert.deepEqual(input.privateCase, before)
})

test('rejects unknown and derived input aliases at the public seam', () => {
  const unknownTopLevel = { ...symbolMarketCase(), buyAction: 'OPEN' }
  assert.throws(() => evaluateSymbolCase(unknownTopLevel), /Symbol case input is invalid/)

  const unknownPrivate = symbolMarketCase()
  unknownPrivate.privateCase.thesis = {}
  assert.throws(() => evaluateSymbolCase(unknownPrivate), /Symbol case input is invalid/)

  const derivedEvidence = symbolMarketCase()
  derivedEvidence.privateCase.evidence.items = []
  assert.throws(() => evaluateSymbolCase(derivedEvidence), /Derived evidence is not accepted/)

  const nestedResearchAlias = symbolMarketCase()
  nestedResearchAlias.privateCase.researchPolicy = {
    research: nestedResearchAlias.privateCase.researchPolicy,
  }
  assert.throws(() => evaluateSymbolCase(nestedResearchAlias), /nested|canonical/)

  const legacyParsedStat = symbolMarketCase()
  legacyParsedStat.stat = JSON.parse(legacyParsedStat.statArtifact)
  delete legacyParsedStat.statArtifact
  assert.throws(() => evaluateSymbolCase(legacyParsedStat), /Symbol case input is invalid/)
})

test('rejects private ownership of the Robinhood machine source namespace', () => {
  const input = symbolMarketCase()
  input.privateCase.evidence.sourcePolicy.kinds.ROBINHOOD_EQUITY_QUOTE = 'PRIMARY'

  assert.throws(() => evaluateSymbolCase(input), /Symbol case input is invalid/)
})

test('rejects private market-session and earnings-schedule machine facts', () => {
  for (const factKey of ['MARKET_SESSION', 'EARNINGS_SCHEDULE_KNOWN', 'NEXT_EARNINGS_AT']) {
    const input = symbolMarketCase()
    const privateSource = createSnapshot('source', {
      role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
      currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
      facts: [{ factKey, value: true, asOf: AS_OF, scope: { symbol: 'AAA' } }],
    })
    input.privateCase.sourceSnapshots.push(privateSource.resolved)
    assert.throws(() => evaluateSymbolCase(input), /Symbol case input is invalid/)
  }
})

test('malformed or legacy Robinhood reads fail closed instead of falling back to Yahoo Close', () => {
  const read = robinhoodRead()
  delete read.earnings
  const result = evaluateSymbolCase(symbolMarketCase({ robinhoodRead: read }))

  assertBlocked(result)
  assert.equal(result.evaluatedPrice, null)
  assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))

  const legacy = robinhoodRead()
  legacy.schemaVersion = 2
  assertBlocked(evaluateSymbolCase(symbolMarketCase({ robinhoodRead: legacy })))
})

test('derives earnings risk, RTH, and freshness only from Robinhood machine evidence', () => {
  const withUpcoming = date => robinhoodRead({
    earnings: robinhoodEarningsData({ results: [
      robinhoodEarningsResult(),
      robinhoodEarningsResult({
        quarter: 3,
        actual: null,
        date,
        timing: 'am',
        verified: false,
      }),
    ] }),
  })
  assert.equal(evaluateSymbolCase(symbolMarketCase({
    robinhoodRead: withUpcoming('2026-08-17'),
  })).buyAction, 'PILOT')
  assert.equal(evaluateSymbolCase(symbolMarketCase({
    robinhoodRead: withUpcoming('2026-08-18'),
  })).buyAction, 'OPEN')

  const extendedQuote = robinhoodQuoteResult('AAA')
  extendedQuote.quote.last_non_reg_trade_price = '96'
  extendedQuote.quote.venue_last_non_reg_trade_time = '2026-08-10T20:01:00.000Z'
  const extended = robinhoodRead({
    quoteBatches: [{ requestedSymbols: ['AAA'], results: [extendedQuote] }],
  })
  assertBlocked(evaluateSymbolCase(symbolMarketCase({ robinhoodRead: extended })))

  for (const asOf of ['2026-08-10T19:40:00.000Z', '2026-08-10T20:01:00.001Z']) {
    const quote = robinhoodQuoteResult('AAA', '95', asOf)
    const read = robinhoodRead({
      quoteBatches: [{ requestedSymbols: ['AAA'], results: [quote] }],
    })
    assertBlocked(evaluateSymbolCase(symbolMarketCase({ robinhoodRead: read })))
  }

  assertBlocked(evaluateSymbolCase(symbolMarketCase({
    evaluatedAt: '2026-08-10T20:02:00.000Z',
  })))
})

test('future actual Robinhood earnings fail closed through the public workbench seam', () => {
  const input = symbolMarketCase({
    robinhoodRead: robinhoodRead({
      earnings: robinhoodEarningsData({ results: [
        robinhoodEarningsResult({ actual: 1.2, date: '2026-08-11' }),
      ] }),
    }),
  })
  assertBlocked(evaluateSymbolCase(input))
})
