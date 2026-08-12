const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/
const OPAQUE_REF_PATTERN = /^[a-z][a-z0-9-]*:[0-9a-f]{64}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/

const ACTION_LABELS = Object.freeze({
  WATCH: '观察',
  PILOT: '试仓',
  OPEN: '开仓',
  ADD: '增持',
  NO_ACTION: '不操作',
})
const DATA_STATUSES = new Set(['VALID', 'EVALUATION_BLOCKED'])
const ENTRY_STATUSES = new Set(['PERMITTED', 'PROHIBITED'])
const HOLDING_RISKS = new Set(['NONE', 'REVIEW', 'EXIT_REVIEW', 'REDUCE_REVIEW'])
const LONG_TERM_GATES = new Set(['PASS', 'FAIL', 'BLOCKED'])
const TIMING_STATUSES = new Set(['PASS', 'FAIL', 'EVENT_RISK'])
const INVALIDATION_SEVERITIES = new Set(['REVIEW', 'PROHIBIT_ENTRY', 'EXIT_REVIEW'])
const INVALIDATION_STATES = new Set(['TRIGGERED', 'UNTRIGGERED', 'UNKNOWN'])

const RESEARCH_BLOCKER_CODES = [
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
]
const BLOCKER_CODES = new Set([
  ...RESEARCH_BLOCKER_CODES,
  'DUPLICATE_RESOLVED_SNAPSHOT_ID',
  'FUTURE_DECISION_INPUT',
  'FUTURE_EVIDENCE_BUNDLE',
  'INCOHERENT_AS_OF',
  'INVALID_DECISION_INPUT_TIMESTAMP',
  'INVALID_DECISION_POLICY',
  'INVALID_EVALUATED_PRICE',
  'INVALID_EVIDENCE_BUNDLE',
  'INVALID_LONG_TERM_GATE',
  'INVALID_PORTFOLIO_CAPACITY',
  'INVALID_STRUCTURED_UNDERWRITING',
  'INVALID_SYMBOL',
  'INVALID_TIMING_ASSESSMENT',
  'MISSING_RESOLVED_SNAPSHOT',
  'MISSING_RESOLVED_SNAPSHOT_PAYLOAD',
  'MISSING_SNAPSHOT_REFERENCE',
  'RESEARCH_BLOCKED',
  'SNAPSHOT_DIGEST_MISMATCH',
  'SNAPSHOT_IDENTITY_MISMATCH',
  'STALE_DECISION_INPUT',
  'STALE_EVIDENCE_BUNDLE',
  'TIMING_BLOCKED',
  'UNKNOWN_INVALIDATION_STATE',
])
const DECISION_REASON_CODES = new Set([
  'ALL_GATES_PASSED',
  'EVENT_RISK',
  'LONG_TERM_GATE_FAILED',
  'NO_EFFECTIVE_CAPACITY',
  'POSITION_ABOVE_EFFECTIVE_LIMIT',
  'PRICE_OUTSIDE_ENTRY_RANGE',
  'TIMING_FAILED',
  'UNDERWRITING_INVALIDATED',
])
const TIMING_REASON_CODES = new Set([
  'EARNINGS_SOON',
  'TIMING_EVIDENCE_NOT_FRESH',
  'TIMING_FAILED',
  'TIMING_PRICE_CONFLICT',
  'TIMING_PRICE_FUTURE',
  'TIMING_PRICE_MISSING',
  'TIMING_PRICE_STALE',
  'TIMING_RESTRICTED',
  'TIMING_SUPPORT_MISSING',
  'TIMING_SUPPORT_NOT_OBSERVED',
])

const RECORD_KEYS = [
  'schemaVersion',
  'symbol',
  'decidedAt',
  'evaluatedPrice',
  'marketSnapshot',
  'qualitySnapshot',
  'researchSnapshot',
  'underwritingSnapshot',
  'evidence',
  'underwriting',
  'timingAssessment',
  'decisionPolicyRef',
  'dataStatus',
  'entryStatus',
  'blockerCodes',
  'capacitySummary',
  'positionSizing',
  'buyAction',
  'holdingRisk',
  'reasonCodes',
]
const SNAPSHOT_KEYS = ['id', 'version', 'digest']
const VALUATION_KEYS = [
  'low', 'base', 'high', 'currency', 'asOf', 'method', 'evidenceIds', 'uncertainty',
]

class DecisionRecordBatchError extends TypeError {
  constructor() {
    super('Decision record batch is invalid')
    this.code = 'INVALID_DECISION_RECORD_BATCH'
  }
}

function invalid() {
  throw new DecisionRecordBatchError()
}

