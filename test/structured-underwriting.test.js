import test from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot } from '../src/domain/contentAddressing.js'
import { deriveEvidenceBundle } from '../src/domain/evidence.js'
import { deriveStructuredUnderwriting, projectStructuredUnderwriting } from '../src/domain/structuredUnderwriting.js'
import { evidenceInput, underwritingInput } from './fixtures/underwriting-fixture.js'

test('Structured underwriting derives ordered USD ranges with half-up cents and metric state', () => {
  const input = underwritingInput()
  const original = structuredClone(input)
  const result = deriveStructuredUnderwriting(input)
  assert.equal(result.underwriting.entryRange.lower, 72.04)
  assert.equal(result.underwriting.entryRange.upper, 96.04)
  assert.equal(result.underwriting.invalidationRules[0].state, 'UNTRIGGERED')
  assert.deepEqual(input, original)
  assert.ok(projectStructuredUnderwriting(result.underwriting, 'AAA', input.evidence,
    input.resolvedSnapshots.concat(result.resolvedSnapshots)))
})

test('valuation requires positive ordered USD values, a primary ancestor, and bounded MOS', () => {
  for (const overrides of [
    { valuationDraft: { low: 0 } },
    { valuationDraft: { low: 121 } },
    { valuationDraft: { currency: 'EUR' } },
    { policy: { marginOfSafety: 1 } },
    { policy: { marginOfSafety: -0.1 } },
  ]) assert.throws(() => deriveStructuredUnderwriting(underwritingInput(overrides)))
  assert.throws(() => deriveStructuredUnderwriting({ ...underwritingInput(),
    entryRange: { lower: 1, upper: 2 } }))
})

test('Yahoo-only secondary evidence cannot independently form a valuation range', () => {
  const source = createSnapshot('source', {
    role: 'SOURCE', kind: 'YAHOO_TARGET', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: '2026-08-09T07:55:00.000Z',
    observedAt: '2026-08-09T07:55:00.000Z', facts: [{
      factKey: 'YAHOO_TARGET', value: 120, asOf: '2026-08-09T07:55:00.000Z',
      scope: { symbol: 'AAA' }, currency: 'USD',
    }],
  })
  const built = deriveEvidenceBundle(evidenceInput({
    resolvedSnapshots: [source.resolved],
    sourcePolicy: { schemaVersion: 1, kinds: { YAHOO_TARGET: 'SECONDARY' } },
    drafts: [{ key: 'target', claimKey: 'THESIS', factKey: 'YAHOO_TARGET', value: 120,
      sourceRef: source.ref.id, asOf: '2026-08-09T07:55:00.000Z',
      scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 0.5 }],
  }))
  assert.throws(() => deriveStructuredUnderwriting(underwritingInput({
    evidence: built.evidence,
    resolvedSnapshots: [source.resolved, ...built.resolvedSnapshots],
    valuationDraft: { method: 'ANALYST_CONSENSUS', inputEvidenceKeys: ['THESIS'] },
  })))
})

test('manual invalidation maps status and rejects caller state', () => {
  for (const [manualStatus, state] of Object.entries({ PENDING: 'UNKNOWN', CONFIRMED: 'TRIGGERED', REJECTED: 'UNTRIGGERED' })) {
    const result = deriveStructuredUnderwriting(underwritingInput({ invalidationDrafts: [{
      key: 'manual', condition: 'Management credibility changes', severity: 'REVIEW',
      response: 'Review', manualStatus, predicate: { kind: 'MANUAL' },
    }] }))
    assert.equal(result.underwriting.invalidationRules[0].state, state)
  }
  const input = underwritingInput()
  input.invalidationDrafts[0].state = 'UNTRIGGERED'
  assert.throws(() => deriveStructuredUnderwriting(input))
})

test('metric invalidation is triggered, untriggered, or UNKNOWN when evidence is insufficient', () => {
  const triggeredInput = underwritingInput()
  triggeredInput.invalidationDrafts[0].predicate.operator = 'GT'
  assert.equal(deriveStructuredUnderwriting(triggeredInput).underwriting.invalidationRules[0].state, 'TRIGGERED')
  const insufficient = underwritingInput()
  insufficient.invalidationDrafts[0].predicate.consecutive = 2
  assert.equal(deriveStructuredUnderwriting(insufficient).underwriting.invalidationRules[0].state, 'UNKNOWN')
  const mismatch = underwritingInput()
  mismatch.invalidationDrafts[0].predicate.unit = 'percent'
  assert.equal(deriveStructuredUnderwriting(mismatch).underwriting.invalidationRules[0].state, 'UNKNOWN')
  const wrongSource = underwritingInput()
  wrongSource.invalidationDrafts[0].predicate.source = 'YAHOO_TARGET'
  assert.equal(deriveStructuredUnderwriting(wrongSource).underwriting.invalidationRules[0].state, 'UNKNOWN')

  const outsideWindow = underwritingInput({
    evaluatedAt: '2026-08-11T08:00:00.000Z',
    evidenceInput: {
      evaluatedAt: '2026-08-11T08:00:00.000Z',
      freshnessPolicy: { maxAgeMs: 259_200_000, maxFutureSkewMs: 60_000 },
    },
  })
  outsideWindow.invalidationDrafts[0].predicate.lookback = 'P1D'
  assert.equal(deriveStructuredUnderwriting(outsideWindow)
    .underwriting.invalidationRules[0].state, 'UNKNOWN')
})

