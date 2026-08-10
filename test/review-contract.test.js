import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshot, opaqueRef } from '../src/domain/contentAddressing.js'
import { deriveEvidenceBundle, projectEvidenceBundle } from '../src/domain/evidence.js'
import { deriveStructuredUnderwriting } from '../src/domain/structuredUnderwriting.js'
import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import { decisionInput } from './fixtures/decision-v2-fixture.js'
import { AS_OF, evidenceInput, underwritingInput } from './fixtures/underwriting-fixture.js'

test('semantic scope conflicts cannot be bypassed with object key order', () => {
  const source = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [
      { factKey: 'REVENUE', value: 1, asOf: AS_OF,
        scope: { symbol: 'AAA', universe: 'SP500' }, currency: 'USD' },
      { factKey: 'REVENUE', value: 2, asOf: AS_OF,
        scope: { universe: 'SP500', symbol: 'AAA' }, currency: 'USD' },
    ],
  })
  const input = evidenceInput({ resolvedSnapshots: [source.resolved], drafts: [
    { key: 'one', claimKey: 'THESIS', factKey: 'REVENUE', value: 1,
      sourceRef: source.ref.id, asOf: AS_OF, scope: { symbol: 'AAA', universe: 'SP500' },
      currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
    { key: 'two', claimKey: 'THESIS', factKey: 'REVENUE', value: 2,
      sourceRef: source.ref.id, asOf: AS_OF, scope: { universe: 'SP500', symbol: 'AAA' },
      currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
  ] })
  assert.throws(() => deriveEvidenceBundle(input), { code: 'INVALID_EVIDENCE_INPUT' })
})

test('underwriting and decision revalidate evidence freshness at their own current time', () => {
  assert.throws(() => deriveStructuredUnderwriting(underwritingInput({
    evaluatedAt: '2026-08-09T07:54:00.000Z',
  })), { code: 'INVALID_STRUCTURED_UNDERWRITING_INPUT' })

  const input = decisionInput({
    now: '2026-08-09T10:00:00.000Z',
    decisionPolicy: { maxInputAgeMs: 86_400_000 },
  })
  const result = evaluateDecision(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(result.blockerCodes.includes('STALE_EVIDENCE_BUNDLE'))
})

test('downstream freshness rejects stale facts even while the bundle remains fresh', () => {
  const source = createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA', currency: 'USD',
    asOf: '2026-08-09T07:20:00.000Z', observedAt: '2026-08-09T07:20:00.000Z',
    facts: [{ factKey: 'REVENUE', value: 100, asOf: '2026-08-09T07:20:00.000Z',
      scope: { symbol: 'AAA' }, currency: 'USD' }],
  })
  const built = deriveEvidenceBundle(evidenceInput({
    evaluatedAt: '2026-08-09T08:00:00.000Z', resolvedSnapshots: [source.resolved],
    drafts: [{ key: 'revenue', claimKey: 'THESIS', factKey: 'REVENUE', value: 100,
      sourceRef: source.ref.id, asOf: '2026-08-09T07:20:00.000Z',
      scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 1 }],
  }))
  const resolved = [source.resolved, ...built.resolvedSnapshots]
  assert.equal(projectEvidenceBundle(built.evidence, 'AAA', resolved, {
    evaluatedAt: '2026-08-09T08:50:00.000Z', maxInputAgeMs: 7_200_000,
    maxFutureSkewMs: 60_000,
  }), null)
})

test('evidence timestamps are derived and cannot be asserted by a draft', () => {
  const observed = evidenceInput()
  observed.drafts[0].observedAt = '2026-08-09T07:56:00.000Z'
  assert.throws(() => deriveEvidenceBundle(observed), { code: 'INVALID_EVIDENCE_INPUT' })

  const input = evidenceInput()
  const result = deriveEvidenceBundle(input)
  const inferred = result.evidence.items.find(item => item.derivation === 'INFERRED')
  const parent = result.evidence.items.find(item => item.id === inferred.inputIds[0])
  assert.equal(inferred.observedAt, parent.observedAt)
})

test('timing evidence references must be opaque, unique, and resolved in projected evidence', () => {
  for (const evidenceIds of [
    ['evidence:not-opaque'],
    [opaqueRef('evidence', 'missing')],
    (() => { const input = decisionInput(); const id = input.timingAssessment.evidenceIds[0]; return [id, id] })(),
  ]) {
    const result = evaluateDecision(decisionInput({ timingAssessment: { evidenceIds } }))
    assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
    assert.ok(result.blockerCodes.includes('INVALID_TIMING_EVIDENCE'))
  }
})

test('invalid timing never copies raw private timing fields into a blocked record', () => {
  const input = decisionInput()
  input.timingAssessment = {
    status: 'private-status-secret', asOf: 'private-asof-secret',
    evidenceIds: ['private-evidence-secret'], reasonCodes: ['private-reason-secret'],
  }
  const result = evaluateDecision(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.timingAssessment, null)
  assert.doesNotMatch(JSON.stringify(result), /private-(status|asof|evidence|reason)-secret/)
})

test('metric state is UNKNOWN when observation and threshold types differ', () => {
  for (const threshold of ['0.1', null]) {
    const input = underwritingInput()
    input.invalidationDrafts[0].predicate.operator = 'EQ'
    input.invalidationDrafts[0].predicate.threshold = threshold
    const result = deriveStructuredUnderwriting(input)
    assert.equal(result.underwriting.invalidationRules[0].state, 'UNKNOWN')
  }
})

test('projector failure emits only safe null projections', () => {
  const input = decisionInput()
  input.evidence.items[0].claimKey = 'private-claim-secret'
  input.underwriting.invalidationRules[0].condition = 'private-condition-secret'
  input.underwriting.invalidationRules[0].response = 'private-response-secret'
  input.evaluatedPrice.source = 'private-price-secret'
  const result = evaluateDecision(input)
  const serialized = JSON.stringify(result)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.evaluatedPrice, null)
  assert.equal(result.underwriting, null)
  assert.deepEqual(result.evidence, { digest: null, refs: [] })
  assert.doesNotMatch(serialized, /private-(claim|condition|response|price)-secret/)
})

test('USD range derivation uses exact decimal half-up cents', () => {
  const result = deriveStructuredUnderwriting(underwritingInput({
    valuationDraft: { low: 10.075, base: 10000.005, high: 12000 },
    policy: { marginOfSafety: 0 },
  }))
  assert.equal(result.underwriting.entryRange.lower, 10.08)
  assert.equal(result.underwriting.entryRange.upper, 10000.01)
})

test('resolved decision policy is authoritative over the outer artifact', () => {
  const input = decisionInput()
  input.decisionPolicy.targetPosition = 0.09
  const result = evaluateDecision(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(result.blockerCodes.includes('INVALID_DECISION_POLICY'))

  const payloadTamper = decisionInput()
  payloadTamper.resolvedSnapshots.find(item => item.payload?.role === 'DECISION_POLICY')
    .payload.policy.targetPosition = 0.09
  const payloadResult = evaluateDecision(payloadTamper)
  assert.equal(payloadResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(payloadResult.blockerCodes.includes('INVALID_DECISION_POLICY'))
})