function object(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegative(value) {
  return finite(value) && value >= 0
}

function positive(value) {
  return finite(value) && value > 0
}

function ratio(value) {
  return nonNegative(value) && value <= 1
}

function text(value) {
  return typeof value === 'string' && value.length > 0
}

function timestamp(value) {
  if (typeof value !== 'string') return false
  const match = UTC_TIMESTAMP_PATTERN.exec(value)
  if (!match) return false
  const milliseconds = (match[2] ?? '').slice(0, 3).padEnd(3, '0')
  const parsed = Date.parse(`${match[1]}.${milliseconds}Z`)
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === match[1]
}

function opaqueRef(value) {
  return typeof value === 'string' && OPAQUE_REF_PATTERN.test(value)
}

function digest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

function uniqueArray(value, validate, { allowEmpty = true } = {}) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) &&
    value.every(validate) && new Set(value).size === value.length
}

function snapshot(value, nullable = true) {
  return (nullable && value === null) ||
    (exact(value, SNAPSHOT_KEYS) && opaqueRef(value.id) &&
      opaqueRef(value.version) && digest(value.digest))
}

function validateValuation(value) {
  return exact(value, VALUATION_KEYS) && positive(value.low) && positive(value.base) &&
    positive(value.high) && value.low <= value.base && value.base <= value.high &&
    value.currency === 'USD' && timestamp(value.asOf) && text(value.method) &&
    uniqueArray(value.evidenceIds, opaqueRef) && text(value.uncertainty)
}

function validateEntryRange(value) {
  return exact(value, [
    'lower', 'upper', 'currency', 'asOf', 'marginOfSafety', 'derivedFrom', 'evidenceIds',
  ]) && positive(value.lower) && positive(value.upper) && value.lower <= value.upper &&
    value.currency === 'USD' && timestamp(value.asOf) && ratio(value.marginOfSafety) &&
    value.marginOfSafety < 1 && validateValuation(value.derivedFrom) &&
    uniqueArray(value.evidenceIds, opaqueRef)
}

function validateUnderwriting(value) {
  if (value === null) return true
  if (!exact(value, [
    'longTermGate', 'evidenceIds', 'valuationRange', 'entryRange', 'invalidationRules',
  ]) || !LONG_TERM_GATES.has(value.longTermGate) ||
      !uniqueArray(value.evidenceIds, opaqueRef) ||
      !Array.isArray(value.invalidationRules)) return false
  if (value.valuationRange !== null && !validateValuation(value.valuationRange)) return false
  if (value.entryRange !== null && !validateEntryRange(value.entryRange)) return false
  return value.invalidationRules.every(rule => exact(rule, [
    'id', 'evidenceIds', 'severity', 'state',
  ]) && opaqueRef(rule.id) && uniqueArray(rule.evidenceIds, opaqueRef) &&
    INVALIDATION_SEVERITIES.has(rule.severity) && INVALIDATION_STATES.has(rule.state)) &&
    new Set(value.invalidationRules.map(rule => rule.id)).size === value.invalidationRules.length
}

function validateEvaluatedPrice(value) {
  return value === null || (exact(value, ['value', 'currency', 'asOf', 'source']) &&
    positive(value.value) && value.currency === 'USD' && timestamp(value.asOf) &&
    opaqueRef(value.source))
}

function validateTiming(value) {
  return value === null || (exact(value, ['status', 'asOf', 'evidenceIds', 'reasonCodes']) &&
    TIMING_STATUSES.has(value.status) && timestamp(value.asOf) &&
    uniqueArray(value.evidenceIds, opaqueRef) &&
    uniqueArray(value.reasonCodes, code => TIMING_REASON_CODES.has(code)))
}

function validateCapacity(value) {
  if (value === null) return true
  return exact(value, [
    'currentPosition', 'effectiveLimit', 'capacityToLimit', 'portfolioSnapshotRef',
    'capacityPolicyRef', 'digests',
  ]) && exact(value.currentPosition, ['weight', 'positionRef']) &&
    ratio(value.currentPosition.weight) && opaqueRef(value.currentPosition.positionRef) &&
    ratio(value.effectiveLimit) && ratio(value.capacityToLimit) &&
    snapshot(value.portfolioSnapshotRef, false) && snapshot(value.capacityPolicyRef, false) &&
    exact(value.digests, ['capacity', 'portfolio', 'capacityPolicy']) &&
    digest(value.digests.capacity) && digest(value.digests.portfolio) &&
    digest(value.digests.capacityPolicy)
}

function validatePositionSizing(value) {
  return value === null || (exact(value, ['targetPosition', 'additionalCapacity']) &&
    ratio(value.targetPosition) && ratio(value.additionalCapacity))
}

