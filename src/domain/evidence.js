import {
  canonicalize,
  createSnapshot,
  digest,
  isSnapshotRef,
  resolvedSnapshotsById,
  sameCanonical,
  snapshotIdentity,
} from './contentAddressing.js'

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
const STANCES = new Set(['SUPPORTS', 'CHALLENGES'])
const QUALITIES = new Set(['PRIMARY', 'SECONDARY'])

class EvidenceInputError extends TypeError {
  constructor() {
    super('Evidence input is invalid')
    this.code = 'INVALID_EVIDENCE_INPUT'
  }
}

function fail() { throw new EvidenceInputError() }
function object(value) { return value !== null && !Array.isArray(value) && typeof value === 'object' }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function text(value) { return typeof value === 'string' && value.length > 0 }
function allowedDraft(draft) {
  return !['sourceQuality', 'derivation', 'materiality', 'gate', 'id', 'observedAt']
    .some(key => Object.hasOwn(draft, key))
}
function scopeKey(scope) { return canonicalize(scope) }
function exactFact(fact, draft) {
  return fact.factKey === draft.factKey && sameCanonical(fact.value, draft.value) &&
    fact.asOf === draft.asOf && sameCanonical(fact.scope, draft.scope) &&
    (fact.unit ?? null) === (draft.unit ?? null) &&
    (fact.currency ?? null) === (draft.currency ?? null)
}
function freshness(asOf, evaluatedAt, policy) {
  if (!timestamp(asOf) || !timestamp(evaluatedAt) ||
      !Number.isFinite(policy?.maxAgeMs) || policy.maxAgeMs < 0 ||
      !Number.isFinite(policy?.maxFutureSkewMs) || policy.maxFutureSkewMs < 0) fail()
  const age = Date.parse(evaluatedAt) - Date.parse(asOf)
  if (age > policy.maxAgeMs || age < -policy.maxFutureSkewMs) fail()
}

function policyPayload(role, symbol, asOf, policy) {
  return { role, kind: role, schemaVersion: 1, symbol, currency: 'USD', asOf, policy }
}

