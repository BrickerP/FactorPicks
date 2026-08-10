import {
  createSnapshot,
  digest,
  isSnapshotRef,
  opaqueRef,
  resolvedSnapshotsById,
  sameCanonical,
  snapshotIdentity,
} from './contentAddressing.js'
import { projectEvidenceBundle } from './evidence.js'

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
const OPS = new Set(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'])
const SEVERITIES = new Set(['REVIEW', 'PROHIBIT_ENTRY', 'EXIT_REVIEW'])
const MANUAL = { PENDING: 'UNKNOWN', CONFIRMED: 'TRIGGERED', REJECTED: 'UNTRIGGERED' }

class UnderwritingInputError extends TypeError {
  constructor() {
    super('Structured underwriting input is invalid')
    this.code = 'INVALID_STRUCTURED_UNDERWRITING_INPUT'
  }
}
function fail() { throw new UnderwritingInputError() }
function object(v) { return v !== null && !Array.isArray(v) && typeof v === 'object' }
function text(v) { return typeof v === 'string' && v.length > 0 }
function timestamp(v) { return text(v) && Number.isFinite(Date.parse(v)) }
function decimalParts(value) {
  if (!Number.isFinite(value) || value < 0) fail()
  const [coefficient, exponentText] = String(value).toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  const [whole, fraction = ''] = coefficient.split('.')
  const digits = BigInt(`${whole}${fraction}`)
  const scale = fraction.length - exponent
  return scale >= 0
    ? { digits, denominator: 10n ** BigInt(scale) }
    : { digits: digits * (10n ** BigInt(-scale)), denominator: 1n }
}

function roundUsdWithMargin(value, marginOfSafety) {
  const amount = decimalParts(value)
  const margin = decimalParts(marginOfSafety)
  const factor = margin.denominator - margin.digits
  const numerator = amount.digits * factor * 100n
  const denominator = amount.denominator * margin.denominator
  let cents = numerator / denominator
  if ((numerator % denominator) * 2n >= denominator) cents += 1n
  return Number(cents) / 100
}
function durationMs(value) {
  const match = /^P([1-9]\d*)(D|W|M|Q|Y)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * ({ D: 864e5, W: 6048e5, M: 2592e6, Q: 7776e6, Y: 31536e6 })[match[2]]
}
function compare(value, operator, threshold) {
  if (operator === 'GT') return value > threshold
  if (operator === 'GTE') return value >= threshold
  if (operator === 'LT') return value < threshold
  if (operator === 'LTE') return value <= threshold
  if (operator === 'EQ') return value === threshold
  if (operator === 'NEQ') return value !== threshold
  return false
}
function ancestry(items, ids) {
  const byId = new Map(items.map(item => [item.id, item]))
  const seen = new Set()
  function visit(id) {
    if (seen.has(id)) return []
    seen.add(id)
    const item = byId.get(id)
    if (!item) fail()
    return [item, ...(item.inputIds ?? []).flatMap(visit)]
  }
  return ids.flatMap(visit)
}

function derive(input) {
  if (!object(input) || !SYMBOL.test(input.symbol) || !timestamp(input.evaluatedAt) ||
      !object(input.evidence) || !Array.isArray(input.resolvedSnapshots) ||
      !object(input.valuationDraft) || !object(input.policy) ||
      !Array.isArray(input.invalidationDrafts) || Object.hasOwn(input, 'entryRange')) fail()
  const evidence = projectEvidenceBundle(input.evidence, input.symbol, input.resolvedSnapshots, {
    evaluatedAt: input.evaluatedAt,
  })
  if (!evidence) fail()
  const v = input.valuationDraft
  if (['lower', 'upper', 'derivedFrom'].some(key => Object.hasOwn(v, key)) ||
      ![v.low, v.base, v.high].every(n => Number.isFinite(n) && n > 0) ||
      v.low > v.base || v.base > v.high || v.currency !== 'USD' ||
      v.symbol !== input.symbol || !timestamp(v.asOf) || !text(v.method) ||
      !text(v.uncertainty) || !Array.isArray(v.inputEvidenceKeys) ||
      v.inputEvidenceKeys.length === 0) fail()
  const evidenceByKey = new Map(evidence.items.map(item => [item.claimKey, item]))
  const direct = v.inputEvidenceKeys.map(key => evidenceByKey.get(key) ??
    evidence.items.find(item => item.id === key)).filter(Boolean)
  if (direct.length !== v.inputEvidenceKeys.length) fail()
  const allInputs = ancestry(evidence.items, direct.map(item => item.id))
  if (!allInputs.some(item => item.sourceQuality === 'PRIMARY')) fail()
  if (allInputs.every(item => ['ANALYST_CONSENSUS', 'YAHOO_TARGET'].includes(item.factKey))) fail()
  if (/DCF|DISCOUNTED/i.test(v.method) && direct.some(item => item.derivation !== 'INFERRED')) fail()
  const evidenceIds = direct.map(item => item.id).sort()
  const valuationRange = { low: v.low, base: v.base, high: v.high, currency: 'USD',
    symbol: input.symbol, asOf: v.asOf, method: v.method, evidenceIds, uncertainty: v.uncertainty }
  const mos = input.policy.marginOfSafety
  if (input.policy.schemaVersion !== 1 || !Number.isFinite(mos) || mos < 0 || mos >= 1) fail()
  const entryRange = { lower: roundUsdWithMargin(v.low, mos), upper: roundUsdWithMargin(v.base, mos),
    currency: 'USD', symbol: input.symbol, asOf: v.asOf, marginOfSafety: mos,
    derivedFrom: valuationRange, evidenceIds }

  const rules = input.invalidationDrafts.map(draft => {
    if (!object(draft) || Object.hasOwn(draft, 'state') || !text(draft.key) ||
        !text(draft.condition) || !text(draft.response) || !SEVERITIES.has(draft.severity) ||
        !object(draft.predicate)) fail()
    const p = draft.predicate
    let state
    let observedAt = input.evaluatedAt
    let derivedFromAsOf = input.evaluatedAt
    let ruleEvidenceIds = []
    let manualStatus = 'NOT_REQUIRED'
    if (p.kind === 'MANUAL') {
      if (!Object.hasOwn(MANUAL, draft.manualStatus) ||
          ['metric', 'factKey', 'operator', 'threshold', 'lookback', 'consecutive', 'source', 'unit']
            .some(key => p[key] !== null && p[key] !== undefined)) fail()
      manualStatus = draft.manualStatus
      state = MANUAL[manualStatus]
    } else if (p.kind === 'METRIC') {
      const thresholdValid = Number.isFinite(p.threshold) || text(p.threshold) ||
        (p.threshold === null && ['EQ', 'NEQ'].includes(p.operator))
      if (Object.hasOwn(draft, 'manualStatus') || !text(p.factKey ?? p.metric) ||
          !OPS.has(p.operator) || !thresholdValid ||
          durationMs(p.lookback) === null || !Number.isInteger(p.consecutive) ||
          p.consecutive <= 0 || !text(p.source) || !text(p.unit)) fail()
      const factKey = p.factKey ?? p.metric
      const cutoff = Date.parse(input.evaluatedAt) - durationMs(p.lookback)
      const candidates = evidence.items.filter(item => item.derivation === 'OBSERVED' &&
        item.scope.symbol === input.symbol && item.factKey === factKey &&
        item.unit === p.unit && item.sourceKind === p.source &&
        Date.parse(item.asOf) >= cutoff && Date.parse(item.asOf) <= Date.parse(input.evaluatedAt) &&
        (Number.isFinite(item.value) || typeof item.value === 'string' || item.value === null))
        .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))
      const latest = [...new Map(candidates.map(item => [item.asOf, item])).values()]
        .slice(0, p.consecutive)
      ruleEvidenceIds = latest.map(item => item.id)
      const maxGap = durationMs(p.lookback) / p.consecutive
      const missingPeriod = latest.some((item, index) => index > 0 &&
        Date.parse(latest[index - 1].asOf) - Date.parse(item.asOf) > maxGap)
      const thresholdType = p.threshold === null ? 'null' : typeof p.threshold
      const incompatibleType = latest.some(item =>
        (item.value === null ? 'null' : typeof item.value) !== thresholdType)
      if (latest.length < p.consecutive || missingPeriod || incompatibleType) state = 'UNKNOWN'
      else state = latest.every(item => compare(item.value, p.operator, p.threshold))
        ? 'TRIGGERED' : 'UNTRIGGERED'
      if (latest.length) {
        observedAt = latest.reduce((max, item) => Date.parse(item.observedAt) > Date.parse(max)
          ? item.observedAt : max, latest[0].observedAt)
        derivedFromAsOf = latest.reduce((min, item) => Date.parse(item.asOf) < Date.parse(min)
          ? item.asOf : min, latest[0].asOf)
      }
    } else fail()
    const body = { condition: draft.condition, evidenceIds: ruleEvidenceIds.sort(),
      predicate: { kind: p.kind, metric: p.factKey ?? p.metric ?? null,
        operator: p.operator ?? null, threshold: p.threshold ?? null,
        lookback: p.lookback ?? null, consecutive: p.consecutive ?? null,
        source: p.source ?? null, unit: p.unit ?? null }, manualStatus,
      severity: draft.severity, state, derivedFromAsOf, observedAt, response: draft.response }
    return { id: opaqueRef('rule', digest(body)), ...body }
  }).sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) fail()

  const policyPayload = { role: 'UNDERWRITING_POLICY', kind: 'UNDERWRITING_POLICY',
    schemaVersion: 1, symbol: input.symbol, currency: 'USD', asOf: input.evaluatedAt,
    policy: input.policy }
  const policySnapshot = createSnapshot('underwriting-policy', policyPayload)
  const payload = { role: 'UNDERWRITING', kind: 'STRUCTURED_UNDERWRITING', schemaVersion: 1,
    symbol: input.symbol, currency: 'USD', asOf: input.evaluatedAt,
    evidenceDigest: evidence.digest, evidenceSnapshotRef: evidence.snapshotRef,
    longTermGate: evidence.longTermGate,
    evidenceIds: evidence.gateResults.flatMap(g => g.evidenceIds).sort(),
    valuationRange, entryRange, invalidationRules: rules,
    policyRef: policySnapshot.ref, valuationDraft: input.valuationDraft,
    invalidationDrafts: input.invalidationDrafts }
  const snapshot = createSnapshot('underwriting', payload)
  const underwriting = { schemaVersion: 1, symbol: input.symbol, asOf: input.evaluatedAt,
    snapshotRef: snapshot.ref, policyRef: policySnapshot.ref,
    evidenceSnapshotRef: evidence.snapshotRef, evidenceDigest: evidence.digest,
    longTermGate: payload.longTermGate, evidenceIds: payload.evidenceIds,
    valuationRange, entryRange, invalidationRules: rules }
  return { underwriting, resolvedSnapshots: [policySnapshot.resolved, snapshot.resolved] }
}