test('metric consecutive windows use the latest two complete periods', () => {
  function evaluate(values, olderAsOf = '2026-08-08T07:55:00.000Z', lookback = 'P2D') {
    const currentAsOf = '2026-08-09T07:55:00.000Z'
    const source = createSnapshot('source', {
      role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
      currency: 'USD', asOf: currentAsOf, observedAt: currentAsOf, facts: [
        { factKey: 'REVENUE', value: 100, asOf: currentAsOf,
          scope: { symbol: 'AAA' }, currency: 'USD' },
        { factKey: 'OPERATING_MARGIN', value: values[0], asOf: currentAsOf,
          scope: { symbol: 'AAA' }, unit: 'ratio' },
        { factKey: 'OPERATING_MARGIN', value: values[1], asOf: olderAsOf,
          scope: { symbol: 'AAA' }, unit: 'ratio' },
      ],
    })
    const evidence = deriveEvidenceBundle(evidenceInput({
      freshnessPolicy: { maxAgeMs: 259_200_000, maxFutureSkewMs: 60_000 },
      resolvedSnapshots: [source.resolved], drafts: [
        { key: 'revenue', claimKey: 'THESIS', factKey: 'REVENUE', value: 100,
          sourceRef: source.ref.id, asOf: currentAsOf, scope: { symbol: 'AAA' },
          currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
        { key: 'margin-current', claimKey: 'MARGIN', factKey: 'OPERATING_MARGIN',
          value: values[0], sourceRef: source.ref.id, asOf: currentAsOf,
          scope: { symbol: 'AAA' }, unit: 'ratio', stance: 'SUPPORTS', confidence: 1 },
        { key: 'margin-older', claimKey: 'MARGIN', factKey: 'OPERATING_MARGIN',
          value: values[1], sourceRef: source.ref.id, asOf: olderAsOf,
          scope: { symbol: 'AAA' }, unit: 'ratio', stance: 'SUPPORTS', confidence: 1 },
        { key: 'dcf', claimKey: 'VALUATION', factKey: 'DCF_VALUE', value: 120,
          inputKeys: ['revenue'], asOf: currentAsOf, scope: { symbol: 'AAA' },
          currency: 'USD', stance: 'SUPPORTS', confidence: 0.8 },
      ],
    }))
    return deriveStructuredUnderwriting(underwritingInput({
      evidence: evidence.evidence,
      resolvedSnapshots: [source.resolved, ...evidence.resolvedSnapshots],
      invalidationDrafts: [{ key: 'margin', condition: 'Margin below 10%',
        severity: 'REVIEW', response: 'Review', predicate: { kind: 'METRIC',
          factKey: 'OPERATING_MARGIN', operator: 'LT', threshold: 0.1,
          lookback, consecutive: 2, source: 'SEC_FILING', unit: 'ratio' } }],
    })).underwriting.invalidationRules[0].state
  }

  assert.equal(evaluate([0.05, 0.08]), 'TRIGGERED')
  assert.equal(evaluate([0.05, 0.2]), 'UNTRIGGERED')
  assert.equal(evaluate([0.05, 0.08], '2026-08-07T07:55:00.000Z', 'P3D'), 'UNKNOWN')
})

test('Underwriting projector rejects synchronized artifact and payload tampering', () => {
  const input = underwritingInput()
  const built = deriveStructuredUnderwriting(input)
  const resolved = input.resolvedSnapshots.concat(built.resolvedSnapshots)
  const artifact = structuredClone(built.underwriting)
  artifact.entryRange.lower = 1
  assert.equal(projectStructuredUnderwriting(artifact, 'AAA', input.evidence, resolved), null)
  const payloads = structuredClone(resolved)
  payloads.at(-1).payload.entryRange.lower = 1
  assert.equal(projectStructuredUnderwriting(built.underwriting, 'AAA', input.evidence, payloads), null)

  const policyTamper = structuredClone(resolved)
  policyTamper.find(item => item.payload?.role === 'UNDERWRITING_POLICY')
    .payload.policy.marginOfSafety = 0.5
  assert.equal(projectStructuredUnderwriting(
    built.underwriting, 'AAA', input.evidence, policyTamper,
  ), null)
})