export function classifyEvidenceFreshness(evidence, resolvedSnapshots, context = {}) {
  try {
    if (!object(evidence) || !timestamp(context.evaluatedAt)) return 'INVALID'
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    const payload = resolved?.get(evidence.snapshotRef?.id)?.payload
    const policy = payload?.freshnessPolicy
    if (!object(payload) || !object(policy) || !Array.isArray(payload.items) ||
        !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
        !Number.isFinite(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0) return 'INVALID'
    const contextMaxAge = context.maxInputAgeMs ?? policy.maxAgeMs
    const contextFutureSkew = context.maxFutureSkewMs ?? policy.maxFutureSkewMs
    if (!Number.isFinite(contextMaxAge) || contextMaxAge < 0 ||
        !Number.isFinite(contextFutureSkew) || contextFutureSkew < 0) return 'INVALID'
    const maxAgeMs = Math.min(policy.maxAgeMs, contextMaxAge)
    const maxFutureSkewMs = Math.min(policy.maxFutureSkewMs, contextFutureSkew)
    const values = [payload.asOf, ...payload.items.flatMap(item => [item.asOf, item.observedAt])]
    let future = false
    for (const value of values) {
      if (!timestamp(value)) return 'INVALID'
      const age = Date.parse(context.evaluatedAt) - Date.parse(value)
      if (age > maxAgeMs) return 'STALE'
      if (age < -maxFutureSkewMs) future = true
    }
    if (Date.parse(payload.asOf) > Date.parse(context.evaluatedAt)) future = true
    return future ? 'FUTURE' : 'VALID'
  } catch { return 'INVALID' }
}

function derive(input) {
  if (!object(input) || !SYMBOL.test(input.symbol) || !timestamp(input.evaluatedAt) ||
      !object(input.freshnessPolicy) || !object(input.sourcePolicy) ||
      !object(input.gatePolicy) || !Array.isArray(input.drafts)) fail()
  const symbol = input.symbol
  const resolved = resolvedSnapshotsById(input.resolvedSnapshots)
  if (!resolved) fail()
  const sourceKinds = input.sourcePolicy.kinds
  const gates = input.gatePolicy.gates
  if (input.sourcePolicy.schemaVersion !== 1 || !object(sourceKinds) ||
      input.gatePolicy.schemaVersion !== 1 || !Array.isArray(gates) || gates.length === 0) fail()
  for (const quality of Object.values(sourceKinds)) if (!QUALITIES.has(quality)) fail()
  for (const kind of ['ANALYST_CONSENSUS', 'YAHOO_TARGET']) {
    if (Object.hasOwn(sourceKinds, kind) && sourceKinds[kind] !== 'SECONDARY') fail()
  }

  const sourceById = new Map()
  for (const [id, snapshot] of resolved) {
    const payload = snapshot?.payload
    if (!object(payload) || payload.role !== 'SOURCE' || payload.schemaVersion !== 1) continue
    const expectedSource = createSnapshot('source', payload)
    if (!sameCanonical(expectedSource.resolved, snapshot)) fail()
    if (payload.symbol !== symbol || !SYMBOL.test(payload.symbol) ||
        !text(payload.kind) || !QUALITIES.has(sourceKinds[payload.kind]) ||
        !timestamp(payload.asOf) || !timestamp(payload.observedAt) ||
        !Array.isArray(payload.facts) ||
        !['USD', null, undefined].includes(payload.currency)) fail()
    freshness(payload.asOf, input.evaluatedAt, input.freshnessPolicy)
    freshness(payload.observedAt, input.evaluatedAt, input.freshnessPolicy)
    if (Date.parse(payload.observedAt) < Date.parse(payload.asOf)) fail()
    sourceById.set(id, payload)
  }

  const drafts = new Map()
  for (const draft of input.drafts) {
    if (!object(draft) || !allowedDraft(draft) || !text(draft.key) || drafts.has(draft.key) ||
        !text(draft.claimKey) || !text(draft.factKey) || !STANCES.has(draft.stance) ||
        !Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1 ||
        !object(draft.scope) || draft.scope.symbol !== symbol || !timestamp(draft.asOf)) fail()
    freshness(draft.asOf, input.evaluatedAt, input.freshnessPolicy)
    drafts.set(draft.key, draft)
  }

  const visiting = new Set()
  const built = new Map()
  function build(key) {
    if (built.has(key)) return built.get(key)
    if (visiting.has(key)) fail()
    const draft = drafts.get(key)
    if (!draft) fail()
    visiting.add(key)
    const inputKeys = draft.inputKeys ?? []
    let derivation
    let sourceQuality
    let sourceKind = null
    let inputIds = []
    let observedAt
    if (text(draft.sourceRef)) {
      if (inputKeys.length) fail()
      const source = sourceById.get(draft.sourceRef)
      const fact = source?.facts.find(candidate => exactFact(candidate, draft))
      if (!source || !fact) fail()
      derivation = 'OBSERVED'
      sourceQuality = sourceKinds[source.kind]
      sourceKind = source.kind
      observedAt = fact.observedAt ?? source.observedAt
    } else {
      if (!Array.isArray(inputKeys) || inputKeys.length === 0 || new Set(inputKeys).size !== inputKeys.length) fail()
      const parents = inputKeys.map(build)
      if (parents.some(parent => scopeKey(parent.scope) !== scopeKey(draft.scope) ||
          Date.parse(draft.asOf) < Date.parse(parent.asOf))) fail()
      derivation = 'INFERRED'
      sourceQuality = parents.some(parent => parent.sourceQuality === 'PRIMARY') ? 'PRIMARY' : 'SECONDARY'
      inputIds = parents.map(parent => parent.id).sort()
      observedAt = parents.reduce((latest, parent) =>
        Date.parse(parent.observedAt) > Date.parse(latest) ? parent.observedAt : latest,
      parents[0].observedAt)
    }
    const body = {
      claimKey: draft.claimKey,
      factKey: draft.factKey,
      value: draft.value,
      sourceRef: draft.sourceRef ?? null,
      observedAt,
      asOf: draft.asOf,
      scope: draft.scope,
      stance: draft.stance,
      sourceQuality,
      sourceKind,
      derivation,
      confidence: draft.confidence,
      unit: draft.unit ?? null,
      currency: draft.currency ?? null,
      inputIds,
    }
    if (!timestamp(body.observedAt) || Date.parse(body.observedAt) < Date.parse(body.asOf)) fail()
    freshness(body.observedAt, input.evaluatedAt, input.freshnessPolicy)
    const item = { id: `evidence:${digest(body).slice(7)}`, ...body }
    visiting.delete(key)
    built.set(key, item)
    return item
  }
  const items = [...drafts.keys()].map(build).sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(items.map(item => item.id)).size !== items.length) fail()

  const conflicts = new Map()
  for (const item of items.filter(item => item.derivation === 'OBSERVED')) {
    const key = canonicalize([item.factKey, item.asOf, item.scope, item.unit, item.currency])
    const value = canonicalize(item.value)
    if (conflicts.has(key) && conflicts.get(key) !== value) fail()
    conflicts.set(key, value)
  }

  const gateResults = gates.map(gate => {
    if (!object(gate) || !text(gate.gateId) || !text(gate.claimKey) ||
        !['MATERIAL', 'NON_MATERIAL'].includes(gate.materiality) ||
        typeof gate.required !== 'boolean') fail()
    const applicable = items.filter(item => item.claimKey === gate.claimKey)
    const challenges = applicable.filter(item => item.stance === 'CHALLENGES')
    const supports = applicable.filter(item => item.stance === 'SUPPORTS')
    let status = 'PASS'
    if (gate.materiality === 'MATERIAL' && challenges.length) status = 'FAIL'
    else if (gate.materiality === 'MATERIAL' && gate.required && supports.length === 0) status = 'BLOCKED'
    return { gateId: gate.gateId, claimKey: gate.claimKey, materiality: gate.materiality,
      required: gate.required, status, evidenceIds: applicable.map(item => item.id).sort() }
  }).sort((a, b) => a.gateId.localeCompare(b.gateId))
  const longTermGate = gateResults.some(g => g.status === 'FAIL') ? 'FAIL'
    : gateResults.some(g => g.status === 'BLOCKED') ? 'BLOCKED' : 'PASS'

  const sourcePolicySnapshot = createSnapshot('source-policy',
    policyPayload('SOURCE_POLICY', symbol, input.evaluatedAt, input.sourcePolicy))
  const gatePolicySnapshot = createSnapshot('gate-policy',
    policyPayload('GATE_POLICY', symbol, input.evaluatedAt, input.gatePolicy))
  const evidencePayload = {
    role: 'EVIDENCE', kind: 'EVIDENCE_BUNDLE', schemaVersion: 1, symbol,
    currency: 'USD', asOf: input.evaluatedAt, items, gateResults, longTermGate,
    sourcePolicyRef: sourcePolicySnapshot.ref, gatePolicyRef: gatePolicySnapshot.ref,
    freshnessPolicy: input.freshnessPolicy,
    drafts: input.drafts,
  }
  const evidenceSnapshot = createSnapshot('evidence', evidencePayload)
  const evidence = {
    schemaVersion: 1, symbol, asOf: input.evaluatedAt,
    digest: digest(items), items, gateResults, longTermGate,
    snapshotRef: evidenceSnapshot.ref,
    sourcePolicyRef: sourcePolicySnapshot.ref,
    gatePolicyRef: gatePolicySnapshot.ref,
  }
  return { evidence, resolvedSnapshots: [sourcePolicySnapshot.resolved,
    gatePolicySnapshot.resolved, evidenceSnapshot.resolved] }
}

