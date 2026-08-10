#!/usr/bin/env node

import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_MARKET_URL = 'https://brickerp.github.io/FactorPicks/'
const USAGE = 'Usage: npm run workbench -- --symbol SYMBOL --case private-case.json|- [--market-url base] [--evaluated-at ISO] [--ledger external-path]'

function assertOutsideRepository(path) {
  const repositoryRelativePath = relative(REPOSITORY_ROOT, path)
  const isRepositoryPath = repositoryRelativePath === '' || (
    repositoryRelativePath !== '..' &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath)
  )
  if (isRepositoryPath) throw new Error('Ledger path must be outside the repository')
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

function ledgerChanged() {
  return new Error('Ledger path changed during evaluation')
}

function assertSafeLedgerFile(stats) {
  if (!stats?.isFile()) throw new Error('Ledger path must be a regular file')
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Ledger file permissions must be owner-only')
  }
}

async function inspectRequestedParents(parentPath) {
  for (const path of pathComponents(parentPath)) {
    const stats = await lstatIfExists(path)
    if (!stats) throw new Error('Ledger parent directory does not exist')
    if (stats.isSymbolicLink()) {
      // macOS exposes the system temporary directory through /var -> /private/var;
      // this runtime alias is not a caller-controlled ledger parent.
      if (process.platform === 'darwin' && path === '/var') continue
      throw new Error('Ledger path must not contain a symbolic-link ancestor')
    }
    if (!stats.isDirectory()) throw new Error('Ledger parent must resolve to a directory')
  }
  const parentStats = await stat(parentPath)
  if (!parentStats.isDirectory()) throw new Error('Ledger parent must resolve to a directory')
  return parentStats
}

async function captureCanonicalParents(parentPath) {
  const parents = []
  for (const path of pathComponents(parentPath)) {
    const stats = await lstatIfExists(path)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) throw ledgerChanged()
    parents.push({ path, dev: stats.dev, ino: stats.ino })
  }
  return parents
}

async function verifyCanonicalParents(parents) {
  for (const expected of parents) {
    const stats = await lstatIfExists(expected.path)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory() ||
        !sameFile(stats, expected)) throw ledgerChanged()
  }
}

async function resolveLedgerPath(ledgerPath) {
  const resolvedPath = resolve(ledgerPath)
  assertOutsideRepository(resolvedPath)
  const parentPath = dirname(resolvedPath)
  const requestedParent = await inspectRequestedParents(parentPath)
  const initialTarget = await lstatIfExists(resolvedPath)
  if (initialTarget?.isSymbolicLink()) {
    throw new Error('Ledger path must not be a symbolic link')
  }
  if (initialTarget) assertSafeLedgerFile(initialTarget)

  const canonicalParent = await realpath(parentPath)
  assertOutsideRepository(canonicalParent)
  const canonicalParentStats = await lstat(canonicalParent)
  if (!sameFile(requestedParent, canonicalParentStats)) throw ledgerChanged()
  const canonicalPath = initialTarget
    ? await realpath(resolvedPath)
    : resolve(canonicalParent, relative(parentPath, resolvedPath))
  assertOutsideRepository(canonicalPath)
  const canonicalTarget = await lstatIfExists(canonicalPath)
  if (Boolean(initialTarget) !== Boolean(canonicalTarget) ||
      (initialTarget && !sameFile(initialTarget, canonicalTarget))) throw ledgerChanged()
  if (canonicalTarget) assertSafeLedgerFile(canonicalTarget)

  return {
    path: canonicalPath,
    parents: await captureCanonicalParents(dirname(canonicalPath)),
    target: canonicalTarget
      ? { dev: canonicalTarget.dev, ino: canonicalTarget.ino }
      : null,
  }
}

async function verifyLedgerBeforeOpen(plan) {
  await verifyCanonicalParents(plan.parents)
  const target = await lstatIfExists(plan.path)
  if (plan.target === null) {
    if (target) throw ledgerChanged()
    return
  }
  if (!target || target.isSymbolicLink() || !sameFile(target, plan.target)) throw ledgerChanged()
  assertSafeLedgerFile(target)
}