export function deriveStructuredUnderwriting(input) { return derive(structuredClone(input)) }

export function projectStructuredUnderwriting(underwriting, expectedSymbol, evidence,
  resolvedSnapshots, context = {}) {
  try {
    if (!object(underwriting) || underwriting.symbol !== expectedSymbol ||
        !isSnapshotRef(underwriting.snapshotRef) || !isSnapshotRef(underwriting.policyRef) ||
        !isSnapshotRef(underwriting.evidenceSnapshotRef)) return null
    const evaluatedAt = context.evaluatedAt ?? underwriting?.asOf
    if (!timestamp(evaluatedAt) || Date.parse(underwriting.asOf) > Date.parse(evaluatedAt)) return null
    const projectedEvidence = projectEvidenceBundle(evidence, expectedSymbol, resolvedSnapshots, {
      ...context,
      evaluatedAt,
    })
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    if (!projectedEvidence || !resolved) return null
    const u = resolved.get(underwriting.snapshotRef.id)
    const p = resolved.get(underwriting.policyRef.id)
    if (!u || !p || !sameCanonical(createSnapshot('underwriting', u.payload).resolved, u) ||
        !sameCanonical(createSnapshot('underwriting-policy', p.payload).resolved, p)) return null
    const payload = u.payload
    const rebuilt = derive({ symbol: expectedSymbol, evaluatedAt: payload.asOf,
      evidence: projectedEvidence, resolvedSnapshots: [...resolved.values()],
      valuationDraft: payload.valuationDraft, policy: p.payload.policy,
      invalidationDrafts: payload.invalidationDrafts }).underwriting
    const expected = { schemaVersion: 1, symbol: expectedSymbol, asOf: payload.asOf,
      snapshotRef: snapshotIdentity(underwriting.snapshotRef),
      policyRef: snapshotIdentity(underwriting.policyRef),
      evidenceSnapshotRef: snapshotIdentity(underwriting.evidenceSnapshotRef),
      evidenceDigest: projectedEvidence.digest, longTermGate: payload.longTermGate,
      evidenceIds: payload.evidenceIds, valuationRange: payload.valuationRange,
      entryRange: payload.entryRange, invalidationRules: payload.invalidationRules }
    if (!sameCanonical(underwriting, expected) || !sameCanonical(underwriting, rebuilt) ||
        !sameCanonical(payload.policyRef, underwriting.policyRef) ||
        !sameCanonical(payload.evidenceSnapshotRef, underwriting.evidenceSnapshotRef) ||
        payload.evidenceDigest !== projectedEvidence.digest) return null
    const mos = p.payload?.policy?.marginOfSafety
    if (!Number.isFinite(mos) || mos < 0 || mos >= 1 ||
        payload.entryRange.lower !== roundUsdWithMargin(payload.valuationRange.low, mos) ||
        payload.entryRange.upper !== roundUsdWithMargin(payload.valuationRange.base, mos) ||
        !sameCanonical(payload.entryRange.derivedFrom, payload.valuationRange)) return null
    return expected
  } catch { return null }
}
