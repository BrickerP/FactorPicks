import { createHash } from 'node:crypto'
import { createSnapshot } from '../../src/domain/contentAddressing.js'
import { derivePortfolioCapacitySnapshot } from '../../src/domain/portfolioCapacity.js'
import { deriveEvidenceBundle } from '../../src/domain/evidence.js'
import { deriveStructuredUnderwriting } from '../../src/domain/structuredUnderwriting.js'
import { capacityInput } from './portfolio-capacity-fixture.js'
import { evidenceInput, underwritingInput } from './underwriting-fixture.js'

export const NOW = '2026-08-09T08:00:00.000Z'
export const SNAPSHOT_AS_OF = '2026-08-09T07:55:00.000Z'

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export function opaqueRef(type, label) {
  return `${type}:${createHash('sha256').update(label).digest('hex')}`
}

export function evidence(label, overrides = {}) {
  const id = opaqueRef('evidence', label)
  return {
    id,
    claim: `Claim supported by ${label}`,
    source: { kind: 'filing', reference: `https://example.test/evidence/${id}` },
    observedAt: SNAPSHOT_AS_OF,
    asOf: SNAPSHOT_AS_OF,
    scope: { symbol: 'AAA' },
    stance: 'SUPPORTS',
    sourceQuality: 'PRIMARY',
    derivation: 'OBSERVED',
    confidence: 0.9,
    ...overrides,
  }
}

function evidenceProjection(item) {
  const scope = { symbol: item.scope.symbol }
  if (item.scope.universe) scope.universe = item.scope.universe
  return {
    id: item.id,
    claim: item.claim,
    source: { kind: item.source.kind, reference: item.source.reference },
    observedAt: item.observedAt,
    asOf: item.asOf,
    scope,
    stance: item.stance,
    sourceQuality: item.sourceQuality,
    derivation: item.derivation,
    confidence: item.confidence,
  }
}

const DEFAULT_EVIDENCE = [evidence('thesis'), evidence('valuation'), evidence('timing')]
export const EVIDENCE_DIGEST = digest(
  DEFAULT_EVIDENCE.map(evidenceProjection).sort((left, right) => left.id.localeCompare(right.id)),
)

export function valuationRange(overrides = {}) {
  return {
    low: 90,
    base: 120,
    high: 150,
    currency: 'USD',
    asOf: SNAPSHOT_AS_OF,
    method: 'discounted-cash-flow',
    evidenceIds: [opaqueRef('evidence', 'valuation')],
    uncertainty: 'Scenario range',
    ...overrides,
  }
}

export function entryRange(overrides = {}) {
  return {
    lower: 80,
    upper: 100,
    currency: 'USD',
    asOf: SNAPSHOT_AS_OF,
    marginOfSafety: 0.2,
    derivedFrom: valuationRange(),
    evidenceIds: [opaqueRef('evidence', 'valuation')],
    ...overrides,
  }
}

export function invalidationRule(overrides = {}) {
  return {
    id: opaqueRef('rule', 'operating-margin'),
    condition: 'Operating margin remains above 10%',
    evidenceIds: [opaqueRef('evidence', 'thesis')],
    predicate: {
      kind: 'METRIC',
      metric: 'operatingMargin',
      operator: 'LT',
      threshold: 0.1,
      lookback: 'P2Q',
      consecutive: 2,
      source: 'filing',
    },
    manualStatus: 'NOT_REQUIRED',
    severity: 'REVIEW',
    state: 'UNTRIGGERED',
    derivedFromAsOf: SNAPSHOT_AS_OF,
    observedAt: SNAPSHOT_AS_OF,
    response: 'Review the underwriting case',
    ...overrides,
  }
}

function snapshot(label) {
  const payload = { asOf: SNAPSHOT_AS_OF, kind: label, symbol: 'AAA' }
  return {
    ref: {
      id: opaqueRef('snapshot', label),
      version: opaqueRef('version', `${label}-v1`),
      digest: digest(payload),
    },
    resolved: {
      id: opaqueRef('snapshot', label),
      version: opaqueRef('version', `${label}-v1`),
      payload,
    },
  }
}

