import { createHash } from 'node:crypto'

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
    'portfolio',
    'capacity-policy',
    'decision-policy',
  ].map(label => [label, snapshot(label)]))
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
    evidence: {
      digest: EVIDENCE_DIGEST,
      items: structuredClone(DEFAULT_EVIDENCE),
    },
    underwriting: {
      snapshotRef: snapshotEntries.underwriting.ref,
      longTermGate: 'PASS',
      evidenceIds: [opaqueRef('evidence', 'thesis')],
      valuationRange: valuationRange(),
      entryRange: entryRange(),
      invalidationRules: [invalidationRule()],
    },
    timingAssessment: {
      status: 'PASS',
      asOf: SNAPSHOT_AS_OF,
      evidenceIds: [opaqueRef('evidence', 'timing')],
      reasonCodes: [],
    },
    portfolioCapacity: {
      asOf: SNAPSHOT_AS_OF,
      denominator: {
        kind: 'NET_LIQUIDATION_VALUE',
        asOf: SNAPSHOT_AS_OF,
        sourceRef: opaqueRef('source', 'robinhood-readonly'),
        snapshotRef: opaqueRef('snapshot', 'portfolio-private'),
        digest: digest({ denominator: 'portfolio' }),
      },
      currentPosition: {
        weight: 0,
        positionRef: opaqueRef('position', 'AAA'),
      },
      hardLimits: {
        userHardLimit: 0.1,
        systemRiskLimit: 0.08,
        sectorHardLimit: 0.09,
        industryHardLimit: 0.07,
        portfolioHardLimit: 0.12,
        liquidityHardLimit: 0.06,
      },
      remainingCapacity: {
        sector: 0.05,
        industry: 0.04,
        portfolio: 0.09,
        liquidity: 0.03,
      },
      portfolioSnapshotRef: snapshotEntries.portfolio.ref,
      capacityPolicyRef: snapshotEntries['capacity-policy'].ref,
      digests: {
        capacity: digest({ capacity: 'AAA' }),
        portfolio: digest({ portfolio: 'AAA' }),
        capacityPolicy: digest({ policy: 'capacity' }),
      },
    },
    decisionPolicy: {
      targetPosition: 0.05,
      pilotPositionLimit: 0.01,
      permitPilotOnEventRisk: true,
      maxInputAgeMs: 3_600_000,
      maxFutureSkewMs: 60_000,
      ref: snapshotEntries['decision-policy'].ref,
    },
    resolvedSnapshots: Object.values(snapshotEntries).map(entry => entry.resolved),
    now: NOW,
  }

  return {
    ...input,
    ...overrides,
    research: { ...input.research, ...overrides.research },
    underwriting: { ...input.underwriting, ...overrides.underwriting },
    timingAssessment: { ...input.timingAssessment, ...overrides.timingAssessment },
    portfolioCapacity: {
      ...input.portfolioCapacity,
      ...overrides.portfolioCapacity,
      currentPosition: {
        ...input.portfolioCapacity.currentPosition,
        ...overrides.portfolioCapacity?.currentPosition,
      },
      hardLimits: {
        ...input.portfolioCapacity.hardLimits,
        ...overrides.portfolioCapacity?.hardLimits,
      },
      remainingCapacity: {
        ...input.portfolioCapacity.remainingCapacity,
        ...overrides.portfolioCapacity?.remainingCapacity,
      },
    },
    decisionPolicy: { ...input.decisionPolicy, ...overrides.decisionPolicy },
  }
}