function canonicalSymbol(value) {
  if (typeof value !== 'string' || !SYMBOL_PATTERN.test(value)) invalid()
  return value
}

function validateRecord(value) {
  if (!exact(value, RECORD_KEYS) || value.schemaVersion !== 2 || !timestamp(value.decidedAt) ||
      !validateEvaluatedPrice(value.evaluatedPrice) ||
      !snapshot(value.marketSnapshot) || !snapshot(value.qualitySnapshot) ||
      !snapshot(value.researchSnapshot) || !snapshot(value.underwritingSnapshot) ||
      !exact(value.evidence, ['digest', 'refs']) ||
      !(value.evidence.digest === null || digest(value.evidence.digest)) ||
      !uniqueArray(value.evidence.refs, opaqueRef) ||
      !validateUnderwriting(value.underwriting) || !validateTiming(value.timingAssessment) ||
      !snapshot(value.decisionPolicyRef) || !DATA_STATUSES.has(value.dataStatus) ||
      !ENTRY_STATUSES.has(value.entryStatus) ||
      !uniqueArray(value.blockerCodes, code => BLOCKER_CODES.has(code)) ||
      !validateCapacity(value.capacitySummary) || !validatePositionSizing(value.positionSizing) ||
      !Object.hasOwn(ACTION_LABELS, value.buyAction) || !HOLDING_RISKS.has(value.holdingRisk) ||
      !uniqueArray(value.reasonCodes,
        code => DECISION_REASON_CODES.has(code) || BLOCKER_CODES.has(code))) invalid()

  return canonicalSymbol(value.symbol)
}

function copySnapshot(value) {
  return value === null ? null : { id: value.id, version: value.version, digest: value.digest }
}

function copyValuation(value) {
  return value === null ? null : {
    low: value.low,
    base: value.base,
    high: value.high,
    currency: value.currency,
    asOf: value.asOf,
    method: value.method,
    evidenceIds: [...value.evidenceIds],
    uncertainty: value.uncertainty,
  }
}

function copyEntryRange(value) {
  return value === null ? null : {
    lower: value.lower,
    upper: value.upper,
    currency: value.currency,
    asOf: value.asOf,
    marginOfSafety: value.marginOfSafety,
    derivedFrom: copyValuation(value.derivedFrom),
    evidenceIds: [...value.evidenceIds],
  }
}

function projectRecord(source, symbol) {
  const capacity = source.capacitySummary
  return {
    schemaVersion: 2,
    symbol,
    decidedAt: source.decidedAt,
    action: { code: source.buyAction, label: ACTION_LABELS[source.buyAction] },
    dataStatus: source.dataStatus,
    entryStatus: source.entryStatus,
    blocked: source.dataStatus === 'EVALUATION_BLOCKED',
    holdingRisk: source.holdingRisk,
    reasonCodes: [...source.reasonCodes],
    blockerCodes: [...source.blockerCodes],
    evaluatedPrice: source.evaluatedPrice === null ? null : {
      value: source.evaluatedPrice.value,
      currency: source.evaluatedPrice.currency,
      asOf: source.evaluatedPrice.asOf,
      source: source.evaluatedPrice.source,
    },
    underwriting: source.underwriting === null ? null : {
      longTermGate: source.underwriting.longTermGate,
      evidenceIds: [...source.underwriting.evidenceIds],
      valuationRange: copyValuation(source.underwriting.valuationRange),
      entryRange: copyEntryRange(source.underwriting.entryRange),
      invalidationRules: source.underwriting.invalidationRules.map(rule => ({
        id: rule.id,
        evidenceIds: [...rule.evidenceIds],
        severity: rule.severity,
        state: rule.state,
      })),
    },
    timingAssessment: source.timingAssessment === null ? null : {
      status: source.timingAssessment.status,
      asOf: source.timingAssessment.asOf,
      evidenceIds: [...source.timingAssessment.evidenceIds],
      reasonCodes: [...source.timingAssessment.reasonCodes],
    },
    capacitySummary: capacity === null ? null : {
      currentPosition: {
        weight: capacity.currentPosition.weight,
        positionRef: capacity.currentPosition.positionRef,
      },
      effectiveLimit: capacity.effectiveLimit,
      capacityToLimit: capacity.capacityToLimit,
    },
    positionSizing: source.positionSizing === null ? null : {
      targetPosition: source.positionSizing.targetPosition,
      additionalCapacity: source.positionSizing.additionalCapacity,
    },
    provenance: {
      marketSnapshot: copySnapshot(source.marketSnapshot),
      qualitySnapshot: copySnapshot(source.qualitySnapshot),
      researchSnapshot: copySnapshot(source.researchSnapshot),
      underwritingSnapshot: copySnapshot(source.underwritingSnapshot),
      portfolioSnapshot: capacity === null ? null : copySnapshot(capacity.portfolioSnapshotRef),
      capacityPolicy: capacity === null ? null : copySnapshot(capacity.capacityPolicyRef),
      decisionPolicy: copySnapshot(source.decisionPolicyRef),
      evidence: {
        digest: source.evidence.digest,
        refs: [...source.evidence.refs],
      },
      capacityDigests: capacity === null ? null : {
        capacity: capacity.digests.capacity,
        portfolio: capacity.digests.portfolio,
        capacityPolicy: capacity.digests.capacityPolicy,
      },
    },
  }
}

