import { createHash } from 'node:crypto'

import { evaluateWorkbench } from './workbench.js'
import { deriveRobinhoodInputs } from './robinhoodRead.js'

const INPUT_KEYS = [
  'symbol', 'evaluatedAt', 'statArtifact', 'qualityManifest', 'robinhoodRead', 'privateCase',
]
const PRIVATE_CASE_KEYS = [
  'schemaVersion',
  'researchPolicy',
  'sourceSnapshots',
  'evidence',
  'underwriting',
  'timing',
  'capacityPolicy',
  'decisionPolicy',
]
const TIMING_POLICY_KEYS = [
  'schemaVersion',
  'maxQuoteAgeMs',
  'maxFutureSkewMs',
  'earningsRiskWindowDays',
]
const MACHINE_SOURCE_KINDS = new Set([
  'ROBINHOOD_EQUITY_QUOTE',
  'ROBINHOOD_EARNINGS_CALENDAR',
])
const MACHINE_DRAFT_KEYS = new Set([
  'price',
  'market-session',
  'earnings-schedule-known',
  'next-earnings-at',
])
const MACHINE_CLAIMS = new Set([
  'MARKET_PRICE',
  'MARKET_SESSION',
  'EARNINGS_SCHEDULE',
  'PRICE',
])
const MACHINE_FACTS = new Set([
  'CURRENT_PRICE',
  'MARKET_SESSION',
  'EARNINGS_SCHEDULE_KNOWN',
  'NEXT_EARNINGS_AT',
])

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function inputError() {
  const error = new TypeError('Symbol case input is invalid')
  error.code = 'INVALID_SYMBOL_CASE_INPUT'
  return error
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key))
}

function canonicalUtc(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function validTimingPolicy(timing) {
  const policy = timing?.policy
  return object(timing) && Object.keys(timing).length === 1 && object(policy) &&
    hasOnlyKeys(policy, TIMING_POLICY_KEYS) &&
    TIMING_POLICY_KEYS.every(key => Object.hasOwn(policy, key)) &&
    policy.schemaVersion === 2 &&
    Number.isFinite(policy.maxQuoteAgeMs) && policy.maxQuoteAgeMs >= 0 &&
    Number.isFinite(policy.maxFutureSkewMs) && policy.maxFutureSkewMs >= 0 &&
    Number.isInteger(policy.earningsRiskWindowDays) && policy.earningsRiskWindowDays >= 0
}

function usesReservedMachineNamespace(privateCase) {
  const source = Array.isArray(privateCase.sourceSnapshots) &&
    privateCase.sourceSnapshots.some(snapshot =>
      MACHINE_SOURCE_KINDS.has(snapshot?.payload?.kind) ||
      (Array.isArray(snapshot?.payload?.facts) &&
        snapshot.payload.facts.some(fact => MACHINE_FACTS.has(fact?.factKey))))
  const evidenceDraft = Array.isArray(privateCase.evidence?.drafts) &&
    privateCase.evidence.drafts.some(draft =>
      MACHINE_DRAFT_KEYS.has(draft?.key) || MACHINE_CLAIMS.has(draft?.claimKey) ||
      MACHINE_FACTS.has(draft?.factKey))
  const sourcePolicy = object(privateCase.evidence?.sourcePolicy?.kinds) &&
    Object.keys(privateCase.evidence.sourcePolicy.kinds)
      .some(kind => MACHINE_SOURCE_KINDS.has(kind))
  return source || evidenceDraft || sourcePolicy
}

function parseStatArtifact(value, qualityManifest) {
  let stat = {}
  try {
    const parsed = JSON.parse(value)
    if (object(parsed)) stat = parsed
  } catch {
    return { stat, qualityManifest: null }
  }

  const contract = qualityManifest?.statArtifact
  const contractKeys = ['sha256', 'bytes', 'symbols']
  const symbols = Object.keys(stat).length
  const matches = object(contract) && hasOnlyKeys(contract, contractKeys) &&
    contractKeys.every(key => Object.hasOwn(contract, key)) &&
    /^[0-9a-f]{64}$/.test(contract.sha256) &&
    Number.isInteger(contract.bytes) && contract.bytes >= 0 &&
    Number.isInteger(contract.symbols) && contract.symbols >= 0 &&
    contract.sha256 === createHash('sha256').update(value, 'utf8').digest('hex') &&
    contract.bytes === Buffer.byteLength(value, 'utf8') &&
    contract.symbols === symbols && contract.symbols === qualityManifest?.succeeded
  return { stat, qualityManifest: matches ? qualityManifest : null }
}

export function evaluateSymbolCase(input) {
  if (!object(input) || !hasOnlyKeys(input, INPUT_KEYS) ||
      INPUT_KEYS.some(key => !Object.hasOwn(input, key)) ||
      typeof input.statArtifact !== 'string' ||
      !canonicalUtc(input.evaluatedAt) ||
      !object(input.privateCase) || !hasOnlyKeys(input.privateCase, PRIVATE_CASE_KEYS) ||
      !validTimingPolicy(input.privateCase.timing) ||
      usesReservedMachineNamespace(input.privateCase)) {
    throw inputError()
  }

  const source = structuredClone(input)
  const symbol = typeof source.symbol === 'string'
    ? source.symbol.trim().toUpperCase()
    : source.symbol
  const privateCase = source.privateCase
  const parsed = parseStatArtifact(source.statArtifact, source.qualityManifest)
  const evidence = privateCase.evidence

  let robinhood = null
  try {
    robinhood = deriveRobinhoodInputs({
      symbol,
      evaluatedAt: source.evaluatedAt,
      stat: parsed.stat,
      robinhoodRead: source.robinhoodRead,
      capacityPolicy: privateCase.capacityPolicy,
    })
  } catch (error) {
    if (error?.code !== 'INVALID_ROBINHOOD_READ_INPUT') throw error
    robinhood = null
  }

  const canonicalEvidence = robinhood && object(evidence) && object(evidence.sourcePolicy) &&
      object(evidence.sourcePolicy.kinds) && Array.isArray(evidence.drafts)
    ? {
        ...evidence,
        sourcePolicy: {
          ...evidence.sourcePolicy,
          kinds: { ...evidence.sourcePolicy.kinds, ...robinhood.sourceKinds },
        },
        drafts: [...evidence.drafts, ...robinhood.evidenceDrafts],
      }
    : evidence
  const sourceSnapshots = robinhood && Array.isArray(privateCase.sourceSnapshots)
    ? [...privateCase.sourceSnapshots, ...robinhood.sourceSnapshots]
    : privateCase.sourceSnapshots

  return evaluateWorkbench({
    schemaVersion: privateCase.schemaVersion,
    symbol,
    evaluatedAt: source.evaluatedAt,
    research: {
      universe: parsed.stat,
      qualityManifest: parsed.qualityManifest,
      policy: privateCase.researchPolicy,
    },
    sourceSnapshots,
    evidence: canonicalEvidence,
    underwriting: privateCase.underwriting,
    timing: privateCase.timing,
    portfolio: robinhood?.portfolio ?? null,
    decisionPolicy: privateCase.decisionPolicy,
  })
}
