import {
  createSnapshot,
  digest as payloadDigest,
  isDigest,
  isOpaqueRef,
  isSnapshotRef,
  resolvedSnapshotsById,
  sameCanonical,
  snapshotIdentity as contentSnapshotIdentity,
} from './contentAddressing.js'
import { classifyEvidenceFreshness, projectEvidenceBundle } from './evidence.js'
import { projectPortfolioCapacity } from './portfolioCapacity.js'
import { projectStructuredUnderwriting } from './structuredUnderwriting.js'

const TIMING_STATUSES = new Set(['PASS', 'EVENT_RISK', 'FAIL', 'BLOCKED'])
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
  return isSnapshotRef(value) ? contentSnapshotIdentity(value) : null
}

function projectDecisionPolicy(value, expectedSymbol, resolvedSnapshots) {
  try {
    if (!isObject(value) || !isSnapshotRef(value.ref)) return null
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    const item = resolved?.get(value.ref.id)
    if (!item || !sameCanonical(createSnapshot('decision-policy', item.payload).resolved, item)) {
      return null
    }
    const payload = item.payload
    if (payload?.role !== 'DECISION_POLICY' || payload.kind !== 'DECISION_POLICY' ||
        payload.schemaVersion !== 1 || payload.symbol !== expectedSymbol ||
        payload.currency !== 'USD' || !isTimestamp(payload.asOf) || !isObject(payload.policy)) {
      return null
    }
    const projected = { ...payload.policy, ref: contentSnapshotIdentity(value.ref) }
    return sameCanonical(value, projected) ? projected : null
  } catch { return null }
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
    derivedFromAsOf: rule?.derivedFromAsOf,
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
  if (!underwriting) return null
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
    underwriting,
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
    underwritingSnapshot: snapshotIdentity(underwriting?.snapshotRef),
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

function validateSnapshotRefs(input, blockers) {
  const research = input.research ?? {}
  const underwriting = input.underwriting ?? {}
  const portfolioCapacity = input.portfolioCapacity ?? {}
  const decisionPolicy = input.decisionPolicy ?? {}
  const refs = [
    research.marketSnapshot,
    research.qualitySnapshot,
    research.researchSnapshot,
    underwriting.snapshotRef,
    portfolioCapacity.portfolioSnapshotRef,
    portfolioCapacity.capacityPolicyRef,
    decisionPolicy.ref,
  ]
  const resolvedById = resolvedSnapshotsById(input.resolvedSnapshots)
  if (!resolvedById) {
    addBlocker(blockers, 'DUPLICATE_RESOLVED_SNAPSHOT_ID')
    return new Map()
  }
  for (const ref of refs) {
    if (!isSnapshotRef(ref)) {
      addBlocker(blockers, 'MISSING_SNAPSHOT_REFERENCE')
      continue
    }
    const resolved = resolvedById.get(ref.id)
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
  return resolvedById
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
  const projectedDecisionPolicy = projectDecisionPolicy(
    decisionPolicy,
    research.symbol,
    input.resolvedSnapshots,
  )
  if (!projectedDecisionPolicy) addBlocker(blockers, 'INVALID_DECISION_POLICY')

  const evidenceFreshness = classifyEvidenceFreshness(input.evidence, input.resolvedSnapshots, {
    evaluatedAt: input.now,
    maxInputAgeMs: projectedDecisionPolicy?.maxInputAgeMs,
    maxFutureSkewMs: projectedDecisionPolicy?.maxFutureSkewMs,
  })
  if (evidenceFreshness === 'STALE') addBlocker(blockers, 'STALE_EVIDENCE_BUNDLE')
  if (evidenceFreshness === 'FUTURE') addBlocker(blockers, 'FUTURE_EVIDENCE_BUNDLE')
  const projectedEvidence = projectEvidenceBundle(
    input.evidence,
    research.symbol,
    input.resolvedSnapshots,
    { evaluatedAt: input.now,
      maxInputAgeMs: projectedDecisionPolicy?.maxInputAgeMs,
      maxFutureSkewMs: projectedDecisionPolicy?.maxFutureSkewMs },
  )
  if (!projectedEvidence) addBlocker(blockers, 'INVALID_EVIDENCE_BUNDLE')
  const projectedUnderwriting = projectedEvidence && projectStructuredUnderwriting(
    underwriting,
    research.symbol,
    projectedEvidence,
    input.resolvedSnapshots,
    { evaluatedAt: input.now,
      maxInputAgeMs: projectedDecisionPolicy?.maxInputAgeMs,
      maxFutureSkewMs: projectedDecisionPolicy?.maxFutureSkewMs },
  )
  if (!projectedUnderwriting) addBlocker(blockers, 'INVALID_STRUCTURED_UNDERWRITING')
  if (projectedUnderwriting?.longTermGate === 'BLOCKED') {
    addBlocker(blockers, 'INVALID_LONG_TERM_GATE')
  }
  if (projectedUnderwriting?.invalidationRules.some(rule => rule.state === 'UNKNOWN')) {
    addBlocker(blockers, 'UNKNOWN_INVALIDATION_STATE')
  }
  const evaluatedPriceValid = isObject(input.evaluatedPrice) &&
    Number.isFinite(input.evaluatedPrice.value) && input.evaluatedPrice.value > 0 &&
    input.evaluatedPrice.currency === 'USD' && isTimestamp(input.evaluatedPrice.asOf) &&
    isOpaqueRef(input.evaluatedPrice.source) && (!projectedUnderwriting ||
      input.evaluatedPrice.currency === projectedUnderwriting.entryRange.currency)
  if (!evaluatedPriceValid) addBlocker(blockers, 'INVALID_EVALUATED_PRICE')
  const timingShapeValid = TIMING_STATUSES.has(timingAssessment.status) &&
      timingAssessment.status !== 'BLOCKED' &&
      isTimestamp(timingAssessment.asOf) &&
      Array.isArray(timingAssessment.evidenceIds) && timingAssessment.evidenceIds.length > 0 &&
      Array.isArray(timingAssessment.reasonCodes)
  if (!timingShapeValid) {
    addBlocker(blockers, 'INVALID_TIMING_ASSESSMENT')
  }
  const timingIds = timingAssessment.evidenceIds
  const evidenceIds = new Set(projectedEvidence?.items?.map(item => item.id) ?? [])
  const timingEvidenceValid = Array.isArray(timingIds) &&
    new Set(timingIds).size === timingIds.length &&
    timingIds.every(id => isOpaqueRef(id) && evidenceIds.has(id))
  if (!timingEvidenceValid) addBlocker(blockers, 'INVALID_TIMING_EVIDENCE')
  const projectedTimingAssessment = timingShapeValid && timingEvidenceValid
    ? timingAssessmentRecord(timingAssessment)
    : null
  if (!projectedDecisionPolicy ||
      !Number.isFinite(projectedDecisionPolicy.targetPosition) || projectedDecisionPolicy.targetPosition < 0 ||
      !Number.isFinite(projectedDecisionPolicy.pilotPositionLimit) || projectedDecisionPolicy.pilotPositionLimit <= 0 ||
      typeof projectedDecisionPolicy.permitPilotOnEventRisk !== 'boolean' ||
      !Number.isFinite(projectedDecisionPolicy.maxInputAgeMs) || projectedDecisionPolicy.maxInputAgeMs < 0 ||
      !Number.isFinite(projectedDecisionPolicy.maxFutureSkewMs) || projectedDecisionPolicy.maxFutureSkewMs < 0) {
    addBlocker(blockers, 'INVALID_DECISION_POLICY')
  }
  validateTemporalInputs({ ...input, decisionPolicy: projectedDecisionPolicy ?? {} }, blockers)

  return { blockers, projectedEvidence, projectedUnderwriting, projectedDecisionPolicy,
    projectedTimingAssessment, evaluatedPriceValid }
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
  const validation = validateDecisionInputs(input)
  const blockers = validation.blockers
  const canonicalInput = validation.projectedEvidence && validation.projectedUnderwriting &&
    validation.projectedDecisionPolicy && validation.projectedTimingAssessment &&
    validation.evaluatedPriceValid
    ? { ...input, evidence: validation.projectedEvidence,
        underwriting: validation.projectedUnderwriting,
        decisionPolicy: validation.projectedDecisionPolicy,
        timingAssessment: validation.projectedTimingAssessment }
    : { ...input, evidence: validation.projectedEvidence,
        underwriting: validation.projectedUnderwriting,
        decisionPolicy: validation.projectedDecisionPolicy,
        timingAssessment: validation.projectedTimingAssessment,
        evaluatedPrice: null }
  const resolvedSnapshots = validateSnapshotRefs(input, blockers)
  const capacitySummary = projectPortfolioCapacity(
    canonicalInput.portfolioCapacity,
    canonicalInput.research?.symbol,
    resolvedSnapshots,
  )
  if (capacitySummary === null) addBlocker(blockers, 'INVALID_PORTFOLIO_CAPACITY')
  if (blockers.length > 0) return blockedRecord(canonicalInput, blockers)

  const currentWeight = capacitySummary.currentPosition.weight
  const holding = currentWeight > 0
  const positionSizing = positionSizingFor(canonicalInput.decisionPolicy, capacitySummary)

  if (canonicalInput.underwriting.longTermGate === 'FAIL') {
    return prohibitedForHolding(
      canonicalInput, capacitySummary, positionSizing, ['LONG_TERM_GATE_FAILED'],
    )
  }

  const triggeredRules = canonicalInput.underwriting.invalidationRules.filter(
    rule => rule.state === 'TRIGGERED',
  )
  if (triggeredRules.length > 0) {
    const exitReview = triggeredRules.some(rule => rule.severity === 'EXIT_REVIEW')
    return prohibitedForHolding(
      canonicalInput,
      capacitySummary,
      positionSizing,
      ['UNDERWRITING_INVALIDATED'],
      exitReview ? 'EXIT_REVIEW' : 'REVIEW',
    )
  }

  const { value: price } = canonicalInput.evaluatedPrice
  const { lower, upper } = canonicalInput.underwriting.entryRange
  if (price < lower || price > upper) {
    return prohibitedForHolding(
      canonicalInput, capacitySummary, positionSizing, ['PRICE_OUTSIDE_ENTRY_RANGE'],
    )
  }

  if (currentWeight > capacitySummary.effectiveLimit) {
    return validRecord(canonicalInput, capacitySummary, positionSizing, {
      entryStatus: 'PROHIBITED',
      buyAction: 'NO_ACTION',
      holdingRisk: 'REDUCE_REVIEW',
      reasonCodes: ['POSITION_ABOVE_EFFECTIVE_LIMIT'],
    })
  }
  if (capacitySummary.capacityToLimit === 0 || positionSizing.additionalCapacity === 0) {
    return validRecord(canonicalInput, capacitySummary, positionSizing, {
      entryStatus: 'PROHIBITED',
      buyAction: 'NO_ACTION',
      reasonCodes: ['NO_EFFECTIVE_CAPACITY'],
    })
  }

  if (canonicalInput.timingAssessment.status === 'FAIL') {
    return prohibitedForHolding(
      canonicalInput, capacitySummary, positionSizing, ['TIMING_FAILED'],
    )
  }
  if (canonicalInput.timingAssessment.status === 'EVENT_RISK') {
    if (holding || !canonicalInput.decisionPolicy.permitPilotOnEventRisk) {
      return prohibitedForHolding(
        canonicalInput, capacitySummary, positionSizing, ['EVENT_RISK'],
      )
    }
    const pilotSizing = positionSizingFor(
      canonicalInput.decisionPolicy,
      capacitySummary,
      canonicalInput.decisionPolicy.pilotPositionLimit,
    )
    return validRecord(canonicalInput, capacitySummary, pilotSizing, {
      entryStatus: 'PERMITTED',
      buyAction: 'PILOT',
      reasonCodes: ['EVENT_RISK'],
    })
  }

  return validRecord(canonicalInput, capacitySummary, positionSizing, {
    entryStatus: 'PERMITTED',
    buyAction: holding ? 'ADD' : 'OPEN',
    reasonCodes: ['ALL_GATES_PASSED'],
  })
}
