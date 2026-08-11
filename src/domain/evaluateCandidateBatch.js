import { evaluateSymbolCase } from './evaluateSymbolCase.js'
import { validateRobinhoodReadV3 } from './robinhoodRead.js'

const INPUT_KEYS = [
  'schemaVersion',
  'evaluatedAt',
  'statArtifact',
  'qualityManifest',
  'robinhoodRead',
  'candidates',
]
const CANDIDATE_KEYS = ['symbol', 'privateCase']
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

function inputError() {
  const error = new TypeError('Candidate batch input is invalid')
  error.code = 'INVALID_CANDIDATE_BATCH_INPUT'
  return error
}

export function evaluateCandidateBatch(input) {
  if (!exactKeys(input, INPUT_KEYS) || input.schemaVersion !== 1 ||
      !Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw inputError()
  }

  const candidates = input.candidates.map(candidate => {
    if (!exactKeys(candidate, CANDIDATE_KEYS) || typeof candidate.symbol !== 'string' ||
        !object(candidate.privateCase)) throw inputError()
    const symbol = candidate.symbol.trim().toUpperCase()
    if (!TICKER.test(symbol)) throw inputError()
    return { symbol, privateCase: candidate.privateCase }
  })
  const symbols = candidates.map(candidate => candidate.symbol)
  if (new Set(symbols).size !== symbols.length) throw inputError()

  candidates.sort((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0)
  const targetSymbols = candidates.map(candidate => candidate.symbol)
  validateRobinhoodReadV3(input.robinhoodRead, targetSymbols)

  return candidates.map(candidate => evaluateSymbolCase({
    symbol: candidate.symbol,
    evaluatedAt: input.evaluatedAt,
    statArtifact: input.statArtifact,
    qualityManifest: input.qualityManifest,
    robinhoodRead: input.robinhoodRead,
    privateCase: candidate.privateCase,
  }))
}
