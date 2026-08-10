import {
  createSnapshot,
  sameCanonical,
} from './contentAddressing.js'
import { evaluateResearch } from './evaluateResearch.js'
import { deriveEvidenceBundle } from './evidence.js'
import { deriveStructuredUnderwriting } from './structuredUnderwriting.js'
import { deriveTimingAssessment } from './timingAssessment.js'
import { derivePortfolioCapacitySnapshot } from './portfolioCapacity.js'
import { evaluateDecision } from './evaluateDecision.js'

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
const FORBIDDEN_TOP_LEVEL = [
  'buyAction',
  'evaluatedPrice',
  'portfolioCapacity',
  'timingAssessment',
  'decisionRecord',
  'resolvedSnapshots',
  'timingPolicy',
  'positionSizing',
  'capacitySummary',
  'decisionPolicyRef',
  'marketSnapshot',
  'qualitySnapshot',
  'researchSnapshot',
  'underwritingSnapshot',
  'evidenceSnapshot',
  'universe',
  'qualityManifest',
  'policy',
]
const FORBIDDEN_RESEARCH = [
  'dataStatus',
  'blockers',
  'blockerCodes',
  'marketSnapshot',
  'qualitySnapshot',
  'researchSnapshot',
  'metrics',
  'groups',
  'compositeScore',
  'coverage',
  'asOf',
  'snapshotRef',
  'digest',
]
const FORBIDDEN_EVIDENCE = [
  'items',
  'snapshotRef',
  'digest',
  'evidenceIds',
  'longTermGate',
  'gateResults',
  'sourcePolicyRef',
  'gatePolicyRef',
  'resolvedSnapshots',
]
const FORBIDDEN_UNDERWRITING = [
  'snapshotRef',
  'policyRef',
  'evidenceSnapshotRef',
  'evidenceDigest',
  'entryRange',
  'valuationRange',
  'invalidationRules',
  'longTermGate',
  'evidenceIds',
  'resolvedSnapshots',
]
const FORBIDDEN_TIMING = [
  'status',
  'evaluatedPrice',
  'evidenceIds',
  'snapshotRef',
  'timingPolicyRef',
  'evidenceSnapshotRef',
  'evidenceDigest',
  'priceEvidenceId',
  'reasonCodes',
]
const FORBIDDEN_PORTFOLIO = [
  'portfolioSnapshotRef',
  'capacityPolicyRef',
  'denominator',
  'currentPosition',
  'hardLimits',
  'remainingCapacity',
  'effectiveLimit',
  'capacityToLimit',
  'digests',
  'snapshotRef',
  'portfolioCapacity',
  'positionSizing',
]
const FORBIDDEN_DECISION_POLICY = [
  'ref',
  'snapshotRef',
  'decisionRecord',
  'buyAction',
  'positionSizing',
]
const FORBIDDEN_VALUATION_DRAFT = [
  'snapshotRef',
  'evidenceIds',
  'entryRange',
  'valuationRange',
  'derivedFrom',
]
const FORBIDDEN_INVALIDATION_DRAFT = [
  'id',
  'state',
  'evidenceIds',
  'observedAt',
  'derivedFromAsOf',
]
const FORBIDDEN_TIMING_POLICY = [
  'status',
  'evaluatedPrice',
  'snapshotRef',
  'evidenceIds',
  'reasonCodes',
  'requirePassSupport',
  'freshnessPolicy',
  'priceFactKey',
  'claimKeys',
  'claims',
  'factKeys',
  'facts',
]
const FORBIDDEN_EVIDENCE_DRAFT = [
  'id',
  'sourceQuality',
  'derivation',
  'materiality',
  'gate',
  'observedAt',
  'evidenceIds',
]
const FORBIDDEN_PORTFOLIO_FACTS = [
  'positionRef',
  'denominator',
  'exposures',
  'snapshotRef',
  'digest',
]
const FORBIDDEN_PORTFOLIO_POLICY = [
  'snapshotRef',
  'capacityPolicyRef',
  'digest',
]

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function canonicalSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value
}

function inputError(message = 'Workbench input is invalid') {
  const error = new TypeError(message)
  error.code = 'INVALID_WORKBENCH_INPUT'
  return error
}

function rejectFields(value, fields, message) {
  if (!object(value)) return
  if (fields.some(field => Object.hasOwn(value, field))) throw inputError(message)
}

