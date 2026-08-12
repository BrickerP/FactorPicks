const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/
const CRITICAL_FIELDS = [
  'Close', 'name', 'sector', 'industry', 'Market Cap', 'P/E', 'PEG', 'ROE',
  'Debt/Eq', 'FCFF/EV',
]
const PRIVATE_OR_DECISION_FIELDS = new Set([
  'action', 'buyAction', 'decision', 'decisionPolicy', 'decisionPolicyRef',
  'privateCase', 'portfolio', 'portfolioCapacity', 'positionSizing', 'holdingRisk',
  'entryStatus', 'dataStatus', 'reasonCodes', 'blockerCodes', 'underwriting',
  'timingAssessment', 'evidence',
])
const PROJECTED_SESSIONS = new WeakSet()

class PublicCandidateSessionError extends TypeError {
  constructor() {
    super('Public candidate session is invalid')
    this.code = 'INVALID_PUBLIC_CANDIDATE_SESSION'
  }
}

function invalid() {
  throw new PublicCandidateSessionError()
}

function object(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

function canonicalSymbol(value) {
  return typeof value === 'string' && SYMBOL_PATTERN.test(value)
}

function timestamp(value) {
  if (typeof value !== 'string') return false
  const match = UTC_TIMESTAMP_PATTERN.exec(value)
  if (!match) return false
  const milliseconds = (match[2] ?? '').slice(0, 3).padEnd(3, '0')
  const parsed = Date.parse(`${match[1]}.${milliseconds}Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === match[1]
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function rate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function expectedRate(numerator, denominator) {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1_000_000) / 1_000_000
}

function ratesMatch(value, numerator, denominator) {
  return Math.abs(value - expectedRate(numerator, denominator)) <= 0.000001
}

function numberOrMissing(value) {
  if (value === '-') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  return value
}

function covered(value) {
  return value !== null && value !== undefined && value !== '' && value !== '-' && value !== '-1' &&
    !(typeof value === 'number' && !Number.isFinite(value))
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
}

function validateManifest(manifest) {
  if (!exact(manifest, [
    'schemaVersion', 'generatedAt', 'source', 'requested', 'succeeded', 'failed',
    'successRate', 'coverage', 'failedSymbols', 'statArtifact',
  ]) || manifest.schemaVersion !== 1 || !timestamp(manifest.generatedAt) ||
      manifest.source !== 'yfinance') invalid()

  const { requested, succeeded, failed } = manifest
  if (![requested, succeeded, failed].every(nonNegativeInteger) ||
      requested === 0 || succeeded === 0 || requested !== succeeded + failed ||
      !rate(manifest.successRate) ||
      !ratesMatch(manifest.successRate, succeeded, requested) ||
      manifest.successRate < 0.8 ||
      !Array.isArray(manifest.failedSymbols) ||
      manifest.failedSymbols.length !== failed ||
      !manifest.failedSymbols.every(canonicalSymbol) ||
      new Set(manifest.failedSymbols).size !== manifest.failedSymbols.length) invalid()

  if (!exact(manifest.coverage, CRITICAL_FIELDS)) invalid()
  for (const field of CRITICAL_FIELDS) {
    const coverage = manifest.coverage[field]
    if (!exact(coverage, ['available', 'total', 'rate']) ||
        !nonNegativeInteger(coverage.available) || coverage.available > succeeded ||
        coverage.total !== succeeded || !rate(coverage.rate) ||
        !ratesMatch(coverage.rate, coverage.available, coverage.total) ||
        coverage.rate < 0.5) invalid()
  }

  if (!exact(manifest.statArtifact, ['sha256', 'bytes', 'symbols']) ||
      !SHA256_PATTERN.test(manifest.statArtifact.sha256) ||
      !nonNegativeInteger(manifest.statArtifact.bytes) ||
      manifest.statArtifact.symbols !== succeeded) invalid()
}

function projectCandidate(symbol, row) {
  if (!canonicalSymbol(symbol) || !object(row) ||
      Object.keys(row).some(key => PRIVATE_OR_DECISION_FIELDS.has(key)) ||
      typeof row.name !== 'string' || row.name.length === 0 ||
      typeof row.sector !== 'string' || row.sector.length === 0 ||
      typeof row.industry !== 'string' || row.industry.length === 0 ||
      typeof row.Close !== 'number' || !Number.isFinite(row.Close) || row.Close <= 0 ||
      row.currency !== 'USD' || !timestamp(row.asOf) || !timestamp(row.observedAt)) invalid()

  return {
    symbol,
    name: row.name,
    sector: row.sector,
    industry: row.industry,
    close: row.Close,
    currency: row.currency,
    asOf: row.asOf,
    observedAt: row.observedAt,
    fundamentals: {
      marketCap: numberOrMissing(row['Market Cap']),
      priceToEarnings: numberOrMissing(row['P/E']),
      peg: numberOrMissing(row.PEG),
      returnOnEquity: numberOrMissing(row.ROE),
      debtToEquity: numberOrMissing(row['Debt/Eq']),
      freeCashFlowToEnterpriseValue: numberOrMissing(row['FCFF/EV']),
    },
  }
}

export async function parsePublicCandidateSession(rawStatText, qualityManifest) {
  if (typeof rawStatText !== 'string' || rawStatText.length === 0) invalid()
  validateManifest(qualityManifest)

  const encodedBytes = new TextEncoder().encode(rawStatText).byteLength
  if (encodedBytes !== qualityManifest.statArtifact.bytes ||
      await sha256(rawStatText) !== qualityManifest.statArtifact.sha256) invalid()

  let rows
  try {
    rows = JSON.parse(rawStatText)
  } catch {
    invalid()
  }
  if (!object(rows)) invalid()
  const symbols = Object.keys(rows)
  if (symbols.length !== qualityManifest.succeeded ||
      symbols.length !== qualityManifest.statArtifact.symbols ||
      symbols.some(symbol => qualityManifest.failedSymbols.includes(symbol))) invalid()
  for (const field of CRITICAL_FIELDS) {
    const actualAvailable = symbols.filter(symbol => covered(rows[symbol]?.[field])).length
    const declared = qualityManifest.coverage[field]
    if (declared.available !== actualAvailable ||
        !ratesMatch(declared.rate, actualAvailable, symbols.length)) invalid()
  }

  const candidates = symbols
    .map(symbol => projectCandidate(symbol, rows[symbol]))
    .sort((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0)
  const session = deepFreeze({
    candidates,
    quality: {
      generatedAt: qualityManifest.generatedAt,
      source: qualityManifest.source,
      requested: qualityManifest.requested,
      succeeded: qualityManifest.succeeded,
      failed: qualityManifest.failed,
      successRate: qualityManifest.successRate,
      coverage: Object.fromEntries(CRITICAL_FIELDS.map(field => [
        field,
        { ...qualityManifest.coverage[field] },
      ])),
      failedSymbols: [...qualityManifest.failedSymbols],
    },
  })
  PROJECTED_SESSIONS.add(session)
  return session
}

export function mergePublicCandidatesWithDecisions(publicSession, decisionRecords = []) {
  if (!PROJECTED_SESSIONS.has(publicSession) || !Array.isArray(decisionRecords)) invalid()
  const publicBySymbol = new Map(publicSession.candidates.map(candidate => [candidate.symbol, candidate]))
  const decisionsBySymbol = new Map()
  for (const record of decisionRecords) {
    if (!object(record) || !canonicalSymbol(record.symbol) || decisionsBySymbol.has(record.symbol)) {
      invalid()
    }
    decisionsBySymbol.set(record.symbol, record)
  }

  const symbols = [...new Set([...publicBySymbol.keys(), ...decisionsBySymbol.keys()])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return deepFreeze(symbols.map(symbol => ({
    symbol,
    publicCandidate: publicBySymbol.get(symbol) ?? null,
    decisionRecord: decisionsBySymbol.get(symbol) ?? null,
  })))
}
