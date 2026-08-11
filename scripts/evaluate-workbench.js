#!/usr/bin/env node

import { constants } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evaluateCandidateBatch } from '../src/domain/evaluateCandidateBatch.js'

const { lstat, open, realpath, stat } = fsPromises

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_MARKET_URL = 'https://brickerp.github.io/FactorPicks/'
const USAGE = 'Usage: npm run workbench -- --cases candidate-cases.json [--market-url base] [--evaluated-at ISO] [--ledger external-path]'
const CANDIDATE_CASES_ERROR = 'Unable to load candidate cases'
const ROBINHOOD_READ_ERROR = 'Unable to load Robinhood read input'
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/
const CASES_FILE_POLICY = Object.freeze({
  label: 'Cases file',
  mustExist: true,
  allowedModes: Object.freeze([0o400, 0o600]),
})
const LEDGER_FILE_POLICY = Object.freeze({
  label: 'Ledger',
  mustExist: false,
  allowedModes: null,
})

function assertOutsideRepository(path, policy) {
  const repositoryRelativePath = relative(REPOSITORY_ROOT, path)
  const isRepositoryPath = repositoryRelativePath === '' || (
    repositoryRelativePath !== '..' &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath)
  )
  if (isRepositoryPath) {
    throw new Error(`${policy.label} path must be outside the repository`)
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function pathComponents(path) {
  const components = []
  let component = path
  while (true) {
    components.push(component)
    const parent = dirname(component)
    if (parent === component) break
    component = parent
  }
  return components.reverse()
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function pathChanged(policy) {
  return new Error(`${policy.label} path changed during evaluation`)
}

function ledgerCasesConflict() {
  return new Error('Ledger must not reference the cases file')
}

function assertNotCasesFile(stats, casesTarget) {
  if (stats && casesTarget && sameFile(stats, casesTarget)) {
    throw ledgerCasesConflict()
  }
}

function assertDistinctPlans(casesPlan, ledgerPlan) {
  if (ledgerPlan.path === casesPlan.path ||
      (ledgerPlan.target && casesPlan.target && sameFile(ledgerPlan.target, casesPlan.target))) {
    throw ledgerCasesConflict()
  }
}

function assertSafeFile(stats, policy) {
  if (!stats?.isFile()) {
    throw new Error(`${policy.label} path must be a regular file`)
  }
  const permissions = stats.mode & 0o777
  if (policy.allowedModes !== null
    ? !policy.allowedModes.includes(permissions)
    : (permissions & 0o077) !== 0) {
    throw new Error(`${policy.label} file permissions are invalid`)
  }
}

async function inspectRequestedParents(parentPath, policy) {
  for (const path of pathComponents(parentPath)) {
    const stats = await lstatIfExists(path)
    if (!stats) throw new Error(`${policy.label} parent directory does not exist`)
    if (stats.isSymbolicLink()) {
      // macOS exposes the system temporary directory through /var -> /private/var;
      // this runtime alias is not a caller-controlled ledger parent.
      if (process.platform === 'darwin' && path === '/var') continue
      throw new Error(`${policy.label} path must not contain a symbolic-link ancestor`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`${policy.label} parent must resolve to a directory`)
    }
  }
  const parentStats = await stat(parentPath)
  if (!parentStats.isDirectory()) {
    throw new Error(`${policy.label} parent must resolve to a directory`)
  }
  return parentStats
}

async function captureCanonicalParents(parentPath, policy) {
  const parents = []
  for (const path of pathComponents(parentPath)) {
    const stats = await lstatIfExists(path)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) throw pathChanged(policy)
    parents.push({ path, dev: stats.dev, ino: stats.ino })
  }
  return parents
}

async function verifyCanonicalParents(parents, policy) {
  for (const expected of parents) {
    const stats = await lstatIfExists(expected.path)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory() ||
        !sameFile(stats, expected)) throw pathChanged(policy)
  }
}

async function resolveSafePath(requestedPath, policy) {
  const resolvedPath = resolve(requestedPath)
  assertOutsideRepository(resolvedPath, policy)
  const parentPath = dirname(resolvedPath)
  const requestedParent = await inspectRequestedParents(parentPath, policy)
  const initialTarget = await lstatIfExists(resolvedPath)
  if (initialTarget?.isSymbolicLink()) {
    throw new Error(`${policy.label} path must not be a symbolic link`)
  }
  if (!initialTarget && policy.mustExist) {
    throw new Error(`${policy.label} path does not exist`)
  }
  if (initialTarget) assertSafeFile(initialTarget, policy)

  const canonicalParent = await realpath(parentPath)
  assertOutsideRepository(canonicalParent, policy)
  const canonicalParentStats = await lstat(canonicalParent)
  if (!sameFile(requestedParent, canonicalParentStats)) throw pathChanged(policy)
  const canonicalPath = initialTarget
    ? await realpath(resolvedPath)
    : resolve(canonicalParent, relative(parentPath, resolvedPath))
  assertOutsideRepository(canonicalPath, policy)
  const canonicalTarget = await lstatIfExists(canonicalPath)
  if (Boolean(initialTarget) !== Boolean(canonicalTarget) ||
      (initialTarget && !sameFile(initialTarget, canonicalTarget))) throw pathChanged(policy)
  if (canonicalTarget) assertSafeFile(canonicalTarget, policy)

  return {
    path: canonicalPath,
    parents: await captureCanonicalParents(dirname(canonicalPath), policy),
    target: canonicalTarget
      ? { dev: canonicalTarget.dev, ino: canonicalTarget.ino }
      : null,
    policy,
  }
}