export function deriveEvidenceBundle(input) {
  return derive(structuredClone(input))
}

export function projectEvidenceBundle(evidence, expectedSymbol, resolvedSnapshots, context = {}) {
  try {
    if (!object(evidence) || evidence.symbol !== expectedSymbol || !SYMBOL.test(expectedSymbol) ||
        !isSnapshotRef(evidence.snapshotRef) || !isSnapshotRef(evidence.sourcePolicyRef) ||
        !isSnapshotRef(evidence.gatePolicyRef)) return null
    const resolved = resolvedSnapshotsById(resolvedSnapshots)
    if (!resolved) return null
    const evidenceResolved = resolved.get(evidence.snapshotRef.id)
    const sourcePolicyResolved = resolved.get(evidence.sourcePolicyRef.id)
    const gatePolicyResolved = resolved.get(evidence.gatePolicyRef.id)
    const expectedEvidenceSnapshot = evidenceResolved && createSnapshot('evidence', evidenceResolved.payload)
    const expectedSourcePolicySnapshot = sourcePolicyResolved && createSnapshot('source-policy', sourcePolicyResolved.payload)
    const expectedGatePolicySnapshot = gatePolicyResolved && createSnapshot('gate-policy', gatePolicyResolved.payload)
    if (!evidenceResolved || !sourcePolicyResolved || !gatePolicyResolved ||
        evidenceResolved.version !== evidence.snapshotRef.version ||
        sourcePolicyResolved.version !== evidence.sourcePolicyRef.version ||
        gatePolicyResolved.version !== evidence.gatePolicyRef.version ||
        digest(evidenceResolved.payload) !== evidence.snapshotRef.digest ||
        digest(sourcePolicyResolved.payload) !== evidence.sourcePolicyRef.digest ||
        digest(gatePolicyResolved.payload) !== evidence.gatePolicyRef.digest ||
        !sameCanonical(expectedEvidenceSnapshot.ref, evidence.snapshotRef) ||
        !sameCanonical(expectedSourcePolicySnapshot.ref, evidence.sourcePolicyRef) ||
        !sameCanonical(expectedGatePolicySnapshot.ref, evidence.gatePolicyRef)) return null
    const payload = evidenceResolved.payload
    const evaluatedAt = context.evaluatedAt ?? payload.asOf
    if (classifyEvidenceFreshness(evidence, resolvedSnapshots, {
      ...context,
      evaluatedAt,
    }) !== 'VALID') return null
    const rebuilt = derive({
      symbol: expectedSymbol,
      evaluatedAt: payload.asOf,
      freshnessPolicy: payload.freshnessPolicy,
      sourcePolicy: sourcePolicyResolved.payload.policy,
      gatePolicy: gatePolicyResolved.payload.policy,
      drafts: payload.drafts,
      resolvedSnapshots: [...resolved.values()].filter(item => item?.payload?.role === 'SOURCE'),
    }).evidence
    const expected = {
      schemaVersion: 1, symbol: expectedSymbol, asOf: payload.asOf,
      digest: digest(payload.items), items: payload.items, gateResults: payload.gateResults,
      longTermGate: payload.longTermGate, snapshotRef: snapshotIdentity(evidence.snapshotRef),
      sourcePolicyRef: snapshotIdentity(evidence.sourcePolicyRef),
      gatePolicyRef: snapshotIdentity(evidence.gatePolicyRef),
    }
    if (!sameCanonical(evidence, expected) || !sameCanonical(evidence, rebuilt) ||
        !sameCanonical(payload.sourcePolicyRef, evidence.sourcePolicyRef) ||
        !sameCanonical(payload.gatePolicyRef, evidence.gatePolicyRef)) return null
    return expected
  } catch { return null }
}
