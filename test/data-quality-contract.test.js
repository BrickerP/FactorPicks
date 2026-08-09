import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateResearch } from '../src/domain/evaluateResearch.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRODUCER_PATH = fileURLToPath(
  new URL('../.github/fetch_stock_data/fetch_stock_data.py', import.meta.url),
)
const PYTHON_BOOTSTRAP = `
import importlib.util
import sys
import types

for dependency in ("requests", "yfinance", "pandas"):
    sys.modules[dependency] = types.ModuleType(dependency)

spec = importlib.util.spec_from_file_location("fetch_stock_data", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`

function runProducerPython(program, args = []) {
  return spawnSync(
    'python3',
    ['-c', PYTHON_BOOTSTRAP + program, PRODUCER_PATH, ...args],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  )
}

function manifestFromPython(succeeded, requested) {
  const program = `
import json

succeeded = int(sys.argv[2])
requested = int(sys.argv[3])
stock_stat = {
    "S{index}".format(index=index): {
        field: 1 for field in module.CRITICAL_FIELDS
    }
    for index in range(succeeded)
}
failed_symbols = [
    "F{index}".format(index=index)
    for index in range(requested - succeeded)
]
manifest = module.build_data_quality(stock_stat, requested, failed_symbols)
within_tolerance = dict(manifest)
within_tolerance["successRate"] += module.RATE_TOLERANCE / 2
outside_tolerance = dict(manifest)
outside_tolerance["successRate"] += module.RATE_TOLERANCE * 2

print(json.dumps({
    "manifest": manifest,
    "minimumCriticalFieldCoverage": module.MIN_CRITICAL_FIELD_COVERAGE,
    "rateDecimalPlaces": module.RATE_DECIMAL_PLACES,
    "rateTolerance": module.RATE_TOLERANCE,
    "withinToleranceErrors": module.validate_data_quality(within_tolerance),
    "outsideToleranceErrors": module.validate_data_quality(outside_tolerance),
}))
`
  const result = runProducerPython(program, [String(succeeded), String(requested)])

  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function checkTemporaryManifest(manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-quality-'))
  const manifestPath = join(directory, 'data-quality.json')
  const program = `
import pathlib
sys.exit(module.check_data_quality(pathlib.Path(sys.argv[2])))
`

  try {
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return runProducerPython(program, [manifestPath])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function evaluateManifest(qualityManifest) {
  const universe = Object.fromEntries(
    Array.from({ length: qualityManifest.succeeded }, (_, index) => [
      `S${index}`,
      { sector: 'Technology', ROE: index + 1 },
    ]),
  )

  return evaluateResearch({
    universe,
    symbol: 'S0',
    qualityManifest,
    policy: {
      research: {
        factorWeights: { returnOnEquity: 1 },
        minimumSectorSampleSize: 2,
        minimumGlobalSampleSize: 2,
        manifestMaxAgeMs: 0,
        maxFutureSkewMs: 0,
        criticalFields: ['ROE'],
        minimumCriticalFieldCoverage: 1,
        minimumResearchCoverage: 1,
      },
    },
    now: qualityManifest.generatedAt,
  })
}

function hasSuccessRateConflict(result) {
  return result.blockers.some(
    blocker => blocker.code === 'MANIFEST_SUCCESS_RATE_CONFLICT',
  )
}

test('Python producer and JavaScript consumer share the six-decimal rate contract', () => {
  const fixture = manifestFromPython(5, 6)

  assert.equal(fixture.manifest.successRate, 0.833333)
  assert.equal(fixture.minimumCriticalFieldCoverage, 0.5)
  assert.equal(fixture.rateDecimalPlaces, 6)
  assert.equal(fixture.rateTolerance, 1e-6)
  assert.deepEqual(fixture.withinToleranceErrors, [])
  assert.ok(fixture.outsideToleranceErrors.includes(
    'successRate does not match the result counts',
  ))

  const exact = evaluateManifest(fixture.manifest)
  assert.equal(hasSuccessRateConflict(exact), false)

  const withinTolerance = evaluateManifest({
    ...fixture.manifest,
    successRate: fixture.manifest.successRate + fixture.rateTolerance / 2,
  })
  assert.equal(hasSuccessRateConflict(withinTolerance), false)

  const outsideTolerance = evaluateManifest({
    ...fixture.manifest,
    successRate: fixture.manifest.successRate + fixture.rateTolerance * 2,
  })
  assert.equal(hasSuccessRateConflict(outsideTolerance), true)
})

test('Python quality checker rejects inconsistent or insufficient field coverage', () => {
  const fixture = manifestFromPython(5, 6).manifest
  const valid = checkTemporaryManifest(fixture)
  assert.equal(valid.status, 0, valid.stdout + valid.stderr)

  const cases = [
    {
      name: 'total conflicts with succeeded',
      coverage: { available: 4, total: 4, rate: 1 },
      message: /coverage ROE total must equal succeeded/,
    },
    {
      name: 'rate conflicts with counts',
      coverage: { available: 5, total: 5, rate: 0.8 },
      message: /coverage ROE rate does not match available and total/,
    },
    {
      name: 'fundamentals coverage is too low',
      coverage: { available: 2, total: 5, rate: 0.4 },
      message: /coverage ROE rate 40% is below 50%/,
    },
  ]

  for (const scenario of cases) {
    const manifest = JSON.parse(JSON.stringify(fixture))
    manifest.coverage.ROE = scenario.coverage
    const result = checkTemporaryManifest(manifest)

    assert.notEqual(result.status, 0, scenario.name)
    assert.match(result.stdout, scenario.message, scenario.name)
  }
})
