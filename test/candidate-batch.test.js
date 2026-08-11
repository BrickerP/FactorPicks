import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createSnapshot } from '../src/domain/contentAddressing.js'
import { evaluateCandidateBatch } from '../src/domain/evaluateCandidateBatch.js'
import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'
import {
  NOW,
  STAT_ARTIFACT,
  symbolMarketCase,
} from './fixtures/symbol-market-case-fixture.js'
import { robinhoodRead } from './fixtures/robinhood-read-fixture.js'

function artifactFixture() {
  const rows = JSON.parse(STAT_ARTIFACT)
  rows.CCC = { ...rows.BBB, name: 'CCC', ROE: 0.15 }
  const raw = JSON.stringify(rows)
  const manifest = structuredClone(symbolMarketCase().qualityManifest)
  manifest.requested = 3
  manifest.succeeded = 3
  manifest.failed = 0
  manifest.successRate = 1
  manifest.failedSymbols = []
  manifest.coverage = Object.fromEntries(Object.entries(manifest.coverage)
    .map(([field]) => [field, { available: 3, total: 3, rate: 1 }]))
  manifest.statArtifact = {
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(raw, 'utf8'),
    symbols: 3,
  }
  return { raw, manifest }
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

function batchInput(symbols = ['AAA']) {
  const artifact = artifactFixture()
  const targetSymbols = symbols.map(symbol => symbol.trim().toUpperCase()).sort()
  return {
    schemaVersion: 1,
    evaluatedAt: NOW,
    statArtifact: artifact.raw,
    qualityManifest: artifact.manifest,
    robinhoodRead: robinhoodRead({ targetSymbols }),
    candidates: symbols.map(symbol => ({
      symbol,
      privateCase: privateCaseFor(symbol.trim().toUpperCase()),
    })),
  }
}

function independentlyEvaluate(input, candidate) {
  return evaluateSymbolCase({
    symbol: candidate.symbol,
    evaluatedAt: input.evaluatedAt,
    statArtifact: input.statArtifact,
    qualityManifest: input.qualityManifest,
    robinhoodRead: input.robinhoodRead,
    privateCase: candidate.privateCase,
  })
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

test('evaluates a one-candidate batch as the existing DecisionRecordV2 seam', () => {
  const input = batchInput(['AAA'])
  const expected = independentlyEvaluate(input, input.candidates[0])

  const result = evaluateCandidateBatch(input)

  assert.deepEqual(result, [expected])
  assert.equal(result[0].schemaVersion, 2)
  assert.equal(result[0].symbol, 'AAA')
})

test('canonicalizes, sorts, and produces byte-identical results independent of input order', () => {
  const first = batchInput(['CCC', ' aaa ', 'BBB'])
  const second = {
    ...first,
    candidates: [first.candidates[1], first.candidates[2], first.candidates[0]],
  }

  const firstResult = evaluateCandidateBatch(first)
  const secondResult = evaluateCandidateBatch(second)

  assert.deepEqual(firstResult.map(record => record.symbol), ['AAA', 'BBB', 'CCC'])
  assert.equal(JSON.stringify(firstResult), JSON.stringify(secondResult))
  assert.deepEqual(firstResult, first.candidates
    .map(candidate => ({ ...candidate, symbol: candidate.symbol.trim().toUpperCase() }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map(candidate => independentlyEvaluate(first, candidate)))
})

test('rejects canonical duplicates before inspecting the Robinhood bundle', () => {
  const input = batchInput(['AAA'])
  input.candidates = [
    { symbol: 'aaa', privateCase: privateCaseFor('AAA') },
    { symbol: ' AAA ', privateCase: privateCaseFor('AAA') },
  ]
  input.robinhoodRead = null

  assert.throws(() => evaluateCandidateBatch(input), error =>
    error?.code === 'INVALID_CANDIDATE_BATCH_INPUT')
})

test('rejects V2 and target-set mismatches globally instead of returning blocked records', () => {
  const v2 = batchInput(['AAA', 'BBB'])
  v2.robinhoodRead = {
    schemaVersion: 2,
    targetSymbol: 'AAA',
  }
  assert.throws(() => evaluateCandidateBatch(v2), error =>
    error?.code === 'INVALID_ROBINHOOD_READ_INPUT')

  const mismatch = batchInput(['AAA', 'BBB'])
  mismatch.robinhoodRead = robinhoodRead({ targetSymbols: ['AAA'] })
  assert.throws(() => evaluateCandidateBatch(mismatch), error =>
    error?.code === 'INVALID_ROBINHOOD_READ_INPUT')
})

test('isolates a missing target-only quote to that candidate', () => {
  const input = batchInput(['AAA', 'BBB', 'CCC'])
  input.robinhoodRead.quoteBatches[0].results = input.robinhoodRead.quoteBatches[0].results
    .filter(result => result.quote.symbol !== 'CCC')

  const result = evaluateCandidateBatch(input)

  assert.deepEqual(result.slice(0, 2), input.candidates
    .filter(candidate => candidate.symbol !== 'CCC')
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map(candidate => independentlyEvaluate(input, candidate)))
  assert.equal(result[0].dataStatus, 'VALID')
  assert.equal(result[1].dataStatus, 'VALID')
  assert.equal(result[2].symbol, 'CCC')
  assert.equal(result[2].dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result[2].buyAction, 'NO_ACTION')
})

test('isolates semantically unavailable earnings to that candidate', () => {
  const input = batchInput(['AAA', 'BBB', 'CCC'])
  const earnings = input.robinhoodRead.earnings.find(item => item.symbol === 'CCC')
  earnings.data = { not_found: ['CCC'], results: [] }

  const result = evaluateCandidateBatch(input)

  assert.equal(result[0].dataStatus, 'VALID')
  assert.equal(result[1].dataStatus, 'VALID')
  assert.equal(result[2].symbol, 'CCC')
  assert.equal(result[2].dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result[2].buyAction, 'NO_ACTION')
})

test('does not mutate even deeply frozen caller input', () => {
  const input = batchInput(['CCC', 'AAA', 'BBB'])
  const before = JSON.stringify(input)
  deepFreeze(input)

  const result = evaluateCandidateBatch(input)

  assert.deepEqual(result.map(record => record.symbol), ['AAA', 'BBB', 'CCC'])
  assert.equal(JSON.stringify(input), before)
})

test('returns only a plain DecisionRecordV2 array with no batch action or envelope', () => {
  const result = evaluateCandidateBatch(batchInput(['AAA', 'BBB']))

  assert.ok(Array.isArray(result))
  assert.equal(Object.hasOwn(result, 'summary'), false)
  assert.equal(Object.hasOwn(result, 'error'), false)
  for (const record of result) {
    assert.equal(record.schemaVersion, 2)
    assert.equal(Object.hasOwn(record, 'batchAction'), false)
    assert.equal(Object.hasOwn(record, 'summary'), false)
    assert.equal(Object.hasOwn(record, 'error'), false)
  }
})

test('enforces exact batch and candidate structure while private-case errors fail the batch', () => {
  assert.throws(() => evaluateCandidateBatch({
    ...batchInput(['AAA']),
    extra: true,
  }), error => error?.code === 'INVALID_CANDIDATE_BATCH_INPUT')
  assert.throws(() => evaluateCandidateBatch({
    ...batchInput(['AAA']),
    candidates: [],
  }), error => error?.code === 'INVALID_CANDIDATE_BATCH_INPUT')
  assert.throws(() => evaluateCandidateBatch({
    ...batchInput(['AAA']),
    candidates: [{ symbol: 'AAA', privateCase: privateCaseFor('AAA'), extra: true }],
  }), error => error?.code === 'INVALID_CANDIDATE_BATCH_INPUT')

  const invalidPrivateCase = batchInput(['AAA'])
  invalidPrivateCase.candidates[0].privateCase.extra = true
  assert.throws(() => evaluateCandidateBatch(invalidPrivateCase), error =>
    error?.code === 'INVALID_SYMBOL_CASE_INPUT')
})