async function verifyBeforeOpen(plan, casesTarget = null) {
  await verifyCanonicalParents(plan.parents, plan.policy)
  const target = await lstatIfExists(plan.path)
  assertNotCasesFile(target, casesTarget)
  if (plan.target === null) {
    if (target) throw pathChanged(plan.policy)
    return
  }
  if (!target || target.isSymbolicLink() || !sameFile(target, plan.target)) {
    throw pathChanged(plan.policy)
  }
  assertSafeFile(target, plan.policy)
}

async function verifyOpenedFile(plan, handle, casesTarget = null) {
  const opened = await handle.stat()
  assertSafeFile(opened, plan.policy)
  assertNotCasesFile(opened, casesTarget)
  if (plan.target && !sameFile(opened, plan.target)) throw pathChanged(plan.policy)

  await verifyCanonicalParents(plan.parents, plan.policy)
  const finalPath = await realpath(plan.path)
  if (finalPath !== plan.path) throw pathChanged(plan.policy)
  const target = await lstatIfExists(plan.path)
  if (!target || target.isSymbolicLink() || !sameFile(target, opened)) {
    throw pathChanged(plan.policy)
  }
  assertSafeFile(target, plan.policy)
  assertNotCasesFile(target, casesTarget)
  await verifyCanonicalParents(plan.parents, plan.policy)

  const finalOpened = await handle.stat()
  if (!sameFile(finalOpened, target)) throw pathChanged(plan.policy)
  assertSafeFile(finalOpened, plan.policy)
  assertNotCasesFile(finalOpened, casesTarget)
}

async function appendLedger(plan, serialized, casesPlan) {
  await verifyBeforeOpen(casesPlan)
  await verifyBeforeOpen(plan, casesPlan.target)
  let flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
  flags |= plan.target === null ? constants.O_CREAT | constants.O_EXCL : 0
  let handle
  try {
    handle = await open(plan.path, flags, 0o600)
  } catch {
    throw pathChanged(plan.policy)
  }
  try {
    await verifyOpenedFile(plan, handle, casesPlan.target)
    await verifyBeforeOpen(casesPlan)
    await verifyOpenedFile(plan, handle, casesPlan.target)
    try {
      await handle.write(`${serialized}\n`)
    } catch {
      throw new Error('Ledger write failed')
    }
  } finally {
    await handle.close()
  }
}