export function decisionInput(overrides = {}) {
  const snapshotEntries = Object.fromEntries([
    'market',
    'quality',
    'research',
    'underwriting',
  ].map(label => [label, snapshot(label)]))
  const decisionPolicyValues = {
    targetPosition: overrides.decisionPolicy?.targetPosition ?? 0.05,
    pilotPositionLimit: overrides.decisionPolicy?.pilotPositionLimit ?? 0.01,
    permitPilotOnEventRisk: overrides.decisionPolicy?.permitPilotOnEventRisk ?? true,
    maxInputAgeMs: overrides.decisionPolicy?.maxInputAgeMs ?? 3_600_000,
    maxFutureSkewMs: overrides.decisionPolicy?.maxFutureSkewMs ?? 60_000,
  }
  const decisionPolicySnapshot = createSnapshot('decision-policy', {
    role: 'DECISION_POLICY', kind: 'DECISION_POLICY', schemaVersion: 1,
    symbol: 'AAA', currency: 'USD', asOf: NOW, policy: decisionPolicyValues,
  })
  const weightSupplied = Object.hasOwn(
    overrides.portfolioCapacity?.currentPosition ?? {},
    'weight',
  )
  const requestedWeight = overrides.portfolioCapacity?.currentPosition?.weight
  const derivableWeight = Number.isFinite(requestedWeight) ? requestedWeight : 0
  const requestedLiquidity = overrides.portfolioCapacity?.remainingCapacity?.liquidity
  const liquidityRemaining = Number.isFinite(requestedLiquidity)
    ? requestedLiquidity
    : 0.03
  const derivedCapacity = derivePortfolioCapacitySnapshot(capacityInput({
    portfolio: {
      positions: derivableWeight > 0
        ? [{
            symbol: 'AAA',
            quantity: derivableWeight * 100_000,
            markPrice: 1,
            asOf: SNAPSHOT_AS_OF,
            currency: 'USD',
            assetType: 'EQUITY',
            side: 'LONG',
            sector: 'Technology',
            industry: 'Software',
          }]
        : [],
      targetClassification: {
        sector: 'Technology',
        industry: 'Software',
      },
    },
    liquidity: { maxPositionWeight: derivableWeight + liquidityRemaining },
  }))
  if (weightSupplied && !Number.isFinite(requestedWeight)) {
    derivedCapacity.portfolioCapacity.currentPosition.weight = requestedWeight
  }
  const requestedRule = overrides.underwriting?.invalidationRules?.[0]
  const requestedPredicate = requestedRule?.predicate
  const validMetricRule = requestedRule?.state === 'TRIGGERED' &&
    requestedPredicate?.kind === 'METRIC' && typeof requestedPredicate.metric === 'string' &&
    ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'].includes(requestedPredicate.operator) &&
    Number.isFinite(requestedPredicate.threshold) && typeof requestedPredicate.lookback === 'string' &&
    Number.isInteger(requestedPredicate.consecutive) && requestedPredicate.consecutive > 0 &&
    typeof requestedPredicate.source === 'string' && requestedPredicate.source.length > 0 &&
    requestedRule.manualStatus === 'NOT_REQUIRED'
  const validManualRule = requestedPredicate?.kind === 'MANUAL' &&
    requestedRule?.state === ({ PENDING: 'UNKNOWN', CONFIRMED: 'TRIGGERED', REJECTED: 'UNTRIGGERED' })[requestedRule?.manualStatus] &&
    ['metric', 'operator', 'threshold', 'lookback', 'consecutive', 'source']
      .every(key => requestedPredicate[key] === null)
  const deriveRequestedRule = validMetricRule || validManualRule
  const evidenceSeed = evidenceInput()
  if (overrides.underwriting?.longTermGate === 'FAIL') {
    evidenceSeed.drafts[0].stance = 'CHALLENGES'
  }
  const evidenceDerived = deriveEvidenceBundle(evidenceSeed)
  const underwritingSeed = underwritingInput({
    evidence: evidenceDerived.evidence,
    resolvedSnapshots: evidenceSeed.resolvedSnapshots.concat(evidenceDerived.resolvedSnapshots),
    invalidationDrafts: deriveRequestedRule ? [{
      key: 'margin-rule', condition: requestedRule.condition ?? 'Operating margin rule',
      severity: requestedRule.severity ?? 'REVIEW', response: requestedRule.response ?? 'Review',
      ...(validManualRule ? { manualStatus: requestedRule.manualStatus,
        predicate: { kind: 'MANUAL' } } : { predicate: { kind: 'METRIC',
        factKey: 'OPERATING_MARGIN', operator: requestedRule.state === 'TRIGGERED' ? 'GT' : 'LT',
        threshold: 0.1, lookback: 'P1Q', consecutive: 1,
        source: 'SEC_FILING', unit: 'ratio' } }),
    }] : undefined,
  })
  const underwritingDerived = deriveStructuredUnderwriting(underwritingSeed)
  const input = {
    research: {
      symbol: 'AAA',
      dataStatus: 'VALID',
      blockerCodes: [],
      marketSnapshot: snapshotEntries.market.ref,
      qualitySnapshot: snapshotEntries.quality.ref,
      researchSnapshot: snapshotEntries.research.ref,
    },
    evaluatedPrice: {
      value: 95,
      currency: 'USD',
      asOf: SNAPSHOT_AS_OF,
      source: opaqueRef('source', 'consolidated-quote'),
    },
    evidence: evidenceDerived.evidence,
    underwriting: underwritingDerived.underwriting,
    timingAssessment: {
      status: 'PASS',
      asOf: SNAPSHOT_AS_OF,
      evidenceIds: [evidenceDerived.evidence.items[0].id],
      reasonCodes: [],
    },
    portfolioCapacity: derivedCapacity.portfolioCapacity,
    decisionPolicy: {
      ...decisionPolicyValues,
      ref: decisionPolicySnapshot.ref,
    },
    resolvedSnapshots: Object.values(snapshotEntries)
      .map(entry => entry.resolved)
      .concat(decisionPolicySnapshot.resolved)
      .concat(derivedCapacity.resolvedSnapshots)
      .concat(evidenceSeed.resolvedSnapshots)
      .concat(evidenceDerived.resolvedSnapshots)
      .concat(underwritingDerived.resolvedSnapshots),
    now: NOW,
  }

  const merged = {
    ...input,
    ...overrides,
    research: { ...input.research, ...overrides.research },
    underwriting: { ...input.underwriting, ...overrides.underwriting,
      ...(overrides.underwriting?.longTermGate === 'FAIL'
        ? { longTermGate: input.underwriting.longTermGate }
        : {}),
      ...(deriveRequestedRule ? { invalidationRules: input.underwriting.invalidationRules } : {}) },
    timingAssessment: { ...input.timingAssessment, ...overrides.timingAssessment },
    portfolioCapacity: input.portfolioCapacity,
    decisionPolicy: { ...input.decisionPolicy, ...overrides.decisionPolicy },
  }
  return merged
}
