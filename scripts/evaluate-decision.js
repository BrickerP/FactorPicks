#!/usr/bin/env node

import { appendFile, lstat, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { evaluateDecision } from "../src/domain/evaluateDecision.js"
import { evaluateResearch } from "../src/domain/evaluateResearch.js"

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const USAGE = "Usage: npm run decision -- [input.json|-] [--ledger path]"

function assertOutsideRepository(path) {
  const repositoryRelativePath = relative(REPOSITORY_ROOT, path)
  const isRepositoryPath = repositoryRelativePath === "" || (
    repositoryRelativePath !== ".." &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath)
  )

  if (isRepositoryPath) {
    throw new Error("Ledger path must be outside the repository")
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function resolveLedgerPath(ledgerPath) {
  const resolvedPath = resolve(ledgerPath)
  assertOutsideRepository(resolvedPath)

  const targetStats = await lstatIfExists(resolvedPath)
  if (targetStats) {
    if (targetStats.isSymbolicLink()) {
      throw new Error("Ledger path must not be a symbolic link")
    }
    if (!targetStats.isFile()) {
      throw new Error("Ledger path must be a regular file")
    }

    const canonicalPath = await realpath(resolvedPath)
    assertOutsideRepository(canonicalPath)
    return canonicalPath
  }

  let existingParent = dirname(resolvedPath)
  while (!(await lstatIfExists(existingParent))) {
    const nextParent = dirname(existingParent)
    if (nextParent === existingParent) {
      throw new Error("Ledger parent directory does not exist")
    }
    existingParent = nextParent
  }

  const canonicalParent = await realpath(existingParent)
  if (!(await lstat(canonicalParent)).isDirectory()) {
    throw new Error("Ledger parent must resolve to a directory")
  }

  const canonicalPath = resolve(
    canonicalParent,
    relative(existingParent, resolvedPath),
  )
  assertOutsideRepository(canonicalPath)

  return canonicalPath
}

function parseArguments(args) {
  let inputPath
  let ledgerPath

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === "--ledger") {
      if (ledgerPath !== undefined || index + 1 >= args.length) {
        throw new Error(USAGE)
      }

      ledgerPath = args[index + 1]
      index += 1
      continue
    }

    if (argument.startsWith("--") || inputPath !== undefined) {
      throw new Error(USAGE)
    }

    inputPath = argument
  }

  return { inputPath, ledgerPath }
}

async function readBundle(inputPath) {
  let json

  if (inputPath && inputPath !== "-") {
    json = await readFile(inputPath, "utf8")
  } else {
    process.stdin.setEncoding("utf8")
    json = ""
    for await (const chunk of process.stdin) json += chunk
  }

  const bundle = JSON.parse(json)

  if (bundle === null || Array.isArray(bundle) || typeof bundle !== "object") {
    throw new TypeError("Decision input must be a JSON object")
  }

  return bundle
}

async function main() {
  const { inputPath, ledgerPath } = parseArguments(process.argv.slice(2))
  const resolvedLedgerPath = ledgerPath === undefined
    ? undefined
    : await resolveLedgerPath(ledgerPath)
  const bundle = await readBundle(inputPath)
  const { universe, symbol, qualityManifest, underwriting, portfolio, policy, now } = bundle

  const research = evaluateResearch({
    universe,
    symbol,
    qualityManifest,
    policy,
    now,
  })
  const decision = evaluateDecision({
    research,
    underwriting,
    portfolio,
    policy,
    now,
  })

  if (resolvedLedgerPath !== undefined) {
    await appendFile(resolvedLedgerPath, `${JSON.stringify(decision)}\n`, "utf8")
  }

  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
