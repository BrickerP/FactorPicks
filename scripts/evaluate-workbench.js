#!/usr/bin/env node

import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evaluateWorkbench } from '../src/domain/workbench.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'Usage: npm run workbench -- [input.json|-] [--ledger path]'

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

async function resolveLedgerPath(ledgerPath) {
  const resolvedPath = resolve(ledgerPath)
  assertOutsideRepository(resolvedPath)

  const components = []
  let component = resolvedPath
  while (true) {
    components.push(component)
    const parent = dirname(component)
    if (parent === component) break
    component = parent
  }
  let missingAncestor = false
  for (const path of components.reverse()) {
    if (missingAncestor) break
    const stats = await lstatIfExists(path)
    if (!stats) {
      missingAncestor = true
      continue
    }
    if (stats.isSymbolicLink()) {
      // macOS exposes the system temporary directory through /var -> /private/var;
      // this runtime alias is not a caller-controlled ledger parent.
      if (process.platform === 'darwin' && path === '/var') continue
      throw new Error('Ledger path must not contain a symbolic-link ancestor')
    }
    if (path !== resolvedPath && !stats.isDirectory()) {
      throw new Error('Ledger parent must resolve to a directory')
    }
  }

  let existingParent = dirname(resolvedPath)
  let parentStats
  while (!(parentStats = await lstatIfExists(existingParent))) {
    const nextParent = dirname(existingParent)
    if (nextParent === existingParent) throw new Error('Ledger parent directory does not exist')
    existingParent = nextParent
  }
  if (parentStats.isSymbolicLink()) {
    throw new Error('Ledger parent directory must not be a symbolic link')
  }
  if (!parentStats.isDirectory()) {
    throw new Error('Ledger parent must resolve to a directory')
  }
  const canonicalParent = await realpath(existingParent)
  assertOutsideRepository(canonicalParent)
  const canonicalPath = resolve(canonicalParent, relative(existingParent, resolvedPath))
  assertOutsideRepository(canonicalPath)
  const targetStats = await lstatIfExists(canonicalPath)
  if (targetStats) {
    if (targetStats.isSymbolicLink()) throw new Error('Ledger path must not be a symbolic link')
    if (!targetStats.isFile()) throw new Error('Ledger path must be a regular file')
    if ((targetStats.mode & 0o077) !== 0) {
      throw new Error('Ledger file permissions must be owner-only')
    }
  }
  return canonicalPath
}

async function appendLedger(ledgerPath, serialized) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
  const handle = await open(ledgerPath, flags, 0o600)
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
      throw new Error('Ledger file permissions must be owner-only')
    }
    await handle.write(`${serialized}\n`)
  } finally {
    await handle.close()
  }
}

function parseArguments(args) {
  let inputPath
  let ledgerPath
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--ledger') {
      if (ledgerPath !== undefined || index + 1 >= args.length) throw new Error(USAGE)
      ledgerPath = args[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--') || inputPath !== undefined) throw new Error(USAGE)
    inputPath = argument
  }
  return { inputPath, ledgerPath }
}

async function readInput(inputPath) {
  let json = ''
  if (inputPath && inputPath !== '-') {
    json = await readFile(inputPath, 'utf8')
  } else {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) json += chunk
  }
  let input
  try {
    input = JSON.parse(json)
  } catch {
    const error = new TypeError('Workbench input must be valid JSON')
    error.code = 'INVALID_WORKBENCH_JSON'
    throw error
  }
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    const error = new TypeError('Workbench input must be a JSON object')
    error.code = 'INVALID_WORKBENCH_JSON'
    throw error
  }
  return input
}

async function main() {
  const { inputPath, ledgerPath } = parseArguments(process.argv.slice(2))
  const resolvedLedgerPath = ledgerPath === undefined
    ? undefined
    : await resolveLedgerPath(ledgerPath)
  const input = await readInput(inputPath)
  const decision = evaluateWorkbench(input)
  const serialized = JSON.stringify(decision)
  if (resolvedLedgerPath !== undefined) {
    await appendLedger(resolvedLedgerPath, serialized)
  }
  process.stdout.write(`${serialized}\n`)
}

main().catch(error => {
  const safeMessage = error?.code === 'INVALID_WORKBENCH_JSON'
    ? error.message
    : error?.message === USAGE
      ? USAGE
      : error?.message?.startsWith('Ledger') || error?.message?.startsWith('Ledger parent')
        ? error.message
        : 'Unable to read workbench input'
  process.stderr.write(`${safeMessage}\n`)
  process.exitCode = 1
})
