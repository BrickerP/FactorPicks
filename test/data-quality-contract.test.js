import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import base64
import json

succeeded = int(sys.argv[2])
requested = int(sys.argv[3])
stock_stat = {
    "S{index}".format(index=index): {
        field: 1 for field in module.CRITICAL_FIELDS
    }
    for index in range(succeeded)
}
stock_stat["S0"]["PEG"] = None
failed_symbols = [
    "F{index}".format(index=index)
    for index in range(requested - succeeded)
]
stat_bytes, stat_artifact = module.prepare_stat_artifact(stock_stat)
manifest = module.build_data_quality(
    stock_stat,
    requested,
    failed_symbols,
    stat_artifact,
)
within_tolerance = dict(manifest)
within_tolerance["successRate"] += module.RATE_TOLERANCE / 2
outside_tolerance = dict(manifest)
outside_tolerance["successRate"] += module.RATE_TOLERANCE * 2

print(json.dumps({
    "manifest": manifest,
    "minimumCriticalFieldCoverage": module.MIN_CRITICAL_FIELD_COVERAGE,
    "rateDecimalPlaces": module.RATE_DECIMAL_PLACES,
    "rateTolerance": module.RATE_TOLERANCE,
    "statBytesBase64": base64.b64encode(stat_bytes).decode("ascii"),
    "withinToleranceErrors": module.validate_data_quality(within_tolerance),
    "outsideToleranceErrors": module.validate_data_quality(outside_tolerance),
}))
`
  const result = runProducerPython(program, [String(succeeded), String(requested)])

  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function checkTemporaryManifest(manifest, statBytesBase64) {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-quality-'))
  const manifestPath = join(directory, 'data-quality.json')
  const program = `
import pathlib
sys.exit(module.check_data_quality(pathlib.Path(sys.argv[2])))
`

  try {
    writeFileSync(manifestPath, JSON.stringify(manifest))
    if (statBytesBase64) {
      writeFileSync(
        join(directory, 'stat.json'),
        Buffer.from(statBytesBase64, 'base64'),
      )
    }
    return runProducerPython(program, [manifestPath])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function marketArtifactFromPython() {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-market-data-'))
  const program = `
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import base64
import io
import json
import pathlib

market_timezone = timezone(timedelta(hours=-5))

class FakeDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return cls(2025, 8, 10)
        return cls(
            2025,
            8,
            10,
            0,
            FakeTicker.metadata_responses,
            tzinfo=timezone.utc,
        )

class FakeHistory:
    empty = False

    def __init__(self, symbol):
        self.rows = []
        for day in range(1, 22):
            volume = day * 100
            if symbol == "MISSING" and day == 21:
                volume = float("inf")
            self.rows.append((
                FakeDateTime(2025, 1, day, 0, tzinfo=market_timezone),
                {
                    "Open": 100 + day,
                    "High": 102 + day,
                    "Low": 98 + day,
                    "Close": 100 + day,
                    "Volume": volume,
                },
            ))

    def iterrows(self):
        return iter(self.rows)

class FakeTicker:
    metadata_responses = 0

    def __init__(self, symbol):
        self.symbol = symbol
        self.history_called = False
        self.fast_info = None
        if symbol == "NOINFO":
            self._info = {}
            return
        self._info = {
            "symbol": symbol,
            "shortName": symbol + " Corp",
            "sector": "Technology",
            "industry": "Software - Application",
            "currentPrice": 121,
            "currency": "EUR",
        }
        if symbol == "FULL":
            self._info.update({
                "targetLowPrice": 90.5,
                "targetHighPrice": 120.25,
                "forwardEps": 4.2,
                "earningsTimestamp": 1735689600,
            })
        else:
            self._info.update({
                "targetLowPrice": float("nan"),
                "targetHighPrice": float("inf"),
                "forwardEps": None,
                "earningsTimestamp": float("inf"),
            })

    def history(self, period):
        self.history_called = True
        return FakeHistory(self.symbol)

    def get_history_metadata(self):
        if not self.history_called:
            return None
        FakeTicker.metadata_responses += 1
        metadata = {
            "FULL": {
                "regularMarketPrice": 321.25,
                "regularMarketTime": 1737579600,
                "currency": "USD",
            },
            "MISSING": {
                "regularMarketPrice": 222.5,
                "regularMarketTime": 1737666000,
                "currency": "USD",
            },
            "NOINFO": {
                "regularMarketPrice": 111,
                "regularMarketTime": 1737752400,
                "currency": "USD",
            },
            "NOMETADATA": None,
            "NOPRICE": {
                "regularMarketTime": 1737838800,
                "currency": "USD",
            },
            "NOTIME": {
                "regularMarketPrice": 444,
                "currency": "USD",
            },
            "NOCURRENCY": {
                "regularMarketPrice": 555,
                "regularMarketTime": 1737925200,
            },
            "EUR": {
                "regularMarketPrice": 666,
                "regularMarketTime": 1738011600,
                "currency": "EUR",
            },
        }
        return metadata[self.symbol]

    @property
    def info(self):
        if not self.history_called:
            return {}
        return self._info

