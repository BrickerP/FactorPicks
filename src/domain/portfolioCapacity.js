import {
  createSnapshot,
  digest,
  isDigest,
  isOpaqueRef,
  isSnapshotRef,
  opaqueRef,
  resolvedSnapshotsById,
  sameCanonical,
  snapshotIdentity,
} from './contentAddressing.js'

const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/
const HARD_LIMIT_KEYS = [
  'userHardLimit',
  'systemRiskLimit',
  'sectorHardLimit',
  'industryHardLimit',
  'portfolioHardLimit',
  'liquidityHardLimit',
]
const REMAINING_CAPACITY_KEYS = ['sector', 'industry', 'portfolio', 'liquidity']

class CapacityInputError extends TypeError {
  constructor() {
    super('Portfolio capacity input is invalid')
    this.code = 'INVALID_PORTFOLIO_CAPACITY_INPUT'
  }
}

function failInput() {
  throw new CapacityInputError()
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isTicker(value) {
  return typeof value === 'string' && TICKER_PATTERN.test(value)
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}


function isRatio(value, { positive = false } = {}) {
  return Number.isFinite(value) && (positive ? value > 0 : value >= 0) && value <= 1
}

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}


function validateFreshness(asOf, evaluatedAt, maxAgeMs, maxFutureSkewMs) {
  if (!isTimestamp(asOf) || !isTimestamp(evaluatedAt) ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 0 ||
      !Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) failInput()
  const ageMs = Date.parse(evaluatedAt) - Date.parse(asOf)
  if (ageMs > maxAgeMs || ageMs < -maxFutureSkewMs) failInput()
}

function computeCapacityMetrics(portfolioFacts, policyFacts) {
  const { exposures } = portfolioFacts
  const { limits, liquidity } = policyFacts
  const portfolioHardLimit = Math.min(
    limits.portfolioHardLimit,
    1 - limits.minimumCashBufferWeight,
  )
  const hardLimits = {
    userHardLimit: limits.userHardLimit,
    systemRiskLimit: limits.systemRiskLimit,
    sectorHardLimit: limits.sectorHardLimit,
    industryHardLimit: limits.industryHardLimit,
    portfolioHardLimit,
    liquidityHardLimit: liquidity.maxPositionWeight,
  }
  const remainingCapacity = {
    sector: Math.max(0, limits.sectorHardLimit - exposures.sector),
    industry: Math.max(0, limits.industryHardLimit - exposures.industry),
    portfolio: Math.max(0, portfolioHardLimit - exposures.portfolio),
    liquidity: Math.max(0, liquidity.maxPositionWeight - exposures.current),
  }
  const effectiveLimit = Math.min(
    ...HARD_LIMIT_KEYS.map(key => hardLimits[key]),
    ...REMAINING_CAPACITY_KEYS.map(
      key => exposures.current + remainingCapacity[key],
    ),
  )
  return {
    currentPosition: {
      weight: exposures.current,
      positionRef: portfolioFacts.positionRef,
    },
    hardLimits,
    remainingCapacity,
    effectiveLimit,
    capacityToLimit: Math.max(0, effectiveLimit - exposures.current),
  }
}

function validatePortfolioFacts(value, expectedSymbol) {
  if (!hasOnlyKeys(value, [
    'schemaVersion',
    'symbol',
    'asOf',
    'sourceRef',
    'denominator',
    'positionRef',
    'classification',
    'exposures',
  ]) || !hasOnlyKeys(value.denominator, ['kind', 'asOf', 'sourceRef']) ||
      !hasOnlyKeys(value.classification, ['sector', 'industry']) ||
      !hasOnlyKeys(value.exposures, ['current', 'sector', 'industry', 'portfolio']) ||
      value.schemaVersion !== 1 ||
      value.symbol !== expectedSymbol || !isTicker(value.symbol) ||
      !isTimestamp(value.asOf) || !isOpaqueRef(value.sourceRef) ||
      value.denominator?.kind !== 'NET_LIQUIDATION_VALUE' ||
      value.denominator?.asOf !== value.asOf ||
      value.denominator?.sourceRef !== value.sourceRef ||
      !isOpaqueRef(value.positionRef) ||
      !isNonEmptyString(value.classification?.sector) ||
      !isNonEmptyString(value.classification?.industry) ||
      !isObject(value.exposures) ||
      !['current', 'sector', 'industry', 'portfolio']
        .every(key => isRatio(value.exposures[key])) ||
      value.exposures.current > value.exposures.sector ||
      value.exposures.current > value.exposures.industry ||
      value.exposures.current > value.exposures.portfolio ||
      value.exposures.sector > value.exposures.portfolio ||
      value.exposures.industry > value.exposures.portfolio) return false
  return true
}