function parseArguments(args) {
  const options = new Map()
  const names = new Set([
    '--cases',
    '--market-url',
    '--evaluated-at',
    '--ledger',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (!names.has(argument) || options.has(argument) || value === undefined ||
        value.startsWith('--')) throw new Error(USAGE)
    options.set(argument, value)
    index += 1
  }
  if (!options.has('--cases') || options.get('--cases') === '-') {
    throw new Error(USAGE)
  }
  return {
    casesPath: options.get('--cases'),
    marketUrl: options.get('--market-url') ?? DEFAULT_MARKET_URL,
    evaluatedAt: options.get('--evaluated-at') ?? new Date().toISOString(),
    ledgerPath: options.get('--ledger'),
  }
}

function exactKeys(value, keys) {
  return value !== null && !Array.isArray(value) && typeof value === 'object' &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

function parseCandidateCases(json) {
  let candidateCases
  try {
    candidateCases = JSON.parse(json)
  } catch {
    const error = new TypeError(CANDIDATE_CASES_ERROR)
    error.code = 'INVALID_CANDIDATE_CASES'
    throw error
  }
  if (!exactKeys(candidateCases, ['schemaVersion', 'candidates']) ||
      candidateCases.schemaVersion !== 1 ||
      !Array.isArray(candidateCases.candidates) ||
      candidateCases.candidates.length === 0) {
    const error = new TypeError(CANDIDATE_CASES_ERROR)
    error.code = 'INVALID_CANDIDATE_CASES'
    throw error
  }
  const symbols = new Set()
  for (const candidate of candidateCases.candidates) {
    const symbol = typeof candidate?.symbol === 'string'
      ? candidate.symbol.trim().toUpperCase()
      : null
    if (!exactKeys(candidate, ['symbol', 'privateCase']) || !TICKER.test(symbol ?? '') ||
        candidate.privateCase === null || Array.isArray(candidate.privateCase) ||
        typeof candidate.privateCase !== 'object' || symbols.has(symbol)) {
      const error = new TypeError(CANDIDATE_CASES_ERROR)
      error.code = 'INVALID_CANDIDATE_CASES'
      throw error
    }
    symbols.add(symbol)
  }
  return candidateCases
}

async function readCandidateCases(plan) {
  await verifyBeforeOpen(plan)
  let handle
  try {
    handle = await open(plan.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw pathChanged(plan.policy)
  }
  try {
    await verifyOpenedFile(plan, handle)
    let json
    try {
      json = await handle.readFile({ encoding: 'utf8' })
    } catch {
      const error = new Error(CANDIDATE_CASES_ERROR)
      error.code = 'CANDIDATE_CASES_READ_ERROR'
      throw error
    }
    await verifyOpenedFile(plan, handle)
    return parseCandidateCases(json)
  } finally {
    await handle.close()
  }
}

async function readRobinhoodRead() {
  let json = ''
  try {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) json += chunk
  } catch {
    const error = new Error(ROBINHOOD_READ_ERROR)
    error.code = 'ROBINHOOD_READ_ERROR'
    throw error
  }
  let robinhoodRead
  try {
    robinhoodRead = JSON.parse(json)
  } catch {
    const error = new TypeError(ROBINHOOD_READ_ERROR)
    error.code = 'INVALID_ROBINHOOD_READ_JSON'
    throw error
  }
  if (robinhoodRead === null || Array.isArray(robinhoodRead) ||
      typeof robinhoodRead !== 'object') {
    const error = new TypeError(ROBINHOOD_READ_ERROR)
    error.code = 'INVALID_ROBINHOOD_READ_JSON'
    throw error
  }
  return robinhoodRead
}

function publicUrl(base, file) {
  let root
  try {
    root = new URL(base)
  } catch {
    throw publicMarketError()
  }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) {
    throw publicMarketError()
  }
  const normalized = root.href.endsWith('/') ? root.href : `${root.href}/`
  return new URL(file, normalized)
}

async function fetchPublicResponse(url) {
  let response
  try {
    response = await fetch(url, { method: 'GET', redirect: 'error' })
  } catch {
    throw publicMarketError()
  }
  if (!response.ok) {
    throw publicMarketError()
  }
  return response
}

async function fetchPublicText(url) {
  const response = await fetchPublicResponse(url)
  let value
  try {
    value = await response.text()
    const parsed = JSON.parse(value)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw publicMarketError()
    }
  } catch {
    throw publicMarketError()
  }
  return value
}

async function fetchPublicJson(url) {
  const response = await fetchPublicResponse(url)
  let value
  try {
    value = await response.json()
  } catch {
    throw publicMarketError()
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw publicMarketError()
  }
  return value
}

function publicMarketError() {
  const error = new Error('Unable to load public market data')
  error.code = 'PUBLIC_MARKET_DATA_ERROR'
  return error
}

async function readPublicMarket(base) {
  const [statArtifact, qualityManifest] = await Promise.all([
    fetchPublicText(publicUrl(base, 'stat.json')),
    fetchPublicJson(publicUrl(base, 'data-quality.json')),
  ])
  return { statArtifact, qualityManifest }
}

async function main() {
  const { casesPath, marketUrl, evaluatedAt, ledgerPath } =
    parseArguments(process.argv.slice(2))
  const casesPlan = await resolveSafePath(casesPath, CASES_FILE_POLICY)
  const candidateCases = await readCandidateCases(casesPlan)
  const ledgerPlan = ledgerPath === undefined
    ? undefined
    : await resolveSafePath(ledgerPath, LEDGER_FILE_POLICY)
  if (ledgerPlan) assertDistinctPlans(casesPlan, ledgerPlan)
  const robinhoodRead = await readRobinhoodRead()
  const { statArtifact, qualityManifest } = await readPublicMarket(marketUrl)
  const decisions = evaluateCandidateBatch({
    schemaVersion: candidateCases.schemaVersion,
    evaluatedAt,
    statArtifact,
    qualityManifest,
    robinhoodRead,
    candidates: candidateCases.candidates,
  })
  const serialized = JSON.stringify(decisions)
  if (ledgerPlan !== undefined) {
    await appendLedger(ledgerPlan, serialized, casesPlan)
  }
  process.stdout.write(`${serialized}\n`)
}

function safeErrorMessage(error) {
  if (error?.code === 'INVALID_CANDIDATE_CASES' ||
      error?.code === 'CANDIDATE_CASES_READ_ERROR') return CANDIDATE_CASES_ERROR
  if (error?.code === 'INVALID_ROBINHOOD_READ_JSON') return ROBINHOOD_READ_ERROR
  if (error?.code === 'ROBINHOOD_READ_ERROR') return ROBINHOOD_READ_ERROR
  if (error?.code === 'PUBLIC_MARKET_DATA_ERROR') return 'Unable to load public market data'
  if (error?.message === USAGE) return USAGE
  if (error?.message?.startsWith('Ledger') ||
      error?.message?.startsWith('Cases file')) return error.message
  return 'Unable to evaluate candidate batch'
}

main().catch(error => {
  process.stderr.write(`${safeErrorMessage(error)}\n`)
  process.exitCode = 1
})
