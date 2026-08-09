import { readFile } from 'node:fs/promises'

import { derivePortfolioCapacitySnapshot } from '../src/domain/portfolioCapacity.js'

const USAGE = 'Usage: npm run capacity -- [input.json|-]'

async function readInput(inputPath) {
  let json
  if (inputPath && inputPath !== '-') {
    json = await readFile(inputPath, 'utf8')
  } else {
    process.stdin.setEncoding('utf8')
    json = ''
    for await (const chunk of process.stdin) json += chunk
  }

  try {
    const input = JSON.parse(json)
    if (input === null || Array.isArray(input) || typeof input !== 'object') {
      throw new TypeError()
    }
    return input
  } catch {
    const error = new TypeError('Capacity input must be a valid JSON object')
    error.code = 'INVALID_CAPACITY_JSON'
    throw error
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args[0]?.startsWith('--')) throw new TypeError(USAGE)
  const input = await readInput(args[0])
  const result = derivePortfolioCapacitySnapshot(input)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  const safeMessage = error?.code === 'INVALID_PORTFOLIO_CAPACITY_INPUT'
    ? 'Portfolio capacity input is invalid'
    : error?.code === 'INVALID_CAPACITY_JSON'
      ? error.message
      : error?.message === USAGE
        ? USAGE
        : 'Unable to read capacity input'
  process.stderr.write(`${safeMessage}\n`)
  process.exitCode = 1
})