function validatePolicyFacts(value, portfolioAsOf) {
  const limits = value?.limits
  const freshness = value?.freshnessPolicy
  if (!hasOnlyKeys(value, [
    'schemaVersion',
    'sourceRef',
    'effectiveFrom',
    'effectiveUntil',
    'evaluatedAt',
    'freshnessPolicy',
    'limits',
    'liquidity',
  ]) || !hasOnlyKeys(limits, [
    'userHardLimit',
    'systemRiskLimit',
    'sectorHardLimit',
    'industryHardLimit',
    'portfolioHardLimit',
    'minimumCashBufferWeight',
  ]) || !hasOnlyKeys(freshness, [
    'maxPortfolioAgeMs',
    'maxLiquidityAgeMs',
    'maxFutureSkewMs',
  ]) || !hasOnlyKeys(value.liquidity, [
    'maxPositionWeight',
    'asOf',
    'sourceRef',
  ]) || value.schemaVersion !== 1 ||
      !isOpaqueRef(value.sourceRef) || !isTimestamp(value.effectiveFrom) ||
      !isTimestamp(value.effectiveUntil) || !isTimestamp(value.evaluatedAt) ||
      Date.parse(value.effectiveFrom) > Date.parse(portfolioAsOf) ||
      Date.parse(portfolioAsOf) > Date.parse(value.effectiveUntil) ||
      !isObject(limits) ||
      !isRatio(limits.userHardLimit, { positive: true }) ||
      !isRatio(limits.systemRiskLimit, { positive: true }) ||
      !isRatio(limits.sectorHardLimit) || !isRatio(limits.industryHardLimit) ||
      !isRatio(limits.portfolioHardLimit) ||
      !isRatio(limits.minimumCashBufferWeight) ||
      !isObject(freshness) ||
      !Number.isFinite(freshness.maxPortfolioAgeMs) ||
      freshness.maxPortfolioAgeMs < 0 ||
      !Number.isFinite(freshness.maxLiquidityAgeMs) ||
      freshness.maxLiquidityAgeMs < 0 ||
      !Number.isFinite(freshness.maxFutureSkewMs) ||
      freshness.maxFutureSkewMs < 0 ||
      !isObject(value.liquidity) ||
      !isRatio(value.liquidity.maxPositionWeight) ||
      value.liquidity.asOf !== portfolioAsOf ||
      !isOpaqueRef(value.liquidity.sourceRef)) return false
  try {
    validateFreshness(
      portfolioAsOf,
      value.evaluatedAt,
      freshness.maxPortfolioAgeMs,
      freshness.maxFutureSkewMs,
    )
    validateFreshness(
      value.liquidity.asOf,
      value.evaluatedAt,
      freshness.maxLiquidityAgeMs,
      freshness.maxFutureSkewMs,
    )
  } catch {
    return false
  }
  return true
}