module.yf.Ticker = FakeTicker
module.datetime = FakeDateTime
module.DELAY_TIME_SEC = 0
module.__file__ = str(
    pathlib.Path(sys.argv[2])
    / ".github"
    / "fetch_stock_data"
    / "fetch_stock_data.py"
)
sys.argv = [
    "fetch_stock_data.py",
    "-i",
    "FULL,MISSING,NOINFO,NOMETADATA,NOPRICE,NOTIME,NOCURRENCY,EUR",
]

with redirect_stdout(io.StringIO()):
    status = module.main()

public_path = pathlib.Path(module.__file__).resolve().parent / ".." / ".." / "public"
stat_bytes = (public_path / "stat.json").read_bytes()
print(json.dumps({
    "status": status,
    "stat": json.loads(stat_bytes.decode("utf-8")),
    "statBytesBase64": base64.b64encode(stat_bytes).decode("ascii"),
    "failed": json.loads((public_path / "failed.json").read_text(encoding="utf-8")),
    "quality": json.loads((public_path / "data-quality.json").read_text(encoding="utf-8")),
}))
`

  try {
    const result = runProducerPython(program, [directory])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout)
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

test('public market rows atomically bind USD chart quote price and time', () => {
  const artifact = marketArtifactFromPython()

  assert.equal(artifact.status, 0)
  assert.deepEqual(Object.keys(artifact.stat).sort(), ['FULL', 'MISSING', 'NOINFO'])
  assert.deepEqual(artifact.failed, [
    'NOMETADATA',
    'NOPRICE',
    'NOTIME',
    'NOCURRENCY',
    'EUR',
  ])
  assert.equal(artifact.quality.requested, 8)
  assert.equal(artifact.quality.succeeded, 3)
  assert.equal(artifact.quality.failed, 5)
  for (const stat of Object.values(artifact.stat)) {
    assert.ok(Object.hasOwn(stat, 'asOf'))
    assert.ok(Object.hasOwn(stat, 'observedAt'))
    assert.ok(Object.hasOwn(stat, 'currency'))
    assert.match(stat.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
    assert.equal(Number.isNaN(Date.parse(stat.observedAt)), false)
  }

  assert.equal(artifact.stat.FULL.Close, 321.25)
  assert.equal(artifact.stat.MISSING.Close, 222.5)
  assert.equal(artifact.stat.NOINFO.Close, 111)
  assert.equal(artifact.stat.FULL.asOf, '2025-01-22T21:00:00.000Z')
  assert.equal(artifact.stat.MISSING.asOf, '2025-01-23T21:00:00.000Z')
  assert.equal(artifact.stat.NOINFO.asOf, '2025-01-24T21:00:00.000Z')
  assert.equal(artifact.stat.FULL.observedAt, '2025-08-10T00:01:00.000Z')
  assert.equal(artifact.stat.MISSING.observedAt, '2025-08-10T00:02:00.000Z')
  assert.equal(artifact.stat.NOINFO.observedAt, '2025-08-10T00:03:00.000Z')
  assert.equal(artifact.stat.FULL.currency, 'USD')
  assert.equal(artifact.stat.MISSING.currency, 'USD')
  assert.equal(artifact.stat.NOINFO.currency, 'USD')
})

test('quality manifest binds the exact UTF-8 stat artifact written by the producer', () => {
  const artifact = marketArtifactFromPython()
  const statBytes = Buffer.from(artifact.statBytesBase64, 'base64')
  const statText = statBytes.toString('utf8')
  const expectedArtifact = {
    sha256: createHash('sha256').update(statBytes).digest('hex'),
    bytes: statBytes.length,
    symbols: Object.keys(artifact.stat).length,
  }

  assert.deepEqual(JSON.parse(statText), artifact.stat)
  assert.deepEqual(expectedArtifact, {
    sha256: '163c01da16a690d04a6efa49652d3cc72276617ff49f6736cea6072a7a26ace4',
    bytes: 2735,
    symbols: 3,
  })
  assert.deepEqual(artifact.quality.statArtifact, expectedArtifact)
  assert.equal(artifact.quality.succeeded, expectedArtifact.symbols)
})

test('public market data rows expose finite optional analyst and trading observations', () => {
  const { stat } = marketArtifactFromPython()
  const qualityCoverage = manifestFromPython(5, 6).manifest.coverage
  const optionalFields = [
    'Target Price Low',
    'Target Price High',
    'Forward EPS',
    'Earnings Date',
    'Volume',
    'Average Volume 20D',
    'ATR20',
  ]

  for (const row of Object.values(stat)) {
    for (const field of optionalFields) {
      assert.ok(Object.hasOwn(row, field), field)
    }
  }
  for (const field of optionalFields) {
    assert.equal(Object.hasOwn(qualityCoverage, field), false, field)
  }

  assert.deepEqual(
    Object.fromEntries(optionalFields.map(field => [field, stat.FULL[field]])),
    {
      'Target Price Low': 90.5,
      'Target Price High': 120.25,
      'Forward EPS': 4.2,
      'Earnings Date': '2025-01-01T00:00:00.000Z',
      Volume: 2100,
      'Average Volume 20D': 1150,
      ATR20: 4,
    },
  )
  assert.deepEqual(
    Object.fromEntries(optionalFields.map(field => [field, stat.MISSING[field]])),
    {
      'Target Price Low': '-',
      'Target Price High': '-',
      'Forward EPS': '-',
      'Earnings Date': '-',
      Volume: '-',
      'Average Volume 20D': '-',
      ATR20: 4,
    },
  )
  assert.deepEqual(
    Object.fromEntries(optionalFields.map(field => [field, stat.NOINFO[field]])),
    {
      'Target Price Low': '-',
      'Target Price High': '-',
      'Forward EPS': '-',
      'Earnings Date': '-',
      Volume: 2100,
      'Average Volume 20D': 1150,
      ATR20: 4,
    },
  )
})

test('quality manifest includes PEG coverage for default ranking factors', () => {
  const fixture = manifestFromPython(5, 6).manifest

  assert.ok(Object.hasOwn(fixture.coverage, 'PEG'))
  assert.deepEqual(fixture.coverage.PEG, {
    available: 4,
    total: 5,
    rate: 0.8,
  })
})

test('Python quality checker rejects inconsistent or insufficient field coverage', () => {
  const fixture = manifestFromPython(5, 6)
  const valid = checkTemporaryManifest(fixture.manifest, fixture.statBytesBase64)
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
    {
      name: 'PEG coverage is too low',
      coverage: { available: 2, total: 5, rate: 0.4 },
      field: 'PEG',
      message: /coverage PEG rate 40% is below 50%/,
    },
  ]

  for (const scenario of cases) {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest))
    manifest.coverage[scenario.field || 'ROE'] = scenario.coverage
    const result = checkTemporaryManifest(manifest, fixture.statBytesBase64)

    assert.notEqual(result.status, 0, scenario.name)
    assert.match(result.stdout, scenario.message, scenario.name)
  }
})

test('Python quality checker rejects stat artifact and manifest drift', () => {
  const fixture = manifestFromPython(5, 6)
  const originalBytes = Buffer.from(fixture.statBytesBase64, 'base64')
  const cases = [
    {
      name: 'digest is not for the written bytes',
      mutateManifest(manifest) {
        manifest.statArtifact.sha256 = '0'.repeat(64)
      },
      message: /statArtifact sha256 does not match stat.json/,
    },
    {
      name: 'byte count is not for the written bytes',
      mutateManifest(manifest) {
        manifest.statArtifact.bytes += 1
      },
      message: /statArtifact bytes does not match stat.json/,
    },
    {
      name: 'symbol count conflicts with succeeded',
      mutateManifest(manifest) {
        manifest.statArtifact.symbols -= 1
      },
      message: /statArtifact symbols must equal succeeded/,
    },
    {
      name: 'written bytes changed after manifest generation',
      statBytesBase64: Buffer.concat([
        originalBytes,
        Buffer.from(' ', 'utf8'),
      ]).toString('base64'),
      message: /statArtifact sha256 does not match stat.json/,
    },
  ]

  for (const scenario of cases) {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest))
    scenario.mutateManifest?.(manifest)
    const result = checkTemporaryManifest(
      manifest,
      scenario.statBytesBase64 || fixture.statBytesBase64,
    )

    assert.notEqual(result.status, 0, scenario.name)
    assert.match(result.stdout, scenario.message, scenario.name)
  }
})
