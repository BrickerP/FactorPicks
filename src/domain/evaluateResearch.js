import { FACTOR_CATALOG } from './factorCatalog.js'

const SUCCESS_RATE_TOLERANCE = 1e-6
// Canonical producer contract mirrored from
// .github/fetch_stock_data/fetch_stock_data.py.
const QUALITY_MANIFEST_SCHEMA_VERSION = 1
const QUALITY_MANIFEST_SOURCE = 'yfinance'
const QUALITY_MANIFEST_MIN_SUCCESS_RATE = 0.8
const QUALITY_MANIFEST_MIN_CRITICAL_FIELD_COVERAGE = 0.5
const QUALITY_MANIFEST_CRITICAL_FIELDS = Object.freeze([
  'Close',
  'name',
  'sector',
  'industry',
  'Market Cap',
  'P/E',
  'ROE',
  'Debt/Eq',
  'FCFF/EV',
])
const FACTOR_IDS = new Set(FACTOR_CATALOG.map(factor => factor.id))

function roundedRate(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6))
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isRate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function isPositiveRate(value) {
  return isRate(value) && value > 0
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function researchPolicyBlockers(researchPolicy) {
  if (!isObject(researchPolicy)) return [{ code: 'INVALID_RESEARCH_POLICY' }]

  const blockers = []
  let hasPositiveKnownWeight = false
  if (!isObject(researchPolicy.factorWeights)) {
    blockers.push({ code: 'INVALID_FACTOR_WEIGHTS' })
  } else {
    for (const [factorId, weight] of Object.entries(researchPolicy.factorWeights)) {
      if (!FACTOR_IDS.has(factorId)) {
        blockers.push({ code: 'UNKNOWN_FACTOR_WEIGHT', factorId })
        continue
      }
      if (!Number.isFinite(weight) || weight < 0) {
        blockers.push({ code: 'INVALID_FACTOR_WEIGHT', factorId })
        continue
      }
      if (weight > 0) hasPositiveKnownWeight = true
    }
  }
  if (!hasPositiveKnownWeight) {
    blockers.push({ code: 'MISSING_POSITIVE_FACTOR_WEIGHT' })
  }

  if (!isPositiveRate(researchPolicy.minimumResearchCoverage)) {
    blockers.push({ code: 'INVALID_MINIMUM_RESEARCH_COVERAGE' })
  }

  if (!isRate(researchPolicy.minimumCriticalFieldCoverage)) {
    blockers.push({ code: 'INVALID_CRITICAL_FIELD_COVERAGE' })
  }

  if (![researchPolicy.minimumSectorSampleSize, researchPolicy.minimumGlobalSampleSize]
    .every(isPositiveInteger)) {
    blockers.push({ code: 'INVALID_RESEARCH_SAMPLE_SIZE' })
  }

  if (![researchPolicy.manifestMaxAgeMs, researchPolicy.maxFutureSkewMs]
    .every(isNonNegativeFinite)) {
    blockers.push({ code: 'INVALID_RESEARCH_MANIFEST_AGE' })
  }

  const criticalFields = researchPolicy.criticalFields
  if (!Array.isArray(criticalFields) || criticalFields.length === 0 ||
      criticalFields.some(field => typeof field !== 'string' || field.length === 0) ||
      new Set(criticalFields).size !== criticalFields.length) {
    blockers.push({ code: 'INVALID_CRITICAL_FIELDS' })
  }

  return blockers
}

function blockedResearch(symbol, now, blockers) {
  return {
    symbol,
    asOf: new Date(now).toISOString(),
    dataStatus: 'BLOCKED',
    blockers,
    metrics: {},
    groups: {},
    compositeScore: null,
    coverage: { configuredWeight: 0, observedWeight: 0, ratio: 0 },
  }
}

function percentile(value, peers, direction) {
  if (peers.length === 1) return 50
  const oriented = direction === 'higher' ? value : -value
  const orientedPeers = peers.map(peer => direction === 'higher' ? peer : -peer)
  const below = orientedPeers.filter(peer => peer < oriented).length
  const tied = orientedPeers.filter(peer => peer === oriented).length
  return ((below + (tied - 1) / 2) / (peers.length - 1)) * 100
}

function qualityBlockers({ qualityManifest, researchPolicy, row, symbol, now }) {
  if (!qualityManifest) return [{ code: 'MISSING_QUALITY_MANIFEST' }]
  if (!isObject(qualityManifest)) return [{ code: 'INVALID_QUALITY_MANIFEST' }]

  const blockers = []
  if (qualityManifest.schemaVersion !== QUALITY_MANIFEST_SCHEMA_VERSION) {
    blockers.push({ code: 'UNSUPPORTED_QUALITY_MANIFEST_SCHEMA' })
  }
  if (qualityManifest.source !== QUALITY_MANIFEST_SOURCE) {
    blockers.push({ code: 'UNEXPECTED_QUALITY_MANIFEST_SOURCE' })
  }

  const counts = [
    qualityManifest.requested,
    qualityManifest.succeeded,
    qualityManifest.failed,
  ]
  const countsAreValid = counts.every(isNonNegativeInteger)
  if (!countsAreValid) {
    blockers.push({ code: 'INVALID_MANIFEST_COUNTS' })
  } else if (qualityManifest.requested !==
      qualityManifest.succeeded + qualityManifest.failed) {
    blockers.push({ code: 'MANIFEST_COUNTS_CONFLICT' })
  } else if (qualityManifest.requested === 0 || qualityManifest.succeeded === 0) {
    blockers.push({ code: 'EMPTY_MANIFEST_RESULTS' })
  }

  const reportedSuccessRate = qualityManifest.successRate
  const successRateIsValid = isRate(reportedSuccessRate)
  if (!successRateIsValid) {
    blockers.push({ code: 'MANIFEST_SUCCESS_RATE_CONFLICT' })
  } else if (countsAreValid) {
    const calculated = roundedRate(
      qualityManifest.succeeded,
      qualityManifest.requested,
    )
    if (Math.abs(reportedSuccessRate - calculated) > SUCCESS_RATE_TOLERANCE) {
      blockers.push({ code: 'MANIFEST_SUCCESS_RATE_CONFLICT' })
    }
  }
  if (successRateIsValid &&
      reportedSuccessRate < QUALITY_MANIFEST_MIN_SUCCESS_RATE) {
    blockers.push({ code: 'MANIFEST_SUCCESS_RATE_BELOW_MINIMUM' })
  }

  const { coverage } = qualityManifest
  if (!isObject(coverage)) {
    blockers.push({ code: 'INVALID_MANIFEST_COVERAGE' })
  } else {
    for (const field of QUALITY_MANIFEST_CRITICAL_FIELDS) {
      if (!Object.hasOwn(coverage, field)) {
        blockers.push({ code: 'MISSING_CANONICAL_COVERAGE_FIELD', field })
        continue
      }
      const rate = coverage[field]?.rate
      if (isRate(rate) && rate < QUALITY_MANIFEST_MIN_CRITICAL_FIELD_COVERAGE) {
        blockers.push({
          code: 'MANIFEST_CRITICAL_FIELD_COVERAGE_BELOW_MINIMUM',
          field,
        })
      }
    }

    for (const [field, fieldCoverage] of Object.entries(coverage)) {
      if (!isObject(fieldCoverage)) {
        blockers.push({ code: 'INVALID_MANIFEST_COVERAGE', field })
        continue
      }

      const coverageCountsAreValid =
        isNonNegativeInteger(fieldCoverage.available) &&
        isNonNegativeInteger(fieldCoverage.total)
      if (!coverageCountsAreValid || fieldCoverage.available > fieldCoverage.total ||
          (countsAreValid && fieldCoverage.total !== qualityManifest.succeeded)) {
        blockers.push({ code: 'MANIFEST_COVERAGE_COUNTS_CONFLICT', field })
      }

      if (!isRate(fieldCoverage.rate)) {
        blockers.push({ code: 'MANIFEST_COVERAGE_RATE_CONFLICT', field })
      } else if (coverageCountsAreValid) {
        const calculated = roundedRate(fieldCoverage.available, fieldCoverage.total)
        if (Math.abs(fieldCoverage.rate - calculated) > SUCCESS_RATE_TOLERANCE) {
          blockers.push({ code: 'MANIFEST_COVERAGE_RATE_CONFLICT', field })
        }
      }
    }
  }

  const failedSymbolsAreValid = Array.isArray(qualityManifest.failedSymbols) &&
    qualityManifest.failedSymbols.every(failedSymbol => typeof failedSymbol === 'string')
  if (!failedSymbolsAreValid) {
    blockers.push({ code: 'INVALID_FAILED_SYMBOLS' })
  } else if (countsAreValid && qualityManifest.failedSymbols.length !== qualityManifest.failed) {
    blockers.push({ code: 'FAILED_SYMBOL_COUNT_CONFLICT' })
  }

  const generatedAt = typeof qualityManifest.generatedAt === 'string'
    ? Date.parse(qualityManifest.generatedAt)
    : Number.NaN
  const nowTime = new Date(now).getTime()
  if (!Number.isFinite(generatedAt)) {
    blockers.push({ code: 'INVALID_QUALITY_MANIFEST_TIME' })
  } else {
    if (nowTime - generatedAt > researchPolicy.manifestMaxAgeMs) {
      blockers.push({ code: 'STALE_QUALITY_MANIFEST' })
    }
    if (generatedAt - nowTime > researchPolicy.maxFutureSkewMs) {
      blockers.push({ code: 'FUTURE_QUALITY_MANIFEST' })
    }
  }

  for (const field of researchPolicy.criticalFields) {
    const fieldCoverage = coverage?.[field]
    if (!fieldCoverage || !Number.isFinite(fieldCoverage.rate) ||
        fieldCoverage.rate < researchPolicy.minimumCriticalFieldCoverage) {
      blockers.push({ code: 'INSUFFICIENT_CRITICAL_FIELD_COVERAGE', field })
    }
    if (!Number.isFinite(row[field])) {
      blockers.push({ code: 'MISSING_CRITICAL_FIELD', field })
    }
  }

  if (failedSymbolsAreValid && qualityManifest.failedSymbols.includes(symbol)) {
    blockers.push({ code: 'QUALITY_FAILURE_FOR_SYMBOL' })
  }

  return blockers
}

export function evaluateResearch({ universe, symbol, qualityManifest, policy, now }) {
  const row = universe[symbol]
  const researchPolicy = policy?.research
  const policyBlockers = researchPolicyBlockers(researchPolicy)
  if (policyBlockers.length > 0) {
    return blockedResearch(symbol, now, policyBlockers)
  }
  const blockers = qualityBlockers({ qualityManifest, researchPolicy, row, symbol, now })
  if (blockers.length > 0) {
    return blockedResearch(symbol, now, blockers)
  }
  const metrics = {}
  let configuredWeight = 0
  let observedWeight = 0
  let weightedScore = 0

  for (const factor of FACTOR_CATALOG) {
    const weight = researchPolicy.factorWeights[factor.id] ?? 0
    if (weight <= 0) continue
    configuredWeight += weight

    const sectorPeers = Object.values(universe)
      .filter(peer => peer.sector === row.sector)
      .map(peer => peer[factor.field])
      .filter(Number.isFinite)
    const globalPeers = Object.values(universe)
      .map(peer => peer[factor.field])
      .filter(Number.isFinite)
    const useSector = sectorPeers.length >= researchPolicy.minimumSectorSampleSize
    const peers = useSector ? sectorPeers : globalPeers
    const minimumPeerCount = useSector
      ? researchPolicy.minimumSectorSampleSize
      : researchPolicy.minimumGlobalSampleSize
    const value = row[factor.field]

    if (!Number.isFinite(value) || peers.length < minimumPeerCount) {
      metrics[factor.id] = {
        field: factor.field,
        group: factor.group,
        value: null,
        percentile: null,
        peerScope: null,
        peerCount: 0,
        weight,
      }
      continue
    }
    observedWeight += weight
    const score = percentile(value, peers, factor.direction)
    weightedScore += score * weight
    metrics[factor.id] = {
      field: factor.field,
      group: factor.group,
      value,
      percentile: score,
      peerScope: useSector ? 'sector' : 'global',
      peerCount: peers.length,
      weight,
    }
  }

  const coverageRatio = configuredWeight === 0 ? 0 : observedWeight / configuredWeight
  if (coverageRatio < researchPolicy.minimumResearchCoverage) {
    blockers.push({ code: 'INSUFFICIENT_RESEARCH_COVERAGE' })
  }

  return {
    symbol,
    asOf: new Date(now).toISOString(),
    dataStatus: blockers.length === 0 ? 'VALID' : 'BLOCKED',
    blockers,
    metrics,
    groups: {},
    compositeScore: configuredWeight === 0 ? null : weightedScore / configuredWeight,
    coverage: {
      configuredWeight,
      observedWeight,
      ratio: coverageRatio,
    },
  }
}
