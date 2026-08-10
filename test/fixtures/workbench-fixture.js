import { createSnapshot } from '../../src/domain/contentAddressing.js'

const NOW = '2026-08-10T08:00:00.000Z'
const AS_OF = NOW
const SOURCE_REF = `source:${'1'.repeat(64)}`
const POLICY_REF = `source:${'2'.repeat(64)}`
const LIQUIDITY_REF = `source:${'3'.repeat(64)}`

function qualityManifest() {
  const fields = ['Close', 'name', 'sector', 'industry', 'Market Cap', 'P/E', 'ROE', 'Debt/Eq', 'FCFF/EV']
  return {
    schemaVersion: 1, generatedAt: NOW, source: 'yfinance', requested: 2,
    succeeded: 2, failed: 0, successRate: 1,
    coverage: Object.fromEntries(fields.map(field => [field, { available: 2, total: 2, rate: 1 }])),
    failedSymbols: [],
  }
}

function research() {
  const row = {
    sector: 'Technology', industry: 'Software', Close: 95, name: 'AAA',
    'Market Cap': 100, ROE: 0.2, ROA: 0.1, 'EPS next Y_%': 0.1,
    'Sales past 5Y': 0.1, 'Debt/Eq': 0.2, 'Current Ratio': 2, 'P/E': 20,
    PEG: 1, 'FCFF/EV': 0.1,
  }
  return {
    universe: { AAA: row, BBB: { ...row, name: 'BBB', ROE: 0.1 } },
    qualityManifest: qualityManifest(),
    policy: {
      factorWeights: { returnOnEquity: 1 }, minimumResearchCoverage: 1,
      minimumCriticalFieldCoverage: 1, minimumSectorSampleSize: 1,
      minimumGlobalSampleSize: 1, manifestMaxAgeMs: 3_600_000,
      maxFutureSkewMs: 60_000, criticalFields: ['ROE'],
    },
  }
}

function sourceSnapshot() {
  return createSnapshot('source', {
    role: 'SOURCE', kind: 'SEC_FILING', schemaVersion: 1, symbol: 'AAA',
    currency: 'USD', asOf: AS_OF, observedAt: AS_OF,
    facts: [
      { factKey: 'CURRENT_PRICE', value: 95, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'REVENUE', value: 100, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'OPERATING_MARGIN', value: 0.2, asOf: AS_OF, scope: { symbol: 'AAA' }, unit: 'ratio' },
      { factKey: 'TIMING_PASS', value: true, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'EVENT_RISK', value: true, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
      { factKey: 'TIMING_FAIL', value: false, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD' },
    ],
  })
}

export function rawCase(overrides = {}) {
  const source = sourceSnapshot()
  const result = {
    schemaVersion: 1,
    symbol: 'AAA',
    evaluatedAt: NOW,
    research: research(),
    sourceSnapshots: [source.resolved],
    evidence: {
      freshnessPolicy: { maxAgeMs: 3_600_000, maxFutureSkewMs: 60_000 },
      sourcePolicy: { schemaVersion: 1, kinds: { SEC_FILING: 'PRIMARY' } },
      gatePolicy: { schemaVersion: 1, gates: [{ gateId: 'thesis', claimKey: 'THESIS', materiality: 'MATERIAL', required: true }] },
      drafts: [
        { key: 'price', claimKey: 'PRICE', factKey: 'CURRENT_PRICE', value: 95, sourceRef: source.ref.id,
          asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
        { key: 'thesis', claimKey: 'THESIS', factKey: 'REVENUE', value: 100, sourceRef: source.ref.id,
          asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
        { key: 'valuation', claimKey: 'VALUATION', factKey: 'DCF_VALUE', value: 120, inputKeys: ['thesis'],
          asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD', stance: 'SUPPORTS', confidence: 1 },
        { key: 'margin', claimKey: 'MARGIN', factKey: 'OPERATING_MARGIN', value: 0.2, sourceRef: source.ref.id,
          asOf: AS_OF, scope: { symbol: 'AAA' }, unit: 'ratio', stance: 'SUPPORTS', confidence: 1 },
        { key: 'pass', claimKey: 'TIMING_PASS', factKey: 'TIMING_PASS', value: true,
          sourceRef: source.ref.id, asOf: AS_OF, scope: { symbol: 'AAA' }, currency: 'USD',
          stance: 'SUPPORTS', confidence: 1 },
      ],
    },
    underwriting: {
      valuationDraft: { symbol: 'AAA', low: 90.05, base: 120.05, high: 150, currency: 'USD', asOf: AS_OF,
        method: 'DCF', inputEvidenceKeys: ['VALUATION'], uncertainty: 'range' },
      policy: { schemaVersion: 1, marginOfSafety: 0.2 },
      invalidationDrafts: [{ key: 'margin', condition: 'margin', severity: 'REVIEW', response: 'review',
        predicate: { kind: 'METRIC', factKey: 'OPERATING_MARGIN', operator: 'LT', threshold: 0.1,
          lookback: 'P1Q', consecutive: 1, source: 'SEC_FILING', unit: 'ratio' } }],
    },
    timing: { policy: { schemaVersion: 1, currentPriceFactKey: 'CURRENT_PRICE', passClaimKey: 'TIMING_PASS',
      failClaimKey: 'TIMING_FAIL', eventRiskClaimKey: 'EVENT_RISK', maxAgeMs: 900_000,
      maxFutureSkewMs: 60_000, eventRiskReasonCode: 'EARNINGS_SOON' } },
    portfolio: {
      portfolio: { asOf: AS_OF, sourceRef: SOURCE_REF, completeness: 'COMPLETE', accountCount: 1,
        accountType: 'CASH', currency: 'USD', netLiquidationValue: 100_000, hasOptions: false,
        hasCrypto: false, positions: [], targetClassification: { sector: 'Technology', industry: 'Software' } },
      policy: { sourceRef: POLICY_REF, effectiveFrom: '2026-08-01T00:00:00.000Z', effectiveUntil: '2026-09-01T00:00:00.000Z',
        userHardLimit: 0.1, systemRiskLimit: 0.08, sectorHardLimit: 0.2, industryHardLimit: 0.12,
        portfolioHardLimit: 0.9, minimumCashBufferWeight: 0.1 },
      liquidity: { maxPositionWeight: 0.06, asOf: AS_OF, sourceRef: LIQUIDITY_REF },
      freshnessPolicy: { maxPortfolioAgeMs: 600_000, maxLiquidityAgeMs: 600_000, maxFutureSkewMs: 60_000 },
    },
    decisionPolicy: { schemaVersion: 1, targetPosition: 0.05, pilotPositionLimit: 0.01,
      permitPilotOnEventRisk: true, maxInputAgeMs: 3_600_000, maxFutureSkewMs: 60_000 },
  }
  return { ...result, ...overrides }
}

export { NOW, AS_OF, sourceSnapshot }