function rejectDerivedInput(source) {
  rejectFields(source, FORBIDDEN_TOP_LEVEL, 'Derived workbench fields are not accepted')
  if (Object.hasOwn(source, 'researchPolicy') ||
      Object.hasOwn(source, 'portfolioFacts') || Object.hasOwn(source, 'capacityPolicy') ||
      Object.hasOwn(source, 'capacityFreshnessPolicy') || Object.hasOwn(source, 'liquidity') ||
      Object.hasOwn(source, 'sources') || Object.hasOwn(source, 'resolvedSourceSnapshots')) {
    throw inputError('Workbench input shape is not canonical')
  }
  rejectFields(source.research, FORBIDDEN_RESEARCH,
    'Derived research fields are not accepted')
  if (object(source.research?.policy) && Object.hasOwn(source.research.policy, 'research')) {
    throw inputError('Research policy input must not be nested')
  }
  rejectFields(source.evidence, FORBIDDEN_EVIDENCE, 'Derived evidence is not accepted')
  rejectFields(source.underwriting, FORBIDDEN_UNDERWRITING,
    'Derived underwriting is not accepted')
  rejectFields(source.timing, FORBIDDEN_TIMING, 'Derived timing is not accepted')
  rejectFields(source.timing?.policy, FORBIDDEN_TIMING_POLICY,
    'Derived timing policy fields are not accepted')
  rejectFields(source.portfolio, FORBIDDEN_PORTFOLIO,
    'Derived portfolio capacity is not accepted')
  rejectFields(source.decisionPolicy, FORBIDDEN_DECISION_POLICY,
    'Derived decision policy is not accepted')
  rejectFields(source.underwriting?.valuationDraft, FORBIDDEN_VALUATION_DRAFT,
    'Derived valuation fields are not accepted')
  if (Array.isArray(source.underwriting?.invalidationDrafts)) {
    for (const draft of source.underwriting.invalidationDrafts) {
      rejectFields(draft, FORBIDDEN_INVALIDATION_DRAFT,
        'Derived invalidation fields are not accepted')
    }
  }
  if (Array.isArray(source.evidence?.drafts)) {
    for (const draft of source.evidence.drafts) {
      rejectFields(draft, FORBIDDEN_EVIDENCE_DRAFT,
        'Derived evidence draft fields are not accepted')
    }
  }
  rejectFields(source.portfolio?.portfolio, FORBIDDEN_PORTFOLIO_FACTS,
    'Derived portfolio fact fields are not accepted')
  rejectFields(source.portfolio?.policy, FORBIDDEN_PORTFOLIO_POLICY,
    'Derived portfolio policy fields are not accepted')
  if (object(source.timing) &&
      (Object.keys(source.timing).length !== 1 || !Object.hasOwn(source.timing, 'policy'))) {
    throw inputError('Timing input must contain only policy')
  }
}

function sourceResolvedSnapshots(input) {
  if (!Array.isArray(input.sourceSnapshots)) return []
  const seen = new Set()
  return input.sourceSnapshots.map(snapshot => {
    if (!object(snapshot) || !object(snapshot.payload) ||
        typeof snapshot.id !== 'string' || typeof snapshot.version !== 'string' ||
        snapshot.payload.role !== 'SOURCE' || snapshot.payload.schemaVersion !== 1 ||
        !Array.isArray(snapshot.payload.facts)) {
      const error = new TypeError('Source snapshots are not resolved')
      error.code = 'INVALID_SOURCE_SNAPSHOT'
      throw error
    }
    if (seen.has(snapshot.id)) {
      const error = new TypeError('Duplicate source snapshot reference')
      error.code = 'DUPLICATE_SOURCE_SNAPSHOT'
      throw error
    }
    seen.add(snapshot.id)
    return snapshot
  })
}