function priority(record) {
  if (record.holdingRisk !== 'NONE') return 0
  if (record.blocked) return 1
  if (['OPEN', 'ADD', 'PILOT'].includes(record.action.code)) return 2
  if (record.action.code === 'WATCH') return 3
  return 4
}

function compareRecords(left, right) {
  const priorityDifference = priority(left) - priority(right)
  if (priorityDifference !== 0) return priorityDifference
  return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function counters(records) {
  const byAction = Object.fromEntries(Object.keys(ACTION_LABELS).map(action => [action, 0]))
  const byStatus = { VALID: 0, EVALUATION_BLOCKED: 0 }
  const byHoldingRisk = Object.fromEntries([...HOLDING_RISKS].map(risk => [risk, 0]))
  for (const record of records) {
    byAction[record.action.code] += 1
    byStatus[record.dataStatus] += 1
    byHoldingRisk[record.holdingRisk] += 1
  }
  return { byAction, byStatus, byHoldingRisk }
}

function safeFileName(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length === 0) invalid()
  const parts = value.replaceAll('\\', '/').split('/')
  return parts.at(-1) || null
}

export function parseDecisionRecordBatch(textValue, options = {}) {
  if (!object(options) ||
      !exact(options, Object.hasOwn(options, 'fileName') ? ['fileName'] : []) ||
      typeof textValue !== 'string' || textValue.length === 0) invalid()
  let source
  try {
    source = JSON.parse(textValue)
  } catch {
    invalid()
  }
  if (!Array.isArray(source) || source.length === 0) invalid()

  const symbols = new Set()
  const records = source.map(record => {
    const symbol = validateRecord(record)
    if (symbols.has(symbol)) invalid()
    symbols.add(symbol)
    return projectRecord(record, symbol)
  }).sort(compareRecords)
  for (const record of records) PROJECTED_RECORDS.add(record)
  const decidedTimes = records.map(record => record.decidedAt).sort()
  const counts = counters(records)
  return deepFreeze({
    fileName: safeFileName(options.fileName),
    records,
    summary: {
      total: records.length,
      byAction: counts.byAction,
      byStatus: counts.byStatus,
      byHoldingRisk: counts.byHoldingRisk,
      decidedAt: {
        earliest: decidedTimes[0],
        latest: decidedTimes.at(-1),
      },
    },
  })
}

const FILTER_KEYS = [
  'query', 'actions', 'dataStatuses', 'timingStatuses', 'holdingRisks',
]
const PROJECTED_RECORDS = new WeakSet()

function selected(value, allowed) {
  if (value === undefined) return null
  if (!uniqueArray(value, item => allowed.has(item))) invalid()
  return new Set(value)
}

export function filterDecisionRecords(records, filters = {}) {
  if (!Array.isArray(records) || !object(filters) ||
      Object.keys(filters).some(key => !FILTER_KEYS.includes(key))) invalid()
  if (filters.query !== undefined && typeof filters.query !== 'string') invalid()
  const query = filters.query === undefined ? '' : filters.query.trim().toUpperCase()
  const actions = selected(filters.actions, new Set(Object.keys(ACTION_LABELS)))
  const statuses = selected(filters.dataStatuses, DATA_STATUSES)
  const timings = selected(filters.timingStatuses, TIMING_STATUSES)
  const risks = selected(filters.holdingRisks, HOLDING_RISKS)
  const canonicalRecords = records.map(record => {
    if (!PROJECTED_RECORDS.has(record)) invalid()
    return record
  })
  const result = canonicalRecords.filter(record =>
    (!query || record.symbol.includes(query)) &&
    (!actions || actions.has(record.action.code)) &&
    (!statuses || statuses.has(record.dataStatus)) &&
    (!timings || timings.has(record.timingAssessment?.status)) &&
    (!risks || risks.has(record.holdingRisk)),
  ).slice().sort(compareRecords)
  return deepFreeze(result)
}
