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
const TIMING_REASON_CODES = new Set([
  'TIMING_PRICE_MISSING',
  'TIMING_PRICE_CONFLICT',
  'TIMING_PRICE_STALE',
  'TIMING_PRICE_FUTURE',
  'TIMING_EVIDENCE_NOT_FRESH',
  'TIMING_SUPPORT_MISSING',
  'TIMING_SUPPORT_NOT_OBSERVED',
  'TIMING_FAILED',
  'EARNINGS_SOON',
])
const POLICY_KEYS = [
  'schemaVersion',
  'currentPriceFactKey',
  'passClaimKey',
  'failClaimKey',
  'eventRiskClaimKey',
  'maxAgeMs',
  'maxFutureSkewMs',
  'eventRiskReasonCode',
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

function canonicalSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value
}

function normalizePolicy(value) {
  if (!object(value) || Object.keys(value).some(key => !POLICY_KEYS.includes(key)) ||
      POLICY_KEYS.some(key => !Object.hasOwn(value, key))) fail()
  const policy = value
  if (policy.schemaVersion !== 1 ||
      !text(policy.currentPriceFactKey) || !text(policy.passClaimKey) ||
      !text(policy.failClaimKey) || !text(policy.eventRiskClaimKey) ||
      new Set([policy.passClaimKey, policy.failClaimKey, policy.eventRiskClaimKey]).size !== 3 ||
      !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
      !Number.isFinite(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0 ||
      !TIMING_REASON_CODES.has(policy.eventRiskReasonCode)) fail()
  return {
    schemaVersion: 1,
    currentPriceFactKey: policy.currentPriceFactKey,
    passClaimKey: policy.passClaimKey,
    failClaimKey: policy.failClaimKey,
    eventRiskClaimKey: policy.eventRiskClaimKey,
    maxAgeMs: policy.maxAgeMs,
    maxFutureSkewMs: policy.maxFutureSkewMs,
    eventRiskReasonCode: policy.eventRiskReasonCode,
  }
}

function fresh(value, evaluatedAt, policy) {
  if (!timestamp(value) || !timestamp(evaluatedAt)) return 'INVALID'
  const age = Date.parse(evaluatedAt) - Date.parse(value)
  if (age > policy.maxAgeMs) return 'STALE'
  if (age < -policy.maxFutureSkewMs) return 'FUTURE'
  return 'VALID'
}

function timingPolicyPayload(symbol, asOf, policy) {
  return {
    role: 'TIMING_POLICY',
    kind: 'TIMING_POLICY',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf,
    policy,
  }
}

function timingPayloadFrom(assessment) {
  return {
    schemaVersion: 1,
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

function assertTimingClaimsAreIndependent(evidence, resolvedSnapshots, policy) {
  const resolved = resolvedSnapshotsById(resolvedSnapshots)
  const gatePolicy = resolved?.get(evidence.gatePolicyRef?.id)?.payload
  if (!object(gatePolicy) || gatePolicy.role !== 'GATE_POLICY' ||
      gatePolicy.kind !== 'GATE_POLICY' || gatePolicy.schemaVersion !== 1 ||
      !object(gatePolicy.policy) || !Array.isArray(gatePolicy.policy.gates)) fail()
  const gateClaims = new Set(gatePolicy.policy.gates.map(gate => gate?.claimKey))
  const timingClaims = [policy.passClaimKey, policy.failClaimKey, policy.eventRiskClaimKey]
  if (timingClaims.some(claimKey => gateClaims.has(claimKey))) fail()
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
  assertTimingClaimsAreIndependent(projectedEvidence, resolvedSnapshots, normalizedPolicy)
  const items = projectedEvidence.items
  const effectivePolicy = {
    ...normalizedPolicy,
    maxAgeMs: Number.isFinite(freshnessContext.maxInputAgeMs)
      ? Math.min(normalizedPolicy.maxAgeMs, freshnessContext.maxInputAgeMs)
      : normalizedPolicy.maxAgeMs,
    maxFutureSkewMs: Number.isFinite(freshnessContext.maxFutureSkewMs)
      ? Math.min(normalizedPolicy.maxFutureSkewMs, freshnessContext.maxFutureSkewMs)
      : normalizedPolicy.maxFutureSkewMs,
  }
  const relevant = items.filter(item =>
    item.claimKey === normalizedPolicy.passClaimKey ||
    item.claimKey === normalizedPolicy.failClaimKey ||
    item.claimKey === normalizedPolicy.eventRiskClaimKey ||
    item.factKey === normalizedPolicy.currentPriceFactKey)
  const evidenceIds = [...new Set(relevant.map(item => item.id))].sort()
  const priceCandidates = items.filter(item => item.factKey === normalizedPolicy.currentPriceFactKey)
  const prices = priceCandidates.filter(item =>
    item.derivation === 'OBSERVED' && item.sourceRef &&
    item.scope?.symbol === symbol && item.currency === 'USD' &&
    Number.isFinite(item.value) && item.value > 0)
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
        [normalizedPolicy.passClaimKey, normalizedPolicy.failClaimKey,
          normalizedPolicy.eventRiskClaimKey].includes(item.claimKey) &&
        (item.derivation !== 'OBSERVED' || !item.sourceRef))) {
        reasonCodes = ['TIMING_SUPPORT_NOT_OBSERVED']
      } else {
        const passSupport = items.some(item =>
          item.derivation === 'OBSERVED' && item.sourceRef &&
          item.claimKey === normalizedPolicy.passClaimKey && item.stance === 'SUPPORTS')
        const passChallenge = items.some(item =>
          item.derivation === 'OBSERVED' && item.sourceRef &&
          (item.claimKey === normalizedPolicy.passClaimKey ||
            item.claimKey === normalizedPolicy.failClaimKey) && item.stance === 'CHALLENGES')
        const failSupport = items.some(item =>
          item.derivation === 'OBSERVED' && item.sourceRef &&
          item.claimKey === normalizedPolicy.failClaimKey && item.stance === 'SUPPORTS')
        const eventRisk = items.some(item =>
          item.derivation === 'OBSERVED' && item.sourceRef &&
          item.claimKey === normalizedPolicy.eventRiskClaimKey && item.stance === 'SUPPORTS')
        if (passChallenge || failSupport) {
          status = 'FAIL'
          reasonCodes = ['TIMING_FAILED']
        } else if (!passSupport) {
          reasonCodes = ['TIMING_SUPPORT_MISSING']
        } else if (eventRisk) {
          status = 'EVENT_RISK'
          reasonCodes = [normalizedPolicy.eventRiskReasonCode]
        } else {
          status = 'PASS'
        }
      }
    }
  }
  const assessment = {
    schemaVersion: 1,
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
        payload.schemaVersion !== 1 || payload.symbol !== symbol || payload.evidenceDigest !== timingAssessment.evidenceDigest ||
        !sameCanonical(payload.evidenceSnapshotRef, timingAssessment.evidenceSnapshotRef) ||
        !sameCanonical(payload.timingPolicyRef, timingAssessment.timingPolicyRef)) return null
    if (policyResolved.payload.role !== 'TIMING_POLICY' ||
        policyResolved.payload.kind !== 'TIMING_POLICY' || policyResolved.payload.schemaVersion !== 1 ||
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
      maxAgeMs: context.maxInputAgeMs ?? normalizedPolicy.maxAgeMs,
      maxFutureSkewMs: context.maxFutureSkewMs ?? normalizedPolicy.maxFutureSkewMs,
    })
    if (freshness !== 'VALID') return null
    return expected
  } catch {
    return null
  }
}
