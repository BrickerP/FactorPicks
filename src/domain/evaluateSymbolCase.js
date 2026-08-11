import { createHash } from 'node:crypto'

import { createSnapshot } from './contentAddressing.js'
import { evaluateWorkbench } from './workbench.js'
import { deriveRobinhoodPortfolioInput } from './robinhoodPortfolio.js'

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

function usesReservedPriceNamespace(privateCase) {
  const sourceFact = Array.isArray(privateCase.sourceSnapshots) &&
    privateCase.sourceSnapshots.some(snapshot =>
      Array.isArray(snapshot?.payload?.facts) &&
      snapshot.payload.facts.some(fact => fact?.factKey === 'CURRENT_PRICE'))
  const evidenceDraft = Array.isArray(privateCase.evidence?.drafts) &&
    privateCase.evidence.drafts.some(draft =>
      draft?.key === 'price' || draft?.claimKey === 'PRICE' ||
      draft?.factKey === 'CURRENT_PRICE')
  return sourceFact || evidenceDraft
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

function yahooPriceSource(symbol, row) {
  if (!object(row) || !Number.isFinite(row.Close) ||
      !canonicalUtc(row.asOf) || !canonicalUtc(row.observedAt) ||
      row.currency !== 'USD') return null

  return createSnapshot('source', {
    role: 'SOURCE',
    kind: 'YAHOO_MARKET_DATA',
    schemaVersion: 1,
    symbol,
    currency: row.currency,
    asOf: row.asOf,
    observedAt: row.observedAt,
    facts: [{
      factKey: 'CURRENT_PRICE',
      value: row.Close,
      asOf: row.asOf,
      scope: { symbol },
      currency: row.currency,
    }],
  })
}

export function evaluateSymbolCase(input) {
  if (!object(input) || !hasOnlyKeys(input, INPUT_KEYS) ||
      INPUT_KEYS.some(key => !Object.hasOwn(input, key)) ||
      typeof input.statArtifact !== 'string' ||
      !canonicalUtc(input.evaluatedAt) ||
      !object(input.privateCase) || !hasOnlyKeys(input.privateCase, PRIVATE_CASE_KEYS) ||
      input.privateCase?.timing?.policy?.currentPriceFactKey !== 'CURRENT_PRICE' ||
      usesReservedPriceNamespace(input.privateCase)) {
    throw inputError()
  }

  const source = structuredClone(input)
  const symbol = typeof source.symbol === 'string'
    ? source.symbol.trim().toUpperCase()
    : source.symbol
  const privateCase = source.privateCase
  const parsed = parseStatArtifact(source.statArtifact, source.qualityManifest)
  const row = parsed.qualityManifest ? parsed.stat[symbol] : undefined
  const yahooSource = yahooPriceSource(symbol, row)
  const evidence = privateCase.evidence

  if (object(evidence?.sourcePolicy?.kinds) &&
      Object.hasOwn(evidence.sourcePolicy.kinds, 'YAHOO_MARKET_DATA') &&
      evidence.sourcePolicy.kinds.YAHOO_MARKET_DATA !== 'SECONDARY') {
    throw inputError()
  }

  let canonicalEvidence = evidence
  if (object(evidence) && object(evidence.sourcePolicy) &&
      object(evidence.sourcePolicy.kinds)) {
    canonicalEvidence = {
      ...evidence,
      sourcePolicy: {
        ...evidence.sourcePolicy,
        kinds: { ...evidence.sourcePolicy.kinds, YAHOO_MARKET_DATA: 'SECONDARY' },
      },
      drafts: Array.isArray(evidence.drafts) && yahooSource
        ? [...evidence.drafts, {
            key: 'price',
            claimKey: 'PRICE',
            factKey: 'CURRENT_PRICE',
            value: row.Close,
            sourceRef: yahooSource.ref.id,
            asOf: row.asOf,
            scope: { symbol },
            currency: row.currency,
            stance: 'SUPPORTS',
            confidence: 1,
          }]
        : evidence.drafts,
    }
  }

  const sourceSnapshots = Array.isArray(privateCase.sourceSnapshots) && yahooSource
    ? [...privateCase.sourceSnapshots, yahooSource.resolved]
    : privateCase.sourceSnapshots

  let portfolio = null
  try {
    portfolio = deriveRobinhoodPortfolioInput({
      symbol,
      evaluatedAt: source.evaluatedAt,
      stat: parsed.stat,
      robinhoodRead: source.robinhoodRead,
      capacityPolicy: privateCase.capacityPolicy,
    })
  } catch (error) {
    if (error?.code !== 'INVALID_ROBINHOOD_PORTFOLIO_INPUT') throw error
    portfolio = null
  }

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
    portfolio,
    decisionPolicy: privateCase.decisionPolicy,
  })
}
