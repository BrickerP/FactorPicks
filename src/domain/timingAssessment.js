import {
  createSnapshot,
  digest,
  isDigest,
  isSnapshotRef,
  resolvedSnapshotsById,
  sameCanonical,
  snapshotIdentity,
} from './contentAddressing.js'
import { projectEvidenceBundle } from './evidence.js'

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
const STATUSES = new Set(['PASS', 'FAIL', 'EVENT_RISK', 'BLOCKED'])
const PRICE_CLAIM = 'MARKET_PRICE'
const PRICE_FACT = 'CURRENT_PRICE'
const SESSION_CLAIM = 'MARKET_SESSION'
const SESSION_FACT = 'MARKET_SESSION'
const EARNINGS_CLAIM = 'EARNINGS_SCHEDULE'
const EARNINGS_KNOWN_FACT = 'EARNINGS_SCHEDULE_KNOWN'
const NEXT_EARNINGS_FACT = 'NEXT_EARNINGS_AT'
const QUOTE_SOURCE_KIND = 'ROBINHOOD_EQUITY_QUOTE'
const EARNINGS_SOURCE_KIND = 'ROBINHOOD_EARNINGS_CALENDAR'
const MILLIS_PER_DAY = 86_400_000
const NEW_YORK_DATE = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const NEW_YORK_SESSION = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const RFC3339_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const POLICY_KEYS = [
  'schemaVersion',
  'maxQuoteAgeMs',
  'maxFutureSkewMs',
  'earningsRiskWindowDays',
]
const INPUT_KEYS = [
  'symbol',
  'evaluatedAt',
  'evidence',
  'resolvedSnapshots',
  'policy',
]

class TimingAssessmentInputError extends TypeError {
  constructor() {
    super('Timing assessment input is invalid')
    this.code = 'INVALID_TIMING_ASSESSMENT_INPUT'
  }
}

function fail() {
  throw new TimingAssessmentInputError()
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.length > 0
}

function timestamp(value) {
  return text(value) && Number.isFinite(Date.parse(value))
}

function epochNanoseconds(value) {
  if (!timestamp(value)) return null
  const match = RFC3339_PATTERN.exec(value)
  if (!match) return BigInt(Date.parse(value)) * NANOSECONDS_PER_MILLISECOND
  const fraction = match[2] ?? ''
  const milliseconds = fraction.slice(0, 3).padEnd(3, '0')
  const parsed = Date.parse(`${match[1]}.${milliseconds}${match[3]}`)
  if (!Number.isFinite(parsed)) return null
  const fractionNanoseconds = BigInt(fraction.padEnd(9, '0') || '0')
  const parsedMilliseconds = BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND
  return BigInt(parsed) * NANOSECONDS_PER_MILLISECOND +
    fractionNanoseconds - parsedMilliseconds
}

function fractionalNanoseconds(value) {
  const match = RFC3339_PATTERN.exec(value)
  return BigInt((match?.[2] ?? '').padEnd(9, '0') || '0')
}

function canonicalSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function newYorkDate(value) {
  const parts = Object.fromEntries(NEW_YORK_DATE.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function isRegularSession(value) {
  if (!timestamp(value)) return false
  const parts = Object.fromEntries(NEW_YORK_SESSION.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) return false
  const secondOfDay = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60) +
    Number(parts.second)
  const nanosecondsOfDay = BigInt(secondOfDay) * 1_000_000_000n + fractionalNanoseconds(value)
  return nanosecondsOfDay >= 34_200n * 1_000_000_000n &&
    nanosecondsOfDay <= 57_600n * 1_000_000_000n
}

function nextEarnings(value, evaluatedAt, riskWindowDays) {
  if (!object(value) || !sameCanonical(Object.keys(value).sort(), ['date', 'timing', 'verified']) ||
      !dateOnly(value.date) || !['am', 'pm', null].includes(value.timing) ||
      typeof value.verified !== 'boolean') return null
  const today = newYorkDate(evaluatedAt)
  const daysUntil = (Date.parse(`${value.date}T00:00:00.000Z`) -
    Date.parse(`${today}T00:00:00.000Z`)) / MILLIS_PER_DAY
  if (!Number.isInteger(daysUntil) || daysUntil < 0) return null
  return { daysUntil, withinRiskWindow: daysUntil <= riskWindowDays }
}

function normalizePolicy(value) {
  if (!object(value) || Object.keys(value).some(key => !POLICY_KEYS.includes(key)) ||
      POLICY_KEYS.some(key => !Object.hasOwn(value, key))) fail()
  const policy = value
  if (policy.schemaVersion !== 2 ||
      !Number.isFinite(policy.maxQuoteAgeMs) || policy.maxQuoteAgeMs < 0 ||
      !Number.isFinite(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0 ||
      !Number.isInteger(policy.earningsRiskWindowDays) || policy.earningsRiskWindowDays < 0) fail()
  return {
    schemaVersion: 2,
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    maxFutureSkewMs: policy.maxFutureSkewMs,
    earningsRiskWindowDays: policy.earningsRiskWindowDays,
  }
}

function fresh(value, evaluatedAt, policy) {
  const valueNanoseconds = epochNanoseconds(value)
  const evaluatedNanoseconds = epochNanoseconds(evaluatedAt)
  if (valueNanoseconds === null || evaluatedNanoseconds === null ||
      !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
      !Number.isFinite(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0) return 'INVALID'
  const age = evaluatedNanoseconds - valueNanoseconds
  const maxAge = BigInt(Math.round(policy.maxAgeMs * 1_000_000))
  const maxFutureSkew = BigInt(Math.round(policy.maxFutureSkewMs * 1_000_000))
  if (age > maxAge) return 'STALE'
  if (age < -maxFutureSkew) return 'FUTURE'
  return 'VALID'
}

function timingPolicyPayload(symbol, asOf, policy) {
  return {
    role: 'TIMING_POLICY',
    kind: 'TIMING_POLICY',
    schemaVersion: 2,
    symbol,
    currency: 'USD',
    asOf,
    policy,
  }
}

function timingPayloadFrom(assessment) {
  return {
    schemaVersion: 2,
    symbol: assessment.symbol,
    asOf: assessment.asOf,
    status: assessment.status,
    priceEvidenceId: assessment.priceEvidenceId,
    evidenceIds: assessment.evidenceIds,
    reasonCodes: assessment.reasonCodes,
    evidenceSnapshotRef: snapshotIdentity(assessment.evidenceSnapshotRef),
    evidenceDigest: assessment.evidenceDigest,
    timingPolicyRef: snapshotIdentity(assessment.timingPolicyRef),
  }
}

function assertTimingClaimsAreIndependent(evidence, resolvedSnapshots) {
  const resolved = resolvedSnapshotsById(resolvedSnapshots)
  const gatePolicy = resolved?.get(evidence.gatePolicyRef?.id)?.payload
  if (!object(gatePolicy) || gatePolicy.role !== 'GATE_POLICY' ||
      gatePolicy.kind !== 'GATE_POLICY' || gatePolicy.schemaVersion !== 1 ||
      !object(gatePolicy.policy) || !Array.isArray(gatePolicy.policy.gates)) fail()
  const gateClaims = new Set(gatePolicy.policy.gates.map(gate => gate?.claimKey))
  const timingClaims = [SESSION_CLAIM, EARNINGS_CLAIM]
  if (timingClaims.some(claimKey => gateClaims.has(claimKey))) fail()
}

function observed(item, {
  claimKey,
  factKey,
  sourceKind,
  symbol,
  value,
}) {
  return item.derivation === 'OBSERVED' && text(item.sourceRef) &&
    item.sourceKind === sourceKind && item.claimKey === claimKey &&
    item.factKey === factKey && item.scope?.symbol === symbol &&
    item.stance === 'SUPPORTS' &&
    (value === undefined || sameCanonical(item.value, value))
}

function derivedAssessment({
  symbol, evaluatedAt, evidence, resolvedSnapshots, policy, freshnessContext = {},
}) {
  if (!object(evidence) || !Array.isArray(resolvedSnapshots) || !timestamp(evaluatedAt) ||
      !SYMBOL.test(symbol)) fail()
  const normalizedPolicy = normalizePolicy(policy)
  const projectedEvidence = projectEvidenceBundle(evidence, symbol, resolvedSnapshots, {
    ...freshnessContext,
    evaluatedAt,
  })
  if (!projectedEvidence) fail()
  const policySnapshot = createSnapshot(
    'timing-policy',
    timingPolicyPayload(symbol, evaluatedAt, normalizedPolicy),
  )
  assertTimingClaimsAreIndependent(projectedEvidence, resolvedSnapshots)
  const items = projectedEvidence.items
  const effectivePolicy = {
    ...normalizedPolicy,
    maxAgeMs: Number.isFinite(freshnessContext.maxInputAgeMs)
      ? Math.min(normalizedPolicy.maxQuoteAgeMs, freshnessContext.maxInputAgeMs)
      : normalizedPolicy.maxQuoteAgeMs,
    maxFutureSkewMs: Number.isFinite(freshnessContext.maxFutureSkewMs)
      ? Math.min(normalizedPolicy.maxFutureSkewMs, freshnessContext.maxFutureSkewMs)
      : normalizedPolicy.maxFutureSkewMs,
  }
  const relevant = items.filter(item =>
    [PRICE_CLAIM, SESSION_CLAIM, EARNINGS_CLAIM]
      .includes(item.claimKey) ||
    [PRICE_FACT, SESSION_FACT, EARNINGS_KNOWN_FACT, NEXT_EARNINGS_FACT]
      .includes(item.factKey))
  const evidenceIds = [...new Set(relevant.map(item => item.id))].sort()
  const priceCandidates = relevant.filter(item =>
    item.claimKey === PRICE_CLAIM || item.factKey === PRICE_FACT)
  const prices = priceCandidates.filter(item => observed(item, {
    claimKey: PRICE_CLAIM,
    factKey: PRICE_FACT,
    sourceKind: QUOTE_SOURCE_KIND,
    symbol,
  }) && item.currency === 'USD' && Number.isFinite(item.value) && item.value > 0)
  const sessionCandidates = relevant.filter(item =>
    item.claimKey === SESSION_CLAIM || item.factKey === SESSION_FACT)
  const sessions = sessionCandidates.filter(item => observed(item, {
    claimKey: SESSION_CLAIM,
    factKey: SESSION_FACT,
    sourceKind: QUOTE_SOURCE_KIND,
    symbol,
  }) && ['REGULAR', 'EXTENDED'].includes(item.value))
  const scheduleCandidates = relevant.filter(item =>
    item.factKey === EARNINGS_KNOWN_FACT ||
    (item.claimKey === EARNINGS_CLAIM && item.factKey !== NEXT_EARNINGS_FACT))
  const schedules = scheduleCandidates.filter(item => observed(item, {
    claimKey: EARNINGS_CLAIM,
    factKey: EARNINGS_KNOWN_FACT,
    sourceKind: EARNINGS_SOURCE_KIND,
    symbol,
    value: true,
  }))
  const nextCandidates = relevant.filter(item => item.factKey === NEXT_EARNINGS_FACT)
  const nextEvents = nextCandidates.filter(item => observed(item, {
    claimKey: EARNINGS_CLAIM,
    factKey: NEXT_EARNINGS_FACT,
    sourceKind: EARNINGS_SOURCE_KIND,
    symbol,
  }))
  let status = 'BLOCKED'
  let reasonCodes = []
  let priceEvidence = null
  if (prices.length !== 1 || priceCandidates.length !== 1) {
    reasonCodes = [prices.length === 0 ? 'TIMING_PRICE_MISSING' : 'TIMING_PRICE_CONFLICT']
  } else {
    priceEvidence = prices[0]
    const priceFreshness = [priceEvidence.asOf, priceEvidence.observedAt]
      .map(value => fresh(value, evaluatedAt, effectivePolicy))
    if (priceFreshness.some(value => value !== 'VALID')) {
      const invalid = priceFreshness.find(value => value !== 'VALID')
      reasonCodes = [`TIMING_PRICE_${invalid}`]
      priceEvidence = null
    } else {
      const relevantFreshness = relevant
        .filter(item => item.id !== priceEvidence.id)
        .flatMap(item => [item.asOf, item.observedAt]
          .map(value => fresh(value, evaluatedAt, effectivePolicy)))
      if (relevantFreshness.includes('INVALID') || relevantFreshness.includes('STALE') ||
          relevantFreshness.includes('FUTURE')) {
        reasonCodes = ['TIMING_EVIDENCE_NOT_FRESH']
      } else if (relevant.some(item =>
        [SESSION_CLAIM, EARNINGS_CLAIM]
          .includes(item.claimKey) &&
        (item.derivation !== 'OBSERVED' || !item.sourceRef))) {
        reasonCodes = ['TIMING_SESSION_NOT_OBSERVED']
      } else {
        const challenge = relevant.some(item =>
          [SESSION_CLAIM, EARNINGS_CLAIM].includes(item.claimKey) &&
          item.stance === 'CHALLENGES')
        if (challenge) {
          status = 'FAIL'
          reasonCodes = ['TIMING_FAILED']
        } else if (!isRegularSession(evaluatedAt) || !isRegularSession(priceEvidence.asOf)) {
          reasonCodes = ['TIMING_MARKET_CLOSED']
        } else if (sessionCandidates.length === 0) {
          reasonCodes = ['TIMING_SESSION_MISSING']
        } else if (sessionCandidates.length !== 1 || sessions.length !== 1) {
          reasonCodes = [sessions.length === 0
            ? 'TIMING_SESSION_NOT_OBSERVED'
            : 'TIMING_SESSION_CONFLICT']
        } else if (sessions[0].value !== 'REGULAR') {
          reasonCodes = ['TIMING_MARKET_CLOSED']
        } else if (sessions[0].sourceRef !== priceEvidence.sourceRef ||
            sessions[0].asOf !== priceEvidence.asOf ||
            sessions[0].observedAt !== priceEvidence.observedAt) {
          reasonCodes = ['TIMING_SESSION_CONFLICT']
        } else if (scheduleCandidates.length === 0) {
          reasonCodes = ['TIMING_EARNINGS_MISSING']
        } else if (scheduleCandidates.length !== 1 || schedules.length !== 1) {
          reasonCodes = [schedules.length === 0
            ? 'TIMING_EARNINGS_NOT_OBSERVED'
            : 'TIMING_EARNINGS_CONFLICT']
        } else if (nextCandidates.length > 1 || nextEvents.length !== nextCandidates.length ||
            nextEvents.some(item => item.sourceRef !== schedules[0].sourceRef ||
              item.asOf !== schedules[0].asOf || item.observedAt !== schedules[0].observedAt)) {
          reasonCodes = ['TIMING_EARNINGS_CONFLICT']
        } else if (nextEvents.length === 1) {
          const event = nextEarnings(
            nextEvents[0].value,
            evaluatedAt,
            normalizedPolicy.earningsRiskWindowDays,
          )
          if (!event) {
            reasonCodes = ['TIMING_EARNINGS_NOT_OBSERVED']
          } else if (event.withinRiskWindow) {
            status = 'EVENT_RISK'
            reasonCodes = ['EARNINGS_SOON']
          } else {
            status = 'PASS'
          }
        } else {
          status = 'PASS'
        }
      }
    }
  }
  const assessment = {
    schemaVersion: 2,
    symbol,
    asOf: priceEvidence?.asOf ?? evaluatedAt,
    status,
    priceEvidenceId: priceEvidence?.id ?? null,
    evidenceIds,
    reasonCodes,
    evidenceSnapshotRef: snapshotIdentity(evidence.snapshotRef),
    evidenceDigest: evidence.digest,
    timingPolicyRef: policySnapshot.ref,
  }
  const payload = {
    role: 'TIMING_ASSESSMENT',
    kind: 'TIMING_ASSESSMENT',
    ...timingPayloadFrom(assessment),
  }
  const snapshot = createSnapshot('timing-assessment', payload)
  assessment.snapshotRef = snapshot.ref
  const evaluatedPrice = priceEvidence
    ? {
        value: priceEvidence.value,
        currency: 'USD',
        asOf: priceEvidence.asOf,
        source: priceEvidence.id,
      }
    : null
  return {
    timingAssessment: assessment,
    evaluatedPrice,
    resolvedSnapshots: [policySnapshot.resolved, snapshot.resolved],
  }
}

export function deriveTimingAssessment(input) {
  const source = structuredClone(input)
  const symbol = canonicalSymbol(source?.symbol)
  if (!object(source) || Object.keys(source).some(key => !INPUT_KEYS.includes(key)) ||
      !Object.hasOwn(source, 'policy')) fail()
  return derivedAssessment({
    ...source,
    symbol,
  })
}

export function projectTimingAssessment(
  timingAssessment,
  expectedSymbol,
  evidence,
  resolvedSnapshots,
  context = {},
) {
  try {
    const symbol = canonicalSymbol(expectedSymbol)
    if (!object(timingAssessment) || !SYMBOL.test(symbol) || timingAssessment.symbol !== symbol ||
        !isSnapshotRef(timingAssessment.snapshotRef) ||
        !isSnapshotRef(timingAssessment.timingPolicyRef) ||
        !isSnapshotRef(timingAssessment.evidenceSnapshotRef) ||
        !isDigest(timingAssessment.evidenceDigest) || !STATUSES.has(timingAssessment.status) ||
        !timestamp(timingAssessment.asOf)) return null
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    if (!resolved) return null
    const timingResolved = resolved.get(timingAssessment.snapshotRef.id)
    const policyResolved = resolved.get(timingAssessment.timingPolicyRef.id)
    if (!timingResolved || !policyResolved ||
        timingResolved.version !== timingAssessment.snapshotRef.version ||
        policyResolved.version !== timingAssessment.timingPolicyRef.version ||
        digest(timingResolved.payload) !== timingAssessment.snapshotRef.digest ||
        digest(policyResolved.payload) !== timingAssessment.timingPolicyRef.digest ||
        !sameCanonical(createSnapshot('timing-assessment', timingResolved.payload).resolved, timingResolved) ||
        !sameCanonical(createSnapshot('timing-policy', policyResolved.payload).resolved, policyResolved)) {
      return null
    }
    const payload = timingResolved.payload
    if (payload.role !== 'TIMING_ASSESSMENT' || payload.kind !== 'TIMING_ASSESSMENT' ||
        payload.schemaVersion !== 2 || payload.symbol !== symbol || payload.evidenceDigest !== timingAssessment.evidenceDigest ||
        !sameCanonical(payload.evidenceSnapshotRef, timingAssessment.evidenceSnapshotRef) ||
        !sameCanonical(payload.timingPolicyRef, timingAssessment.timingPolicyRef)) return null
    if (policyResolved.payload.role !== 'TIMING_POLICY' ||
        policyResolved.payload.kind !== 'TIMING_POLICY' || policyResolved.payload.schemaVersion !== 2 ||
        policyResolved.payload.symbol !== symbol || policyResolved.payload.currency !== 'USD' ||
        !timestamp(policyResolved.payload.asOf) || !object(policyResolved.payload.policy)) return null
    const normalizedPolicy = normalizePolicy(policyResolved.payload.policy)
    if (!sameCanonical(policyResolved.payload.policy, normalizedPolicy)) return null
    const evaluatedAt = context.evaluatedAt ?? payload.asOf
    if (!timestamp(evaluatedAt) || policyResolved.payload.asOf !== evaluatedAt) return null
    if (!sameCanonical(timingAssessment.evidenceSnapshotRef, evidence.snapshotRef) ||
        timingAssessment.evidenceDigest !== evidence.digest) return null
    const projected = derivedAssessment({
      symbol,
      evaluatedAt,
      evidence,
      resolvedSnapshots: [...resolved.values()],
      policy: normalizedPolicy,
      freshnessContext: {
        maxInputAgeMs: context.maxInputAgeMs,
        maxFutureSkewMs: context.maxFutureSkewMs,
      },
    })
    const expected = {
      timingAssessment: projected.timingAssessment,
      evaluatedPrice: projected.evaluatedPrice,
    }
    if (projected.timingAssessment.asOf !== timingAssessment.asOf ||
        (projected.evaluatedPrice &&
          projected.evaluatedPrice.asOf !== projected.timingAssessment.asOf) ||
        !sameCanonical(timingAssessment, expected.timingAssessment) ||
        !sameCanonical(payload, {
          role: 'TIMING_ASSESSMENT',
          kind: 'TIMING_ASSESSMENT',
          ...timingPayloadFrom(expected.timingAssessment),
        })) return null
    const freshness = fresh(expected.timingAssessment.asOf, evaluatedAt, {
      maxAgeMs: Math.min(
        context.maxInputAgeMs ?? normalizedPolicy.maxQuoteAgeMs,
        normalizedPolicy.maxQuoteAgeMs,
      ),
      maxFutureSkewMs: context.maxFutureSkewMs ?? normalizedPolicy.maxFutureSkewMs,
    })
    if (freshness !== 'VALID') return null
    return expected
  } catch {
    return null
  }
}