function mergeSnapshots(...groups) {
  const byId = new Map()
  for (const group of groups) {
    for (const snapshot of Array.isArray(group) ? group : []) {
      if (!object(snapshot) || typeof snapshot.id !== 'string') continue
      const previous = byId.get(snapshot.id)
      if (previous && !sameCanonical(previous, snapshot)) {
        const error = new TypeError('Resolved snapshot identity conflict')
        error.code = 'SNAPSHOT_IDENTITY_CONFLICT'
        throw error
      }
      byId.set(snapshot.id, snapshot)
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function createResearchSnapshots({ symbol, evaluatedAt, universe, qualityManifest, research }) {
  const market = createSnapshot('market', {
    role: 'MARKET_DATA',
    kind: 'MARKET_DATA_SNAPSHOT',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: evaluatedAt,
    universe,
  })
  const quality = createSnapshot('quality', {
    role: 'QUALITY_MANIFEST',
    kind: 'QUALITY_MANIFEST',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: qualityManifest?.generatedAt ?? evaluatedAt,
    manifest: qualityManifest,
  })
  const researchSnapshot = createSnapshot('research', {
    role: 'RESEARCH',
    kind: 'FUNDAMENTAL_RESEARCH',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: research?.asOf ?? evaluatedAt,
    research: structuredClone(research),
  })
  return { market, quality, research: researchSnapshot }
}

function createDecisionPolicySnapshot(symbol, evaluatedAt, value) {
  if (!object(value)) {
    const error = new TypeError('Decision policy input is invalid')
    error.code = 'INVALID_DECISION_POLICY'
    throw error
  }
  rejectFields(value, FORBIDDEN_DECISION_POLICY, 'Derived decision policy is not accepted')
  const payload = {
    role: 'DECISION_POLICY',
    kind: 'DECISION_POLICY',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: evaluatedAt,
    policy: { ...value },
  }
  return createSnapshot('decision-policy', payload)
}

function asResearchInput(input, symbol, evaluatedAt) {
  const raw = input.research
  const universe = raw?.universe
  const qualityManifest = raw?.qualityManifest
  const researchPolicy = raw?.policy
  if (!object(raw) || !object(universe) || !object(qualityManifest) ||
      !object(researchPolicy)) {
    const error = new TypeError('Research input is invalid')
    error.code = 'INVALID_RESEARCH_INPUT'
    throw error
  }
  return {
    universe,
    qualityManifest,
    policy: { research: researchPolicy },
    symbol,
    now: evaluatedAt,
  }
}

function asCapacityInput(input, symbol, evaluatedAt) {
  const raw = input.portfolio
  if (!object(raw) || !object(raw.portfolio) || !object(raw.policy) ||
      !object(raw.liquidity) || !object(raw.freshnessPolicy)) {
    const error = new TypeError('Portfolio input is invalid')
    error.code = 'INVALID_PORTFOLIO_CAPACITY_INPUT'
    throw error
  }
  return {
    symbol,
    evaluatedAt,
    portfolio: raw.portfolio,
    policy: raw.policy,
    liquidity: raw.liquidity,
    freshnessPolicy: raw.freshnessPolicy,
  }
}

function asEvidenceInput(input, symbol, evaluatedAt, sourceSnapshots) {
  const raw = input.evidence
  if (!object(raw) || !object(raw.freshnessPolicy) || !object(raw.sourcePolicy) ||
      !object(raw.gatePolicy) || !Array.isArray(raw.drafts)) {
    const error = new TypeError('Evidence input is invalid')
    error.code = 'INVALID_EVIDENCE_INPUT'
    throw error
  }
  return { ...raw, symbol, evaluatedAt, resolvedSnapshots: sourceSnapshots }
}

function asUnderwritingInput(input, symbol, evaluatedAt, evidence, resolvedSnapshots) {
  const raw = input.underwriting
  if (!object(raw) || !object(raw.valuationDraft) || !object(raw.policy) ||
      !Array.isArray(raw.invalidationDrafts)) {
    const error = new TypeError('Structured underwriting input is invalid')
    error.code = 'INVALID_STRUCTURED_UNDERWRITING_INPUT'
    throw error
  }
  return {
    symbol,
    evaluatedAt,
    evidence,
    resolvedSnapshots,
    valuationDraft: raw.valuationDraft,
    policy: raw.policy,
    invalidationDrafts: raw.invalidationDrafts,
  }
}

function asTimingInput(input, symbol, evaluatedAt, evidence, resolvedSnapshots) {
  const raw = input.timing
  if (!object(raw) || !object(raw.policy)) {
    const error = new TypeError('Timing policy input is invalid')
    error.code = 'INVALID_TIMING_ASSESSMENT_INPUT'
    throw error
  }
  return { symbol, evaluatedAt, evidence, resolvedSnapshots, policy: raw.policy }
}

function runStage(callback) {
  try {
    return callback()
  } catch (error) {
    if (error?.code === 'INVALID_WORKBENCH_INPUT') throw error
    return null
  }
}

function safeMerge(...groups) {
  return runStage(() => mergeSnapshots(...groups)) ?? []
}

function blockedResearch(symbol, evaluatedAt, blocker = 'INVALID_RESEARCH_INPUT') {
  return {
    schemaVersion: 1,
    symbol,
    asOf: evaluatedAt,
    dataStatus: 'EVALUATION_BLOCKED',
    blockers: [{ code: blocker }],
    blockerCodes: [blocker],
    marketSnapshot: null,
    qualitySnapshot: null,
    researchSnapshot: null,
  }
}

export function evaluateWorkbench(input) {
  if (!object(input)) throw inputError()
  const source = structuredClone(input)
  const symbol = canonicalSymbol(source.symbol)
  const evaluatedAt = source.evaluatedAt
  if (source.schemaVersion !== 1 || !SYMBOL.test(symbol ?? '') || !timestamp(evaluatedAt)) {
    throw inputError()
  }
  rejectDerivedInput(source)

  let research = null
  let researchSnapshots = null
  const rawResearch = runStage(() => asResearchInput(source, symbol, evaluatedAt))
  if (rawResearch) {
    research = runStage(() => evaluateResearch(rawResearch))
    if (research) research.blockerCodes = Array.isArray(research.blockers)
      ? research.blockers.map(blocker => blocker?.code).filter(Boolean)
      : []
    if (research) researchSnapshots = runStage(() => createResearchSnapshots({
      symbol,
      evaluatedAt,
      universe: rawResearch.universe,
      qualityManifest: rawResearch.qualityManifest,
      research,
    }))
  }
  if (!research) research = blockedResearch(symbol, evaluatedAt)
  if (!Object.hasOwn(research, 'blockerCodes')) research.blockerCodes = Array.isArray(research.blockers)
    ? research.blockers.map(blocker => blocker?.code).filter(Boolean)
    : []
  if (researchSnapshots) {
    research.marketSnapshot = researchSnapshots.market.ref
    research.qualitySnapshot = researchSnapshots.quality.ref
    research.researchSnapshot = researchSnapshots.research.ref
  }

  const sourceSnapshots = runStage(() => sourceResolvedSnapshots(source)) ?? []
  const evidenceSeed = runStage(() => asEvidenceInput(source, symbol, evaluatedAt, sourceSnapshots))
  const evidenceDerived = evidenceSeed ? runStage(() => deriveEvidenceBundle(evidenceSeed)) : null
  const evidenceResolved = safeMerge(sourceSnapshots, evidenceDerived?.resolvedSnapshots)

  const underwritingSeed = evidenceDerived
    ? runStage(() => asUnderwritingInput(source, symbol, evaluatedAt,
      evidenceDerived.evidence, evidenceResolved))
    : null
  const underwritingDerived = underwritingSeed
    ? runStage(() => deriveStructuredUnderwriting(underwritingSeed)) : null
  const underwritingResolved = safeMerge(evidenceResolved, underwritingDerived?.resolvedSnapshots)

  const timingSeed = evidenceDerived
    ? runStage(() => asTimingInput(source, symbol, evaluatedAt,
      evidenceDerived.evidence, underwritingResolved))
    : null
  const timingDerived = timingSeed ? runStage(() => deriveTimingAssessment(timingSeed)) : null
  const timingResolved = safeMerge(underwritingResolved, timingDerived?.resolvedSnapshots)

  const capacitySeed = runStage(() => asCapacityInput(source, symbol, evaluatedAt))
  const capacityDerived = capacitySeed
    ? runStage(() => derivePortfolioCapacitySnapshot(capacitySeed)) : null
  const capacityResolved = safeMerge(timingResolved, capacityDerived?.resolvedSnapshots)

  const decisionPolicySnapshot = runStage(() => createDecisionPolicySnapshot(
    symbol, evaluatedAt, source.decisionPolicy,
  ))
  const resolvedSnapshots = safeMerge(
    capacityResolved,
    researchSnapshots
      ? [researchSnapshots.market.resolved, researchSnapshots.quality.resolved,
          researchSnapshots.research.resolved]
      : [],
    decisionPolicySnapshot ? [decisionPolicySnapshot.resolved] : [],
  )
  const decisionPolicy = decisionPolicySnapshot
    ? { ...source.decisionPolicy, ref: decisionPolicySnapshot.ref }
    : null

  return evaluateDecision({
    research,
    evaluatedPrice: timingDerived?.evaluatedPrice ?? null,
    evidence: evidenceDerived?.evidence ?? null,
    underwriting: underwritingDerived?.underwriting ?? null,
    timingAssessment: timingDerived?.timingAssessment ?? null,
    portfolioCapacity: capacityDerived?.portfolioCapacity ?? null,
    decisionPolicy,
    resolvedSnapshots,
    now: evaluatedAt,
  })
}