function capacityProjection(portfolioCapacity) {
  return {
    asOf: portfolioCapacity.asOf,
    symbol: portfolioCapacity.symbol,
    currentPosition: {
      weight: portfolioCapacity.currentPosition.weight,
      positionRef: portfolioCapacity.currentPosition.positionRef,
    },
    hardLimits: Object.fromEntries(
      HARD_LIMIT_KEYS.map(key => [key, portfolioCapacity.hardLimits[key]]),
    ),
    remainingCapacity: Object.fromEntries(
      REMAINING_CAPACITY_KEYS.map(key => [key, portfolioCapacity.remainingCapacity[key]]),
    ),
    effectiveLimit: portfolioCapacity.effectiveLimit,
    capacityToLimit: portfolioCapacity.capacityToLimit,
    portfolioSnapshotRef: snapshotIdentity(portfolioCapacity.portfolioSnapshotRef),
    capacityPolicyRef: snapshotIdentity(portfolioCapacity.capacityPolicyRef),
  }
}


export function derivePortfolioCapacitySnapshot(input) {
  if (!isObject(input)) failInput()
  const { symbol, portfolio, policy, liquidity, evaluatedAt, freshnessPolicy } = input
  if (!isTicker(symbol) || !isObject(portfolio) || !isObject(policy) ||
      !isObject(liquidity) || !isObject(freshnessPolicy) ||
      !isTimestamp(evaluatedAt) || !isTimestamp(portfolio.asOf) ||
      !isOpaqueRef(portfolio.sourceRef) || portfolio.completeness !== 'COMPLETE' ||
      portfolio.accountCount !== 1 || portfolio.accountType !== 'CASH' ||
      portfolio.currency !== 'USD' || portfolio.hasOptions !== false ||
      portfolio.hasCrypto !== false || !Number.isFinite(portfolio.netLiquidationValue) ||
      portfolio.netLiquidationValue <= 0 || !Array.isArray(portfolio.positions) ||
      !isTimestamp(liquidity.asOf) || liquidity.asOf !== portfolio.asOf ||
      !isOpaqueRef(liquidity.sourceRef) || !isRatio(liquidity.maxPositionWeight) ||
      !isOpaqueRef(policy.sourceRef) || !isTimestamp(policy.effectiveFrom) ||
      !isTimestamp(policy.effectiveUntil)) failInput()

  validateFreshness(
    portfolio.asOf,
    evaluatedAt,
    freshnessPolicy.maxPortfolioAgeMs,
    freshnessPolicy.maxFutureSkewMs,
  )
  validateFreshness(
    liquidity.asOf,
    evaluatedAt,
    freshnessPolicy.maxLiquidityAgeMs,
    freshnessPolicy.maxFutureSkewMs,
  )
  if (Date.parse(policy.effectiveFrom) > Date.parse(portfolio.asOf) ||
      Date.parse(portfolio.asOf) > Date.parse(policy.effectiveUntil)) failInput()

  const limits = {
    userHardLimit: policy.userHardLimit,
    systemRiskLimit: policy.systemRiskLimit,
    sectorHardLimit: policy.sectorHardLimit,
    industryHardLimit: policy.industryHardLimit,
    portfolioHardLimit: policy.portfolioHardLimit,
    minimumCashBufferWeight: policy.minimumCashBufferWeight,
  }
  if (!isRatio(limits.userHardLimit, { positive: true }) ||
      !isRatio(limits.systemRiskLimit, { positive: true }) ||
      !isRatio(limits.sectorHardLimit) || !isRatio(limits.industryHardLimit) ||
      !isRatio(limits.portfolioHardLimit) ||
      !isRatio(limits.minimumCashBufferWeight)) failInput()

  const positionsBySymbol = new Map()
  for (const position of portfolio.positions) {
    if (!isObject(position) || !isTicker(position.symbol) ||
        !Number.isFinite(position.quantity) || position.quantity <= 0 ||
        !Number.isFinite(position.markPrice) || position.markPrice <= 0 ||
        position.asOf !== portfolio.asOf || position.currency !== 'USD' ||
        position.assetType !== 'EQUITY' || position.side !== 'LONG' ||
        !isNonEmptyString(position.sector) || !isNonEmptyString(position.industry)) {
      failInput()
    }
    const existing = positionsBySymbol.get(position.symbol)
    if (existing &&
        (existing.sector !== position.sector || existing.industry !== position.industry)) {
      failInput()
    }
    const marketValue = position.quantity * position.markPrice
    if (!Number.isFinite(marketValue)) failInput()
    positionsBySymbol.set(position.symbol, {
      symbol: position.symbol,
      sector: position.sector,
      industry: position.industry,
      marketValue: (existing?.marketValue ?? 0) + marketValue,
    })
  }

  const marketValues = [...positionsBySymbol.values()]
  const portfolioMarketValue = marketValues.reduce(
    (total, position) => total + position.marketValue,
    0,
  )
  if (!Number.isFinite(portfolioMarketValue) ||
      portfolioMarketValue > portfolio.netLiquidationValue) failInput()
  const target = positionsBySymbol.get(symbol)
  const classification = target ?? portfolio.targetClassification
  if (!isNonEmptyString(classification?.sector) ||
      !isNonEmptyString(classification?.industry)) failInput()
  const currentMarketValue = target?.marketValue ?? 0
  const sectorMarketValue = marketValues
    .filter(position => position.sector === classification.sector)
    .reduce((total, position) => total + position.marketValue, 0)
  const industryMarketValue = marketValues
    .filter(position => position.industry === classification.industry)
    .reduce((total, position) => total + position.marketValue, 0)
  const exposures = {
    current: currentMarketValue / portfolio.netLiquidationValue,
    sector: sectorMarketValue / portfolio.netLiquidationValue,
    industry: industryMarketValue / portfolio.netLiquidationValue,
    portfolio: portfolioMarketValue / portfolio.netLiquidationValue,
  }
  const positionIdentity = {
    symbol,
    asOf: portfolio.asOf,
    sourceRef: portfolio.sourceRef,
    classification: { sector: classification.sector, industry: classification.industry },
    exposures,
  }
  const positionRef = opaqueRef('position', digest(positionIdentity))
  const portfolioPayload = {
    schemaVersion: 1,
    symbol,
    asOf: portfolio.asOf,
    sourceRef: portfolio.sourceRef,
    denominator: {
      kind: 'NET_LIQUIDATION_VALUE',
      asOf: portfolio.asOf,
      sourceRef: portfolio.sourceRef,
    },
    positionRef,
    classification: positionIdentity.classification,
    exposures,
  }
  const policyPayload = {
    schemaVersion: 1,
    sourceRef: policy.sourceRef,
    effectiveFrom: policy.effectiveFrom,
    effectiveUntil: policy.effectiveUntil,
    evaluatedAt,
    freshnessPolicy: {
      maxPortfolioAgeMs: freshnessPolicy.maxPortfolioAgeMs,
      maxLiquidityAgeMs: freshnessPolicy.maxLiquidityAgeMs,
      maxFutureSkewMs: freshnessPolicy.maxFutureSkewMs,
    },
    limits,
    liquidity: {
      maxPositionWeight: liquidity.maxPositionWeight,
      asOf: liquidity.asOf,
      sourceRef: liquidity.sourceRef,
    },
  }
  const metrics = computeCapacityMetrics(portfolioPayload, policyPayload)
  const portfolioSnapshot = createSnapshot('portfolio', portfolioPayload)
  const capacityPolicySnapshot = createSnapshot('capacity-policy', policyPayload)
  const projection = {
    asOf: portfolio.asOf,
    symbol,
    ...metrics,
    portfolioSnapshotRef: portfolioSnapshot.ref,
    capacityPolicyRef: capacityPolicySnapshot.ref,
  }

  return {
    portfolioCapacity: {
      ...projection,
      denominator: {
        kind: 'NET_LIQUIDATION_VALUE',
        asOf: portfolio.asOf,
        sourceRef: portfolio.sourceRef,
        snapshotRef: portfolioSnapshot.ref.id,
        digest: portfolioSnapshot.ref.digest,
      },
      digests: {
        capacity: digest(projection),
        portfolio: portfolioSnapshot.ref.digest,
        capacityPolicy: capacityPolicySnapshot.ref.digest,
      },
    },
    resolvedSnapshots: [portfolioSnapshot.resolved, capacityPolicySnapshot.resolved],
  }
}