async function verifyOpenedLedger(plan, handle) {
  const opened = await handle.stat()
  assertSafeLedgerFile(opened)
  if (plan.target && !sameFile(opened, plan.target)) throw ledgerChanged()

  await verifyCanonicalParents(plan.parents)
  const finalPath = await realpath(plan.path)
  if (finalPath !== plan.path) throw ledgerChanged()
  const target = await lstatIfExists(plan.path)
  if (!target || target.isSymbolicLink() || !sameFile(target, opened)) throw ledgerChanged()
  assertSafeLedgerFile(target)
  await verifyCanonicalParents(plan.parents)

  const finalOpened = await handle.stat()
  if (!sameFile(finalOpened, target)) throw ledgerChanged()
  assertSafeLedgerFile(finalOpened)
}

async function appendLedger(plan, serialized) {
  await verifyLedgerBeforeOpen(plan)
  let flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
  flags |= plan.target === null ? constants.O_CREAT | constants.O_EXCL : 0
  let handle
  try {
    handle = await open(plan.path, flags, 0o600)
  } catch {
    throw ledgerChanged()
  }
  try {
    await verifyOpenedLedger(plan, handle)
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
    '--symbol',
    '--case',
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
  if (!options.has('--symbol') || !options.has('--case')) throw new Error(USAGE)
  return {
    symbol: options.get('--symbol'),
    casePath: options.get('--case'),
    marketUrl: options.get('--market-url') ?? DEFAULT_MARKET_URL,
    evaluatedAt: options.get('--evaluated-at') ?? new Date().toISOString(),
    ledgerPath: options.get('--ledger'),
  }
}

async function readPrivateCase(casePath) {
  let json = ''
  if (casePath !== '-') {
    try {
      json = await readFile(casePath, 'utf8')
    } catch {
      const error = new Error('Unable to read private case')
      error.code = 'PRIVATE_CASE_READ_ERROR'
      throw error
    }
  } else {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) json += chunk
  }
  let privateCase
  try {
    privateCase = JSON.parse(json)
  } catch {
    const error = new TypeError('Private case must be valid JSON')
    error.code = 'INVALID_PRIVATE_CASE_JSON'
    throw error
  }
  if (privateCase === null || Array.isArray(privateCase) || typeof privateCase !== 'object') {
    const error = new TypeError('Private case must be a JSON object')
    error.code = 'INVALID_PRIVATE_CASE_JSON'
    throw error
  }
  return privateCase
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
  const { symbol, casePath, marketUrl, evaluatedAt, ledgerPath } =
    parseArguments(process.argv.slice(2))
  const ledgerPlan = ledgerPath === undefined
    ? undefined
    : await resolveLedgerPath(ledgerPath)
  const privateCase = await readPrivateCase(casePath)
  const { statArtifact, qualityManifest } = await readPublicMarket(marketUrl)
  const decision = evaluateSymbolCase({
    symbol,
    evaluatedAt,
    statArtifact,
    qualityManifest,
    privateCase,
  })
  const serialized = JSON.stringify(decision)
  if (ledgerPlan !== undefined) {
    await appendLedger(ledgerPlan, serialized)
  }
  process.stdout.write(`${serialized}\n`)
}

function safeErrorMessage(error) {
  if (error?.code === 'INVALID_PRIVATE_CASE_JSON') return error.message
  if (error?.code === 'PRIVATE_CASE_READ_ERROR') return 'Unable to read private case'
  if (error?.code === 'PUBLIC_MARKET_DATA_ERROR') return 'Unable to load public market data'
  if (error?.message === USAGE) return USAGE
  if (error?.message?.startsWith('Ledger')) return error.message
  return 'Unable to evaluate symbol case'
}

main().catch(error => {
  process.stderr.write(`${safeErrorMessage(error)}\n`)
  process.exitCode = 1
})
