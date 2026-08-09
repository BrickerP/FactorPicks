import { createHash } from 'node:crypto'

const LONG_TERM_GATE_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED'])
const TIMING_STATUSES = new Set(['PASS', 'EVENT_RISK', 'FAIL', 'BLOCKED'])
const INVALIDATION_STATES = new Set(['UNTRIGGERED', 'TRIGGERED', 'UNKNOWN'])
const INVALIDATION_SEVERITIES = new Set(['REVIEW', 'PROHIBIT_ENTRY', 'EXIT_REVIEW'])
const INVALIDATION_OPERATORS = new Set(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'])
const MANUAL_STATE_BY_STATUS = Object.freeze({
  PENDING: 'UNKNOWN',
  CONFIRMED: 'TRIGGERED',
  REJECTED: 'UNTRIGGERED',
})
const HARD_LIMIT_KEYS = [
  'userHardLimit',
  'systemRiskLimit',
  'sectorHardLimit',
  'industryHardLimit',
  'portfolioHardLimit',
  'liquidityHardLimit',
]
const REMAINING_CAPACITY_KEYS = ['sector', 'industry', 'portfolio', 'liquidity']
const OPAQUE_REF_PATTERN = /^[a-z][a-z0-9-]*:[0-9a-f]{64}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const RESEARCH_BLOCKER_CODES = new Set([
  'EMPTY_MANIFEST_RESULTS',
  'FAILED_SYMBOL_COUNT_CONFLICT',
  'FUTURE_QUALITY_MANIFEST',
  'INSUFFICIENT_CRITICAL_FIELD_COVERAGE',
  'INSUFFICIENT_RESEARCH_COVERAGE',
  'INVALID_CRITICAL_FIELDS',
  'INVALID_CRITICAL_FIELD_COVERAGE',
  'INVALID_FACTOR_WEIGHT',
  'INVALID_FACTOR_WEIGHTS',
  'INVALID_FAILED_SYMBOLS',
  'INVALID_MANIFEST_COUNTS',
  'INVALID_MANIFEST_COVERAGE',
  'INVALID_MINIMUM_RESEARCH_COVERAGE',
  'INVALID_QUALITY_MANIFEST',
  'INVALID_QUALITY_MANIFEST_TIME',
  'INVALID_RESEARCH_MANIFEST_AGE',
  'INVALID_RESEARCH_POLICY',
  'INVALID_RESEARCH_SAMPLE_SIZE',
  'MANIFEST_COUNTS_CONFLICT',
  'MANIFEST_COVERAGE_COUNTS_CONFLICT',
  'MANIFEST_COVERAGE_RATE_CONFLICT',
  'MANIFEST_CRITICAL_FIELD_COVERAGE_BELOW_MINIMUM',
  'MANIFEST_SUCCESS_RATE_BELOW_MINIMUM',
  'MANIFEST_SUCCESS_RATE_CONFLICT',
  'MISSING_CANONICAL_COVERAGE_FIELD',
  'MISSING_CRITICAL_FIELD',
  'MISSING_POSITIVE_FACTOR_WEIGHT',
  'MISSING_QUALITY_MANIFEST',
  'QUALITY_FAILURE_FOR_SYMBOL',
  'STALE_QUALITY_MANIFEST',
  'UNEXPECTED_QUALITY_MANIFEST_SOURCE',
  'UNKNOWN_FACTOR_WEIGHT',
  'UNSUPPORTED_QUALITY_MANIFEST_SCHEMA',
])
const TIMING_REASON_CODES = new Set(['EARNINGS_SOON'])

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isOpaqueRef(value) {
  return isNonEmptyString(value) && OPAQUE_REF_PATTERN.test(value)
}

function isDigest(value) {
  return isNonEmptyString(value) && DIGEST_PATTERN.test(value)
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function validateTemporalValue({
  value,
  now,
  policy,
  blockers,
  invalidCode,
  staleCode,
  futureCode,
}) {
  if (!isTimestamp(value) || !isTimestamp(now)) {
    addBlocker(blockers, invalidCode)
    return false
  }
  const ageMs = Date.parse(now) - Date.parse(value)
  if (ageMs > policy.maxInputAgeMs) addBlocker(blockers, staleCode)
  if (ageMs < -policy.maxFutureSkewMs) addBlocker(blockers, futureCode)
  return true
}

function isSnapshotRef(value) {
  return isObject(value) &&
    isOpaqueRef(value.id) &&
    isOpaqueRef(value.version) &&
    isDigest(value.digest)
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Snapshot payload numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (!isObject(value)) throw new TypeError('Snapshot payload must be JSON-compatible')
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function payloadDigest(payload) {
  return `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`
}

function addBlocker(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code)
}

function normalizeExternalCodes(codes, allowedCodes, fallbackCode, fallbackWhenEmpty) {
  const normalized = []
  let rejected = false
  for (const code of Array.isArray(codes) ? codes : []) {
    if (isNonEmptyString(code) && allowedCodes.has(code)) addBlocker(normalized, code)
    else if (code !== null && code !== undefined && code !== '') rejected = true
  }
  if (rejected || (fallbackWhenEmpty && normalized.length === 0)) {
    addBlocker(normalized, fallbackCode)
  }
  return normalized
}

function snapshotIdentity(value) {
  return isObject(value)
    ? {
        id: isOpaqueRef(value.id) ? value.id : null,
        version: isOpaqueRef(value.version) ? value.version : null,
        digest: isDigest(value.digest) ? value.digest : null,
      }
    : null
}

function evaluatedPriceRecord(value) {
  return isObject(value)
    ? {
        value: value.value,
        currency: value.currency,
        asOf: value.asOf,
        source: isOpaqueRef(value.source) ? value.source : null,
      }
    : null
}

function valuationRangeRecord(value) {
  return isObject(value)
    ? {
        low: value.low,
        base: value.base,
        high: value.high,
        currency: value.currency,
        asOf: value.asOf,
        method: value.method,
        evidenceIds: Array.isArray(value.evidenceIds)
          ? value.evidenceIds.filter(isOpaqueRef)
          : [],
        uncertainty: value.uncertainty,
      }
    : null
}

function entryRangeRecord(value) {
  return isObject(value)
    ? {
        lower: value.lower,
        upper: value.upper,
        currency: value.currency,
        asOf: value.asOf,
        marginOfSafety: value.marginOfSafety,
        derivedFrom: valuationRangeRecord(value.derivedFrom),
        evidenceIds: Array.isArray(value.evidenceIds)
          ? value.evidenceIds.filter(isOpaqueRef)
          : [],
      }
    : null
}

function invalidationRuleRecord(rule) {
  return {
    id: isOpaqueRef(rule?.id) ? rule.id : null,
    condition: rule?.condition,
    evidenceIds: Array.isArray(rule?.evidenceIds)
      ? rule.evidenceIds.filter(isOpaqueRef)
      : [],
    predicate: isObject(rule?.predicate)
      ? {
          kind: rule.predicate.kind,
          metric: rule.predicate.metric,
          operator: rule.predicate.operator,
          threshold: rule.predicate.threshold,
          lookback: rule.predicate.lookback,
          consecutive: rule.predicate.consecutive,
          source: rule.predicate.source,
        }
      : null,
    manualStatus: rule?.manualStatus,
    severity: rule?.severity,
    state: rule?.state,
    observedAt: rule?.observedAt,
    response: rule?.response,
  }
}

function timingAssessmentRecord(value) {
  return isObject(value)
    ? {
        status: value.status,
        asOf: value.asOf,
        evidenceIds: Array.isArray(value.evidenceIds)
          ? value.evidenceIds.filter(isOpaqueRef)
          : [],
        reasonCodes: normalizeExternalCodes(
          value.reasonCodes,
          TIMING_REASON_CODES,
          'TIMING_RESTRICTED',
          false,
        ),
      }
    : null
}

function underwritingRecord(underwriting = {}) {
  return {
    longTermGate: underwriting.longTermGate ?? 'BLOCKED',
    evidenceIds: Array.isArray(underwriting.evidenceIds)
      ? underwriting.evidenceIds.filter(isOpaqueRef)
      : [],
    valuationRange: valuationRangeRecord(underwriting.valuationRange),
    entryRange: entryRangeRecord(underwriting.entryRange),
    invalidationRules: Array.isArray(underwriting.invalidationRules)
      ? underwriting.invalidationRules.map(invalidationRuleRecord)
      : [],
  }
}

function commonRecord(input) {
  const {
    research = {},
    evaluatedPrice,
    evidence,
    underwriting = {},
    timingAssessment,
    decisionPolicy,
    now,
  } = input

  return {
    schemaVersion: 2,
    symbol: research.symbol,
    decidedAt: isTimestamp(now) ? new Date(now).toISOString() : null,
    evaluatedPrice: evaluatedPriceRecord(evaluatedPrice),
    marketSnapshot: snapshotIdentity(research.marketSnapshot),
    qualitySnapshot: snapshotIdentity(research.qualitySnapshot),
    researchSnapshot: snapshotIdentity(research.researchSnapshot),
    underwritingSnapshot: snapshotIdentity(underwriting.snapshotRef),
    evidence: {
      digest: isDigest(evidence?.digest) ? evidence.digest : null,
      refs: Array.isArray(evidence?.items)
        ? evidence.items.map(item => item?.id).filter(isOpaqueRef)
        : [],
    },
    underwriting: underwritingRecord(underwriting),
    timingAssessment: timingAssessmentRecord(timingAssessment),
    decisionPolicyRef: snapshotIdentity(decisionPolicy?.ref),
  }
}

function requiredEvidenceIds(underwriting = {}, timingAssessment = {}) {
  return new Set([
    ...(underwriting.evidenceIds ?? []),
    ...(underwriting.valuationRange?.evidenceIds ?? []),
    ...(underwriting.entryRange?.evidenceIds ?? []),
    ...(underwriting.invalidationRules ?? []).flatMap(rule => rule?.evidenceIds ?? []),
    ...(timingAssessment.evidenceIds ?? []),
  ])
}

function evidenceProjection(item) {
  const scope = { symbol: item?.scope?.symbol }
  if (isNonEmptyString(item?.scope?.universe)) scope.universe = item.scope.universe
  return {
    id: item?.id,
    claim: item?.claim,
    source: { kind: item?.source?.kind, reference: item?.source?.reference },
    observedAt: item?.observedAt,
    asOf: item?.asOf,
    scope,
    stance: item?.stance,
    sourceQuality: item?.sourceQuality,
    derivation: item?.derivation,
    confidence: item?.confidence,
  }
}

function validateEvidence(input, blockers) {
  const { evidence, underwriting, timingAssessment, research, decisionPolicy, now } = input
  if (!isDigest(evidence?.digest) || !Array.isArray(evidence?.items)) {
    addBlocker(blockers, 'MISSING_EVIDENCE')
    return
  }
  if (!Number.isFinite(decisionPolicy?.maxInputAgeMs) ||
      decisionPolicy.maxInputAgeMs < 0 ||
      !Number.isFinite(decisionPolicy?.maxFutureSkewMs) ||
      decisionPolicy.maxFutureSkewMs < 0 || !isTimestamp(now)) {
    addBlocker(blockers, 'INVALID_EVIDENCE_POLICY')
    return
  }

  const ids = new Set()
  for (const item of evidence.items) {
    if (!isOpaqueRef(item?.id) || ids.has(item.id)) {
      addBlocker(blockers, 'INVALID_EVIDENCE_ID')
      continue
    }
    ids.add(item.id)
    if (!isNonEmptyString(item.claim) ||
        !isNonEmptyString(item?.source?.kind) ||
        !isNonEmptyString(item?.source?.reference)) {
      addBlocker(blockers, 'INVALID_EVIDENCE_SOURCE_REFERENCE')
    }
    if (item?.scope?.symbol !== research?.symbol) {
      addBlocker(blockers, 'EVIDENCE_SCOPE_MISMATCH')
    }
    const asOfValid = validateTemporalValue({
      value: item.asOf,
      now,
      policy: decisionPolicy,
      blockers,
      invalidCode: 'INVALID_EVIDENCE_TIMESTAMP',
      staleCode: 'STALE_EVIDENCE',
      futureCode: 'FUTURE_EVIDENCE',
    })
    const observedAtValid = validateTemporalValue({
      value: item.observedAt,
      now,
      policy: decisionPolicy,
      blockers,
      invalidCode: 'INVALID_EVIDENCE_TIMESTAMP',
      staleCode: 'STALE_EVIDENCE',
      futureCode: 'FUTURE_EVIDENCE',
    })
    if (asOfValid && observedAtValid && Date.parse(item.observedAt) < Date.parse(item.asOf)) {
      addBlocker(blockers, 'INCOHERENT_EVIDENCE_AS_OF')
    }
    if (!['SUPPORTS', 'CHALLENGES'].includes(item.stance) ||
        !['PRIMARY', 'SECONDARY'].includes(item.sourceQuality) ||
        !['OBSERVED', 'INFERRED'].includes(item.derivation) ||
        !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      addBlocker(blockers, 'INVALID_EVIDENCE')
    }
  }

  for (const evidenceId of requiredEvidenceIds(underwriting, timingAssessment)) {
    if (!isOpaqueRef(evidenceId)) addBlocker(blockers, 'INVALID_EVIDENCE_REFERENCE')
    else if (!ids.has(evidenceId)) addBlocker(blockers, 'MISSING_EVIDENCE_REFERENCE')
  }
  try {
    const normalizedItems = evidence.items
      .map(evidenceProjection)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    if (payloadDigest(normalizedItems) !== evidence.digest) {
      addBlocker(blockers, 'EVIDENCE_DIGEST_MISMATCH')
    }
  } catch {
    addBlocker(blockers, 'EVIDENCE_DIGEST_MISMATCH')
  }
}

function validateRanges(input, blockers) {
  const { underwriting = {}, evaluatedPrice } = input
  const valuation = underwriting.valuationRange
  const entry = underwriting.entryRange

  if (!isObject(valuation) ||
      ![valuation.low, valuation.base, valuation.high].every(Number.isFinite) ||
      valuation.low > valuation.base || valuation.base > valuation.high ||
      !isNonEmptyString(valuation.currency) || !isTimestamp(valuation.asOf) ||
      !isNonEmptyString(valuation.method) || !isNonEmptyString(valuation.uncertainty) ||
      !Array.isArray(valuation.evidenceIds) || valuation.evidenceIds.length === 0) {
    addBlocker(blockers, 'INVALID_VALUATION_RANGE')
  }

  if (!isObject(entry) ||
      !Number.isFinite(entry.lower) || !Number.isFinite(entry.upper) ||
      entry.lower > entry.upper || !isNonEmptyString(entry.currency) ||
      !isTimestamp(entry.asOf) || !Number.isFinite(entry.marginOfSafety) ||
      entry.marginOfSafety < 0 || entry.marginOfSafety > 1 ||
      !Array.isArray(entry.evidenceIds) || entry.evidenceIds.length === 0 ||
      !isObject(entry.derivedFrom)) {
    addBlocker(blockers, 'INVALID_ENTRY_RANGE')
  }

  if (isObject(valuation) && isObject(entry) &&
      (valuation.currency !== entry.currency ||
       JSON.stringify(entry.derivedFrom) !== JSON.stringify(valuation))) {
    addBlocker(blockers, 'ENTRY_RANGE_PROVENANCE_MISMATCH')
  }

  if (!isObject(evaluatedPrice) || !Number.isFinite(evaluatedPrice.value) ||
      evaluatedPrice.value < 0 || !isNonEmptyString(evaluatedPrice.currency) ||
      !isTimestamp(evaluatedPrice.asOf) || !isOpaqueRef(evaluatedPrice.source)) {
    addBlocker(blockers, 'INVALID_EVALUATED_PRICE')
  } else if (isObject(entry) && evaluatedPrice.currency !== entry.currency) {
    addBlocker(blockers, 'PRICE_CURRENCY_MISMATCH')
  }
}

function validateInvalidationRules(underwriting = {}, decisionPolicy, now, blockers) {
  if (!Array.isArray(underwriting.invalidationRules)) {
    addBlocker(blockers, 'INVALID_INVALIDATION_RULES')
    return
  }

  for (const rule of underwriting.invalidationRules) {
    const baseValid = isOpaqueRef(rule?.id) &&
      isNonEmptyString(rule?.condition) &&
      Array.isArray(rule?.evidenceIds) && rule.evidenceIds.length > 0 &&
      INVALIDATION_SEVERITIES.has(rule?.severity) &&
      INVALIDATION_STATES.has(rule?.state) &&
      isTimestamp(rule?.derivedFromAsOf) &&
      isTimestamp(rule?.observedAt) &&
      isNonEmptyString(rule?.response) &&
      isObject(rule?.predicate)
    if (!baseValid) {
      addBlocker(blockers, 'INVALID_INVALIDATION_RULE')
      continue
    }

    const predicate = rule.predicate
    let branchValid = false
    if (predicate.kind === 'METRIC') {
      const thresholdValid = Number.isFinite(predicate.threshold) ||
        (isNonEmptyString(predicate.threshold) && predicate.threshold.trim().length > 0) ||
        predicate.threshold === null
      const nullThresholdAllowed = ['EQ', 'NEQ'].includes(predicate.operator)
      branchValid = isNonEmptyString(predicate.metric) &&
        INVALIDATION_OPERATORS.has(predicate.operator) &&
        thresholdValid && (predicate.threshold !== null || nullThresholdAllowed) &&
        isNonEmptyString(predicate.lookback) &&
        Number.isInteger(predicate.consecutive) && predicate.consecutive > 0 &&
        isNonEmptyString(predicate.source) && rule.manualStatus === 'NOT_REQUIRED'
    } else if (predicate.kind === 'MANUAL') {
      branchValid = Object.hasOwn(MANUAL_STATE_BY_STATUS, rule.manualStatus) &&
        MANUAL_STATE_BY_STATUS[rule.manualStatus] === rule.state &&
        ['metric', 'operator', 'threshold', 'lookback', 'consecutive', 'source']
          .every(key => predicate[key] === null)
    }

    if (!branchValid) {
      addBlocker(blockers, 'INVALID_INVALIDATION_RULE')
      continue
    }
    if (decisionPolicy) {
      validateTemporalValue({
        value: rule.derivedFromAsOf,
        now,
        policy: decisionPolicy,
        blockers,
        invalidCode: 'INVALID_INVALIDATION_RULE',
        staleCode: 'STALE_INVALIDATION_OBSERVATION',
        futureCode: 'FUTURE_INVALIDATION_OBSERVATION',
      })
      validateTemporalValue({
        value: rule.observedAt,
        now,
        policy: decisionPolicy,
        blockers,
        invalidCode: 'INVALID_INVALIDATION_RULE',
        staleCode: 'STALE_INVALIDATION_OBSERVATION',
        futureCode: 'FUTURE_INVALIDATION_OBSERVATION',
      })
    }
    if (Date.parse(rule.observedAt) < Date.parse(rule.derivedFromAsOf)) {
      addBlocker(blockers, 'INCOHERENT_INVALIDATION_AS_OF')
    }
    if (rule.state === 'UNKNOWN') addBlocker(blockers, 'UNKNOWN_INVALIDATION_STATE')
  }
}

function validateSnapshotRefs(input, blockers) {
  const { research = {}, underwriting = {}, portfolioCapacity = {}, decisionPolicy = {} } = input
  const refs = [
    research.marketSnapshot,
    research.qualitySnapshot,
    research.researchSnapshot,
    underwriting.snapshotRef,
    portfolioCapacity.portfolioSnapshotRef,
    portfolioCapacity.capacityPolicyRef,
    decisionPolicy.ref,
  ]
  const resolvedSnapshots = Array.isArray(input.resolvedSnapshots)
    ? input.resolvedSnapshots
    : []
  for (const ref of refs) {
    if (!isSnapshotRef(ref)) {
      addBlocker(blockers, 'MISSING_SNAPSHOT_REFERENCE')
      continue
    }
    const resolved = resolvedSnapshots.find(candidate => candidate?.id === ref.id)
    if (!resolved) {
      addBlocker(blockers, 'MISSING_RESOLVED_SNAPSHOT')
      continue
    }
    if (resolved.version !== ref.version) {
      addBlocker(blockers, 'SNAPSHOT_IDENTITY_MISMATCH')
      continue
    }
    if (!Object.hasOwn(resolved, 'payload') || resolved.payload === undefined) {
      addBlocker(blockers, 'MISSING_RESOLVED_SNAPSHOT_PAYLOAD')
      continue
    }
    try {
      if (payloadDigest(resolved.payload) !== ref.digest) {
        addBlocker(blockers, 'SNAPSHOT_DIGEST_MISMATCH')
      }
    } catch {
      addBlocker(blockers, 'SNAPSHOT_DIGEST_MISMATCH')
    }
  }
}

function validateTemporalInputs(input, blockers) {
  const { decisionPolicy = {}, now } = input
  if (!isTimestamp(now) ||
      !Number.isFinite(decisionPolicy.maxInputAgeMs) || decisionPolicy.maxInputAgeMs < 0 ||
      !Number.isFinite(decisionPolicy.maxFutureSkewMs) || decisionPolicy.maxFutureSkewMs < 0) {
    return
  }

  const asOfValues = [
    input.evaluatedPrice?.asOf,
    input.timingAssessment?.asOf,
    input.portfolioCapacity?.asOf,
    input.underwriting?.valuationRange?.asOf,
    input.underwriting?.entryRange?.asOf,
  ]
  for (const asOf of asOfValues) {
    validateTemporalValue({
      value: asOf,
      now,
      policy: decisionPolicy,
      blockers,
      invalidCode: 'INVALID_DECISION_INPUT_TIMESTAMP',
      staleCode: 'STALE_DECISION_INPUT',
      futureCode: 'FUTURE_DECISION_INPUT',
    })
  }

  const coherentPairs = [
    [input.evaluatedPrice?.asOf, input.timingAssessment?.asOf],
    [input.underwriting?.valuationRange?.asOf, input.underwriting?.entryRange?.asOf],
    [input.underwriting?.valuationRange?.asOf,
      input.underwriting?.entryRange?.derivedFrom?.asOf],
    [input.portfolioCapacity?.asOf, input.portfolioCapacity?.denominator?.asOf],
  ]
  if (coherentPairs.some(([left, right]) =>
    isTimestamp(left) && isTimestamp(right) && left !== right)) {
    addBlocker(blockers, 'INCOHERENT_AS_OF')
  }
}

function validateDecisionInputs(input) {
  const blockers = []
  const {
    research = {},
    underwriting = {},
    timingAssessment = {},
    decisionPolicy = {},
  } = input

  if (!isNonEmptyString(research.symbol)) addBlocker(blockers, 'INVALID_SYMBOL')
  if (research.dataStatus !== 'VALID') {
    const researchBlockers = normalizeExternalCodes(
      research.blockerCodes,
      RESEARCH_BLOCKER_CODES,
      'RESEARCH_BLOCKED',
      true,
    )
    for (const code of researchBlockers) addBlocker(blockers, code)
  }
  validateSnapshotRefs(input, blockers)
  validateEvidence(input, blockers)
  if (!LONG_TERM_GATE_STATUSES.has(underwriting.longTermGate) ||
      underwriting.longTermGate === 'BLOCKED' ||
      !Array.isArray(underwriting.evidenceIds) || underwriting.evidenceIds.length === 0) {
    addBlocker(blockers, 'INVALID_LONG_TERM_GATE')
  }
  validateRanges(input, blockers)
  validateInvalidationRules(underwriting, decisionPolicy, input.now, blockers)
  if (!TIMING_STATUSES.has(timingAssessment.status) || timingAssessment.status === 'BLOCKED' ||
      !isTimestamp(timingAssessment.asOf) ||
      !Array.isArray(timingAssessment.evidenceIds) || timingAssessment.evidenceIds.length === 0 ||
      !Array.isArray(timingAssessment.reasonCodes)) {
    addBlocker(blockers, 'INVALID_TIMING_ASSESSMENT')
  }
  if (!Number.isFinite(decisionPolicy.targetPosition) || decisionPolicy.targetPosition < 0 ||
      !Number.isFinite(decisionPolicy.pilotPositionLimit) || decisionPolicy.pilotPositionLimit <= 0 ||
      typeof decisionPolicy.permitPilotOnEventRisk !== 'boolean' ||
      !Number.isFinite(decisionPolicy.maxInputAgeMs) || decisionPolicy.maxInputAgeMs < 0 ||
      !Number.isFinite(decisionPolicy.maxFutureSkewMs) || decisionPolicy.maxFutureSkewMs < 0) {
    addBlocker(blockers, 'INVALID_DECISION_POLICY')
  }
  validateTemporalInputs(input, blockers)

  return blockers
}

function capacityFor(portfolioCapacity, blockers) {
  if (!isObject(portfolioCapacity) || !isTimestamp(portfolioCapacity.asOf) ||
      portfolioCapacity.denominator?.kind !== 'NET_LIQUIDATION_VALUE' ||
      !isTimestamp(portfolioCapacity.denominator?.asOf) ||
      !isOpaqueRef(portfolioCapacity.denominator?.sourceRef) ||
      !isOpaqueRef(portfolioCapacity.denominator?.snapshotRef) ||
      !isDigest(portfolioCapacity.denominator?.digest) ||
      !isOpaqueRef(portfolioCapacity.currentPosition?.positionRef) ||
      !Number.isFinite(portfolioCapacity.currentPosition?.weight) ||
      portfolioCapacity.currentPosition.weight < 0) {
    addBlocker(blockers, 'INVALID_PORTFOLIO_CAPACITY')
    return null
  }

  const hardLimits = portfolioCapacity.hardLimits
  const remaining = portfolioCapacity.remainingCapacity
  const hardLimitValues = isObject(hardLimits)
    ? HARD_LIMIT_KEYS.map(key => hardLimits[key])
    : []
  const remainingValues = isObject(remaining)
    ? REMAINING_CAPACITY_KEYS.map(key => remaining[key])
    : []
  if (hardLimitValues.length !== HARD_LIMIT_KEYS.length ||
      remainingValues.length !== REMAINING_CAPACITY_KEYS.length ||
      hardLimitValues.some(value => !Number.isFinite(value) || value < 0) ||
      !Number.isFinite(hardLimits?.userHardLimit) || hardLimits.userHardLimit <= 0 ||
      !Number.isFinite(hardLimits?.systemRiskLimit) || hardLimits.systemRiskLimit <= 0 ||
      remainingValues.some(value => !Number.isFinite(value) || value < 0) ||
      !isObject(portfolioCapacity.digests) ||
      !['capacity', 'portfolio', 'capacityPolicy'].every(
        key => isDigest(portfolioCapacity.digests[key]),
      )) {
    addBlocker(blockers, 'INVALID_PORTFOLIO_CAPACITY')
    return null
  }

  const currentWeight = portfolioCapacity.currentPosition.weight
  const effectiveLimit = Math.min(
    hardLimits.userHardLimit,
    hardLimits.systemRiskLimit,
    hardLimits.sectorHardLimit,
    hardLimits.industryHardLimit,
    hardLimits.portfolioHardLimit,
    hardLimits.liquidityHardLimit,
    currentWeight + remaining.sector,
    currentWeight + remaining.industry,
    currentWeight + remaining.portfolio,
    currentWeight + remaining.liquidity,
  )

  return {
    currentPosition: {
      weight: portfolioCapacity.currentPosition.weight,
      positionRef: portfolioCapacity.currentPosition.positionRef,
    },
    effectiveLimit,
    capacityToLimit: Math.max(0, effectiveLimit - currentWeight),
    portfolioSnapshotRef: snapshotIdentity(portfolioCapacity.portfolioSnapshotRef),
    capacityPolicyRef: snapshotIdentity(portfolioCapacity.capacityPolicyRef),
    digests: {
      capacity: portfolioCapacity.digests.capacity,
      portfolio: portfolioCapacity.digests.portfolio,
      capacityPolicy: portfolioCapacity.digests.capacityPolicy,
    },
  }
}

function positionSizingFor(decisionPolicy, capacitySummary, targetCap = Infinity) {
  const targetPosition = Math.min(
    decisionPolicy.targetPosition,
    capacitySummary.effectiveLimit,
    targetCap,
  )
  return {
    targetPosition,
    additionalCapacity: Math.max(
      0,
      targetPosition - capacitySummary.currentPosition.weight,
    ),
  }
}

function blockedRecord(input, blockerCodes) {
  const holding = Number.isFinite(input.portfolioCapacity?.currentPosition?.weight) &&
    input.portfolioCapacity.currentPosition.weight > 0
  return {
    ...commonRecord(input),
    dataStatus: 'EVALUATION_BLOCKED',
    entryStatus: 'PROHIBITED',
    blockerCodes,
    capacitySummary: null,
    positionSizing: null,
    buyAction: 'NO_ACTION',
    holdingRisk: holding ? 'REVIEW' : 'NONE',
    reasonCodes: [...blockerCodes],
  }
}

function validRecord(input, capacitySummary, positionSizing, {
  entryStatus,
  buyAction,
  holdingRisk = 'NONE',
  reasonCodes,
}) {
  return {
    ...commonRecord(input),
    dataStatus: 'VALID',
    entryStatus,
    blockerCodes: [],
    capacitySummary,
    positionSizing,
    buyAction,
    holdingRisk,
    reasonCodes,
  }
}

function prohibitedForHolding(
  input,
  capacitySummary,
  positionSizing,
  reasonCodes,
  holdingRisk = 'REVIEW',
) {
  const holding = capacitySummary.currentPosition.weight > 0
  return validRecord(input, capacitySummary, positionSizing, {
    entryStatus: 'PROHIBITED',
    buyAction: holding ? 'NO_ACTION' : 'WATCH',
    holdingRisk: holding ? holdingRisk : 'NONE',
    reasonCodes,
  })
}

export function evaluateDecision(input) {
  const blockers = validateDecisionInputs(input)
  const capacitySummary = capacityFor(input.portfolioCapacity, blockers)
  if (blockers.length > 0) return blockedRecord(input, blockers)

  const currentWeight = capacitySummary.currentPosition.weight
  const holding = currentWeight > 0
  const positionSizing = positionSizingFor(input.decisionPolicy, capacitySummary)

  if (input.underwriting.longTermGate === 'FAIL') {
    return prohibitedForHolding(
      input, capacitySummary, positionSizing, ['LONG_TERM_GATE_FAILED'],
    )
  }

  const triggeredRules = input.underwriting.invalidationRules.filter(
    rule => rule.state === 'TRIGGERED',
  )
  if (triggeredRules.length > 0) {
    const exitReview = triggeredRules.some(rule => rule.severity === 'EXIT_REVIEW')
    return prohibitedForHolding(
      input,
      capacitySummary,
      positionSizing,
      ['UNDERWRITING_INVALIDATED'],
      exitReview ? 'EXIT_REVIEW' : 'REVIEW',
    )
  }

  const { value: price } = input.evaluatedPrice
  const { lower, upper } = input.underwriting.entryRange
  if (price < lower || price > upper) {
    return prohibitedForHolding(
      input, capacitySummary, positionSizing, ['PRICE_OUTSIDE_ENTRY_RANGE'],
    )
  }

  if (currentWeight > capacitySummary.effectiveLimit) {
    return validRecord(input, capacitySummary, positionSizing, {
      entryStatus: 'PROHIBITED',
      buyAction: 'NO_ACTION',
      holdingRisk: 'REDUCE_REVIEW',
      reasonCodes: ['POSITION_ABOVE_EFFECTIVE_LIMIT'],
    })
  }
  if (capacitySummary.capacityToLimit === 0 || positionSizing.additionalCapacity === 0) {
    return validRecord(input, capacitySummary, positionSizing, {
      entryStatus: 'PROHIBITED',
      buyAction: 'NO_ACTION',
      reasonCodes: ['NO_EFFECTIVE_CAPACITY'],
    })
  }

  if (input.timingAssessment.status === 'FAIL') {
    return prohibitedForHolding(
      input, capacitySummary, positionSizing, ['TIMING_FAILED'],
    )
  }
  if (input.timingAssessment.status === 'EVENT_RISK') {
    if (holding || !input.decisionPolicy.permitPilotOnEventRisk) {
      return prohibitedForHolding(
        input, capacitySummary, positionSizing, ['EVENT_RISK'],
      )
    }
    const pilotSizing = positionSizingFor(
      input.decisionPolicy,
      capacitySummary,
      input.decisionPolicy.pilotPositionLimit,
    )
    return validRecord(input, capacitySummary, pilotSizing, {
      entryStatus: 'PERMITTED',
      buyAction: 'PILOT',
      reasonCodes: ['EVENT_RISK'],
    })
  }

  return validRecord(input, capacitySummary, positionSizing, {
    entryStatus: 'PERMITTED',
    buyAction: holding ? 'ADD' : 'OPEN',
    reasonCodes: ['ALL_GATES_PASSED'],
  })
}
