import { createSnapshot, digest, opaqueRef } from '../../src/domain/contentAddressing.js'
import { derivePortfolioCapacitySnapshot } from '../../src/domain/portfolioCapacity.js'
import { deriveEvidenceBundle } from '../../src/domain/evidence.js'
import { deriveStructuredUnderwriting } from '../../src/domain/structuredUnderwriting.js'
import { deriveTimingAssessment } from '../../src/domain/timingAssessment.js'
import { capacityInput } from './portfolio-capacity-fixture.js'
import { evidenceInput, sourceSnapshot, underwritingInput } from './underwriting-fixture.js'

export const NOW = '2026-08-10T20:00:00.000Z'
export const SNAPSHOT_AS_OF = '2026-08-10T19:55:00.000Z'

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

export { digest, opaqueRef }

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
    evaluatedAt: NOW,
    portfolio: {
      asOf: SNAPSHOT_AS_OF,
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
    liquidity: {
      maxPositionWeight: derivableWeight + liquidityRemaining,
      asOf: SNAPSHOT_AS_OF,
    },
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
  const requestedTimingStatus = overrides.timingAssessment?.status ?? 'PASS'
  const requestedPrice = Number.isFinite(overrides.evaluatedPrice?.value)
    ? overrides.evaluatedPrice.value
    : 95
  const source = sourceSnapshot({
    asOf: SNAPSHOT_AS_OF,
    observedAt: SNAPSHOT_AS_OF,
    facts: [
      { factKey: 'REVENUE', value: 100, asOf: SNAPSHOT_AS_OF,
        scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'OPERATING_MARGIN', value: 0.2, asOf: SNAPSHOT_AS_OF,
        scope: { symbol: 'AAA' }, unit: 'ratio' },
    ],
  })
  const quoteSource = createSnapshot('source', {
    role: 'SOURCE', kind: 'ROBINHOOD_EQUITY_QUOTE', schemaVersion: 1,
    symbol: 'AAA', currency: 'USD', asOf: SNAPSHOT_AS_OF, observedAt: NOW,
    facts: [
      { factKey: 'CURRENT_PRICE', value: requestedPrice, asOf: SNAPSHOT_AS_OF,
        scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'MARKET_SESSION', value: 'REGULAR', asOf: SNAPSHOT_AS_OF,
        scope: { symbol: 'AAA' } },
    ],
  })
  const nextEarnings = requestedTimingStatus === 'EVENT_RISK'
    ? { date: '2026-08-10', timing: 'pm', verified: false }
    : null
  const earningsSource = createSnapshot('source', {
    role: 'SOURCE', kind: 'ROBINHOOD_EARNINGS_CALENDAR', schemaVersion: 1,
    symbol: 'AAA', currency: 'USD', asOf: NOW, observedAt: NOW,
    facts: [
      { factKey: 'EARNINGS_SCHEDULE_KNOWN', value: true, asOf: NOW,
        scope: { symbol: 'AAA' } },
      ...(nextEarnings
        ? [{ factKey: 'NEXT_EARNINGS_AT', value: nextEarnings, asOf: NOW,
            scope: { symbol: 'AAA' } }]
        : []),
    ],
  })
  const evidenceSeed = evidenceInput({
    evaluatedAt: NOW,
    resolvedSnapshots: [source.resolved, quoteSource.resolved, earningsSource.resolved],
    sourcePolicy: { schemaVersion: 1, kinds: {
      SEC_FILING: 'PRIMARY',
      ROBINHOOD_EQUITY_QUOTE: 'PRIMARY',
      ROBINHOOD_EARNINGS_CALENDAR: 'PRIMARY',
    } },
  })
  evidenceSeed.drafts = evidenceSeed.drafts.map(draft => draft.sourceRef
    ? { ...draft, sourceRef: source.ref.id, asOf: SNAPSHOT_AS_OF }
    : { ...draft, asOf: SNAPSHOT_AS_OF })
  evidenceSeed.drafts.push({ key: 'price', claimKey: 'MARKET_PRICE', factKey: 'CURRENT_PRICE',
    value: requestedPrice, sourceRef: quoteSource.ref.id, asOf: SNAPSHOT_AS_OF,
    scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 1 })
  evidenceSeed.drafts.push({ key: 'market-session', claimKey: 'MARKET_SESSION',
    factKey: 'MARKET_SESSION', value: 'REGULAR', sourceRef: quoteSource.ref.id,
    asOf: SNAPSHOT_AS_OF, scope: { symbol: 'AAA' },
    stance: requestedTimingStatus === 'FAIL' ? 'CHALLENGES' : 'SUPPORTS', confidence: 1 })
  evidenceSeed.drafts.push({ key: 'earnings-schedule-known', claimKey: 'EARNINGS_SCHEDULE',
    factKey: 'EARNINGS_SCHEDULE_KNOWN', value: true, sourceRef: earningsSource.ref.id,
    asOf: NOW, scope: { symbol: 'AAA' }, stance: 'SUPPORTS', confidence: 1 })
  if (requestedTimingStatus === 'EVENT_RISK') {
    evidenceSeed.drafts.push({ key: 'next-earnings-at', claimKey: 'EARNINGS_SCHEDULE',
      factKey: 'NEXT_EARNINGS_AT', value: nextEarnings, sourceRef: earningsSource.ref.id,
      asOf: NOW, scope: { symbol: 'AAA' }, stance: 'SUPPORTS', confidence: 1 })
  }
  if (overrides.underwriting?.longTermGate === 'FAIL') {
    evidenceSeed.drafts[0].stance = 'CHALLENGES'
  }
  const evidenceDerived = deriveEvidenceBundle(evidenceSeed)
  const underwritingSeed = underwritingInput({
    evaluatedAt: NOW,
    evidence: evidenceDerived.evidence,
    resolvedSnapshots: evidenceSeed.resolvedSnapshots.concat(evidenceDerived.resolvedSnapshots),
    valuationDraft: { asOf: SNAPSHOT_AS_OF },
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
  const timingDerived = deriveTimingAssessment({
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceDerived.evidence,
    resolvedSnapshots: evidenceSeed.resolvedSnapshots
      .concat(evidenceDerived.resolvedSnapshots)
      .concat(underwritingDerived.resolvedSnapshots),
    policy: {
      schemaVersion: 2,
      maxQuoteAgeMs: 3_600_000,
      maxFutureSkewMs: 60_000,
      earningsRiskWindowDays: 7,
    },
  })
  const input = {
    research: {
      symbol: 'AAA',
      dataStatus: 'VALID',
      blockerCodes: [],
      marketSnapshot: snapshotEntries.market.ref,
      qualitySnapshot: snapshotEntries.quality.ref,
      researchSnapshot: snapshotEntries.research.ref,
    },
    evaluatedPrice: timingDerived.evaluatedPrice,
    evidence: evidenceDerived.evidence,
    underwriting: underwritingDerived.underwriting,
    timingAssessment: timingDerived.timingAssessment,
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
      .concat(underwritingDerived.resolvedSnapshots)
      .concat(timingDerived.resolvedSnapshots),
    now: NOW,
  }

  const timingOverride = overrides.timingAssessment ?? {}
  const evaluatedPriceOverride = overrides.evaluatedPrice ?? {}
  const trustedQuoteSource = evaluatedPriceOverride.source === opaqueRef('source', 'consolidated-quote')
    ? input.evaluatedPrice.source
    : evaluatedPriceOverride.source
  const merged = {
    ...input,
    ...overrides,
    research: { ...input.research, ...overrides.research },
    underwriting: { ...input.underwriting, ...overrides.underwriting,
      ...(overrides.underwriting?.longTermGate === 'FAIL'
        ? { longTermGate: input.underwriting.longTermGate }
        : {}),
      ...(deriveRequestedRule ? { invalidationRules: input.underwriting.invalidationRules } : {}) },
    timingAssessment: { ...input.timingAssessment, ...timingOverride },
    evaluatedPrice: { ...input.evaluatedPrice, ...overrides.evaluatedPrice,
      ...(trustedQuoteSource ? { source: trustedQuoteSource } : {}) },
    portfolioCapacity: input.portfolioCapacity,
    decisionPolicy: { ...input.decisionPolicy, ...overrides.decisionPolicy },
  }
  return merged
}