export function projectPortfolioCapacity(
  portfolioCapacity,
  expectedSymbol,
  resolvedSnapshots,
) {
  try {
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    if (!resolved || !isObject(portfolioCapacity) || !isTicker(expectedSymbol) ||
        portfolioCapacity.symbol !== expectedSymbol ||
        portfolioCapacity.denominator?.kind !== 'NET_LIQUIDATION_VALUE' ||
        portfolioCapacity.denominator?.asOf !== portfolioCapacity.asOf ||
        !isOpaqueRef(portfolioCapacity.denominator?.sourceRef) ||
        !isSnapshotRef(portfolioCapacity.portfolioSnapshotRef) ||
        !isSnapshotRef(portfolioCapacity.capacityPolicyRef) ||
        portfolioCapacity.denominator.snapshotRef !== portfolioCapacity.portfolioSnapshotRef.id ||
        portfolioCapacity.denominator.digest !== portfolioCapacity.portfolioSnapshotRef.digest ||
        !isObject(portfolioCapacity.digests)) return null

    const portfolioResolved = resolved.get(portfolioCapacity.portfolioSnapshotRef.id)
    const policyResolved = resolved.get(portfolioCapacity.capacityPolicyRef.id)
    const expectedPortfolioSnapshot = portfolioResolved &&
      createSnapshot('portfolio', portfolioResolved.payload)
    const expectedPolicySnapshot = policyResolved &&
      createSnapshot('capacity-policy', policyResolved.payload)
    if (!portfolioResolved || !policyResolved ||
        portfolioResolved.version !== portfolioCapacity.portfolioSnapshotRef.version ||
        policyResolved.version !== portfolioCapacity.capacityPolicyRef.version ||
        digest(portfolioResolved.payload) !== portfolioCapacity.portfolioSnapshotRef.digest ||
        digest(policyResolved.payload) !== portfolioCapacity.capacityPolicyRef.digest ||
        !sameCanonical(expectedPortfolioSnapshot.resolved, portfolioResolved) ||
        !sameCanonical(expectedPolicySnapshot.resolved, policyResolved) ||
        !validatePortfolioFacts(portfolioResolved.payload, expectedSymbol) ||
        !validatePolicyFacts(policyResolved.payload, portfolioResolved.payload.asOf) ||
        portfolioCapacity.asOf !== portfolioResolved.payload.asOf ||
        portfolioCapacity.denominator.sourceRef !== portfolioResolved.payload.sourceRef ||
        portfolioCapacity.digests.portfolio !== portfolioCapacity.portfolioSnapshotRef.digest ||
        portfolioCapacity.digests.capacityPolicy !== portfolioCapacity.capacityPolicyRef.digest) {
      return null
    }

    const metrics = computeCapacityMetrics(
      portfolioResolved.payload,
      policyResolved.payload,
    )
    const expectedProjection = {
      asOf: portfolioResolved.payload.asOf,
      symbol: expectedSymbol,
      ...metrics,
      portfolioSnapshotRef: snapshotIdentity(portfolioCapacity.portfolioSnapshotRef),
      capacityPolicyRef: snapshotIdentity(portfolioCapacity.capacityPolicyRef),
    }
    if (!sameCanonical(capacityProjection(portfolioCapacity), expectedProjection) ||
        !isDigest(portfolioCapacity.digests.capacity) ||
        digest(expectedProjection) !== portfolioCapacity.digests.capacity) return null

    return {
      currentPosition: metrics.currentPosition,
      effectiveLimit: metrics.effectiveLimit,
      capacityToLimit: metrics.capacityToLimit,
      portfolioSnapshotRef: snapshotIdentity(portfolioCapacity.portfolioSnapshotRef),
      capacityPolicyRef: snapshotIdentity(portfolioCapacity.capacityPolicyRef),
      digests: {
        capacity: portfolioCapacity.digests.capacity,
        portfolio: portfolioCapacity.digests.portfolio,
        capacityPolicy: portfolioCapacity.digests.capacityPolicy,
      },
    }
  } catch {
    return null
  }
}
