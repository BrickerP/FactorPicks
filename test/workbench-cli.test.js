import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rawCase } from './fixtures/workbench-fixture.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/evaluate-workbench.js')

function run(args, input, cwd = ROOT) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd,
    input,
    encoding: 'utf8',
  })
}

test('workbench CLI accepts a file or stdin and emits one decision record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-workbench-'))
  const inputPath = join(directory, 'case.json')
  try {
    const input = JSON.stringify(rawCase())
    writeFileSync(inputPath, input)
    const fromFile = run([inputPath])
    const fromStdin = run(['-'], input)
    for (const result of [fromFile, fromStdin]) {
      assert.equal(result.status, 0, result.stderr)
      const decision = JSON.parse(result.stdout)
      assert.equal(decision.buyAction, 'OPEN')
      assert.equal(decision.underwriting.entryRange.lower, 72.04)
      assert.equal(decision.underwriting.entryRange.upper, 96.04)
      assert.doesNotMatch(result.stdout, /netLiquidationValue|quantity|accountId/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workbench CLI without an input path reads implicit stdin', () => {
  const result = run([], JSON.stringify(rawCase()))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).buyAction, 'OPEN')
})

test('semantic failures return safe blocked output while malformed JSON exits one', () => {
  const stale = rawCase()
  stale.evidence.drafts = stale.evidence.drafts.filter(draft =>
    !['price', 'pass'].includes(draft.key))
  const semantic = run(['-'], JSON.stringify(stale))
  assert.equal(semantic.status, 0)
  const decision = JSON.parse(semantic.stdout)
  assert.equal(decision.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(decision.buyAction, 'NO_ACTION')

  const malformedSnapshots = rawCase()
  malformedSnapshots.sourceSnapshots = [{ payload: { role: 'SOURCE' } }]
  const malformedResult = run(['-'], JSON.stringify(malformedSnapshots))
  assert.equal(malformedResult.status, 0)
  assert.equal(JSON.parse(malformedResult.stdout).buyAction, 'NO_ACTION')

  const duplicateSnapshots = rawCase()
  duplicateSnapshots.sourceSnapshots = [
    duplicateSnapshots.sourceSnapshots[0], duplicateSnapshots.sourceSnapshots[0],
  ]
  const duplicateResult = run(['-'], JSON.stringify(duplicateSnapshots))
  assert.equal(duplicateResult.status, 0)
  assert.equal(JSON.parse(duplicateResult.stdout).buyAction, 'NO_ACTION')

  const invalid = run(['-'], '{"privateSecret":"do-not-echo"')
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /valid JSON/i)
  assert.doesNotMatch(invalid.stderr, /do-not-echo/)
})

test('ledger is optional and must resolve to an external regular path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-workbench-ledger-'))
  const ledger = join(directory, 'decisions.jsonl')
  const symlink = join(directory, 'ledger-link')
  try {
    const result = run(['-', '--ledger', ledger], JSON.stringify(rawCase()))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(ledger, 'utf8').trim(), result.stdout.trim())
    assert.equal((statSync(ledger).mode & 0o077), 0)
    const second = run(['-', '--ledger', ledger], JSON.stringify(rawCase()))
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 2)
    const inside = run(['-', '--ledger', join(ROOT, 'tmp-ledger.json')], JSON.stringify(rawCase()))
    assert.equal(inside.status, 1)
    symlinkSync(ledger, symlink)
    const linked = run(['-', '--ledger', symlink], JSON.stringify(rawCase()))
    assert.equal(linked.status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('blocked ledger output is one private-safe line identical to stdout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-workbench-blocked-ledger-'))
  const ledger = join(directory, 'blocked.jsonl')
  try {
    const input = rawCase()
    input.evidence.drafts = input.evidence.drafts.filter(draft =>
      !['price', 'pass'].includes(draft.key))
    const result = run(['-', '--ledger', ledger], JSON.stringify(input))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.equal(readFileSync(ledger, 'utf8'), result.stdout)
    assert.doesNotMatch(result.stdout, /netLiquidationValue|quantity|accountId|condition|response|predicate/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ledger rejects permissive files, symlink parents, devices, and unsafe input errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-workbench-safety-'))
  const ledger = join(directory, 'ledger.jsonl')
  const parentTarget = join(directory, 'target')
  const parentLink = join(directory, 'parent-link')
  try {
    writeFileSync(ledger, '')
    chmodSync(ledger, 0o644)
    const permissive = run(['-', '--ledger', ledger], JSON.stringify(rawCase()))
    assert.equal(permissive.status, 1)
    rmSync(ledger)
    mkdirSync(parentTarget)
    symlinkSync(parentTarget, parentLink)
    const linkedParent = run(['-', '--ledger', join(parentLink, 'ledger.jsonl')],
      JSON.stringify(rawCase()))
    assert.equal(linkedParent.status, 1)
    const ancestorTarget = join(directory, 'ancestor-target')
    const ancestorLink = join(directory, 'ancestor-link')
    mkdirSync(join(ancestorTarget, 'existing-child'), { recursive: true })
    symlinkSync(ancestorTarget, ancestorLink)
    const existingChildEscape = run(['-', '--ledger',
      join(ancestorLink, 'existing-child', 'ledger.jsonl')], JSON.stringify(rawCase()))
    assert.equal(existingChildEscape.status, 1)
    const device = run(['-', '--ledger', '/dev/null'], JSON.stringify(rawCase()))
    assert.equal(device.status, 1)
    const invalid = run(['--bogus'], '{"privateSecret":"no-echo"}')
    assert.equal(invalid.status, 1)
    assert.doesNotMatch(invalid.stderr, /privateSecret|no-echo/)
    const missing = run([join(directory, 'missing-private-secret.json')])
    assert.equal(missing.status, 1)
    assert.doesNotMatch(missing.stderr, /missing-private-secret/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('relative external ledger uses the caller cwd and does not create temp files without ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factorpicks-workbench-relative-'))
  try {
    const result = run(['-', '--ledger', 'relative-ledger.jsonl'], JSON.stringify(rawCase()), directory)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(directory, 'relative-ledger.jsonl')), true)
    const noLedger = run(['-'], JSON.stringify(rawCase()), directory)
    assert.equal(noLedger.status, 0, noLedger.stderr)
    assert.deepEqual(
      readdirSync(directory).sort(),
      ['relative-ledger.jsonl'],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
