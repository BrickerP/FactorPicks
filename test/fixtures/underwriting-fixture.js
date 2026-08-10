import { createSnapshot } from '../../src/domain/contentAddressing.js'
import { deriveEvidenceBundle } from '../../src/domain/evidence.js'
import { deriveStructuredUnderwriting } from '../../src/domain/structuredUnderwriting.js'

export const NOW = '2026-08-09T08:00:00.000Z'
export const AS_OF = '2026-08-09T07:55:00.000Z'

export function sourceSnapshot(overrides = {}) {
  const payload = {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [
      { factKey: 'REVENUE', value: 100, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'OPERATING_MARGIN', value: 0.2, asOf: AS_OF, scope: { symbol: 'AAA' }, unit: 'ratio' },
    ],
    ...overrides,
  }
  return createSnapshot('source', payload)
}

export function evidenceInput(overrides = {}) {
  const source = sourceSnapshot(overrides.source)
  const input = {
    symbol: 'AAA', evaluatedAt: NOW,
    freshnessPolicy: { maxAgeMs: 3_600_000, maxFutureSkewMs: 60_000 },
    sourcePolicy: { schemaVersion: 1, kinds: { SEC_FILING: 'PRIMARY', YAHOO_TARGET: 'SECONDARY' } },
    gatePolicy: { schemaVersion: 1, gates: [
      { gateId: 'durable-business', claimKey: 'THESIS', materiality: 'MATERIAL', required: true },
    ] },
    resolvedSnapshots: [source.resolved],
    drafts: [
      { key: 'revenue', claimKey: 'THESIS', factKey: 'REVENUE', value: 100,
        sourceRef: source.ref.id, asOf: AS_OF,
        scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 0.9 },
      { key: 'margin', claimKey: 'MARGIN', factKey: 'OPERATING_MARGIN', value: 0.2,
        sourceRef: source.ref.id, asOf: AS_OF,
        scope: { symbol: 'AAA' }, unit: 'ratio', stance: 'SUPPORTS', confidence: 0.9 },
      { key: 'dcf', claimKey: 'VALUATION', factKey: 'DCF_VALUE', value: 120,
        inputKeys: ['revenue'], asOf: AS_OF,
        scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 0.75 },
    ],
  }
  return { ...input, ...overrides,
    freshnessPolicy: { ...input.freshnessPolicy, ...overrides.freshnessPolicy },
    sourcePolicy: { ...input.sourcePolicy, ...overrides.sourcePolicy },
    gatePolicy: { ...input.gatePolicy, ...overrides.gatePolicy },
    drafts: overrides.drafts ?? input.drafts,
    resolvedSnapshots: overrides.resolvedSnapshots ?? input.resolvedSnapshots }
}

export function underwritingInput(overrides = {}) {
  const evidenceSeed = evidenceInput(overrides.evidenceInput)
  const evidenceDerived = deriveEvidenceBundle(evidenceSeed)
  const input = {
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceDerived.evidence,
    resolvedSnapshots: evidenceSeed.resolvedSnapshots.concat(evidenceDerived.resolvedSnapshots),
    valuationDraft: { symbol: 'AAA', low: 90.05, base: 120.05, high: 150,
      currency: 'USD', asOf: AS_OF, method: 'DCF', inputEvidenceKeys: ['VALUATION'],
      uncertainty: 'Scenario range' },
    policy: { schemaVersion: 1, marginOfSafety: 0.2 },
    invalidationDrafts: [
      { key: 'margin-rule', condition: 'Operating margin below 10%', severity: 'REVIEW',
        response: 'Review underwriting', predicate: { kind: 'METRIC',
          factKey: 'OPERATING_MARGIN', operator: 'LT', threshold: 0.1,
          lookback: 'P1Q', consecutive: 1, source: 'SEC_FILING', unit: 'ratio' } },
    ],
  }
  return { ...input, ...overrides,
    valuationDraft: { ...input.valuationDraft, ...overrides.valuationDraft },
    policy: { ...input.policy, ...overrides.policy },
    invalidationDrafts: overrides.invalidationDrafts ?? input.invalidationDrafts }
}

export function derivedUnderwriting(overrides = {}) {
  return deriveStructuredUnderwriting(underwritingInput(overrides))
}
