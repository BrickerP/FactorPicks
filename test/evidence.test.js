import test from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot } from '../src/domain/contentAddressing.js'
import { deriveEvidenceBundle, projectEvidenceBundle } from '../src/domain/evidence.js'
import { evidenceInput, sourceSnapshot } from './fixtures/underwriting-fixture.js'

test('Evidence builder derives source quality, derivation, gate and immutable identity', () => {
  const input = evidenceInput()
  const original = structuredClone(input)
  const result = deriveEvidenceBundle(input)
  const resolved = input.resolvedSnapshots.concat(result.resolvedSnapshots)
  const projected = projectEvidenceBundle(result.evidence, 'AAA', resolved)
  assert.equal(projected.longTermGate, 'PASS')
  assert.deepEqual(new Set(projected.items.map(item => item.derivation)), new Set(['OBSERVED', 'INFERRED']))
  assert.ok(projected.items.every(item => item.sourceQuality === 'PRIMARY'))
  assert.deepEqual(input, original)
})

test('Evidence drafts cannot self-assert final fields or mismatch observed source facts', () => {
  for (const mutation of [
    draft => { draft.sourceQuality = 'PRIMARY' },
    draft => { draft.derivation = 'OBSERVED' },
    draft => { draft.value = 101 },
    draft => { draft.currency = 'EUR' },
  ]) {
    const input = evidenceInput()
    mutation(input.drafts[0])
    assert.throws(() => deriveEvidenceBundle(input), { code: 'INVALID_EVIDENCE_INPUT' })
  }
})

test('analyst consensus and Yahoo target provenance is always secondary', () => {
  assert.throws(() => deriveEvidenceBundle(evidenceInput({
    sourcePolicy: { schemaVersion: 1, kinds: { SEC_FILING: 'PRIMARY', YAHOO_TARGET: 'PRIMARY' } },
  })))
})

test('Evidence inferred graph rejects cycles, pure inference and cross-scope parents', () => {
  const cycle = evidenceInput()
  cycle.drafts = [
    { key: 'a', claimKey: 'THESIS', factKey: 'A', value: 1, inputKeys: ['b'], asOf: cycle.evaluatedAt,
      scope: { symbol: 'AAA' }, stance: 'SUPPORTS', confidence: 1 },
    { key: 'b', claimKey: 'THESIS', factKey: 'B', value: 1, inputKeys: ['a'], asOf: cycle.evaluatedAt,
      scope: { symbol: 'AAA' }, stance: 'SUPPORTS', confidence: 1 },
  ]
  assert.throws(() => deriveEvidenceBundle(cycle))
  const cross = evidenceInput()
  cross.drafts[2].scope = { symbol: 'AAA', universe: 'OTHER' }
  assert.throws(() => deriveEvidenceBundle(cross))
  const parentAfterChild = evidenceInput()
  parentAfterChild.drafts[2].asOf = '2026-08-09T07:54:00.000Z'
  assert.throws(() => deriveEvidenceBundle(parentAfterChild))
})

test('material challenges fail and missing required support blocks instead of forging PASS', () => {
  const challenged = evidenceInput()
  challenged.drafts[0].stance = 'CHALLENGES'
  assert.equal(deriveEvidenceBundle(challenged).evidence.longTermGate, 'FAIL')
  const missing = evidenceInput({ drafts: [evidenceInput().drafts[1]] })
  assert.equal(deriveEvidenceBundle(missing).evidence.longTermGate, 'BLOCKED')
})

test('conflicting, stale, future and non-canonical evidence fail closed', () => {
  const conflict = evidenceInput()
  conflict.drafts.push({ ...conflict.drafts[0], key: 'conflict', value: 99 })
  assert.throws(() => deriveEvidenceBundle(conflict))
  assert.throws(() => deriveEvidenceBundle(evidenceInput({ evaluatedAt: '2026-08-10T08:00:00.000Z' })))
  assert.throws(() => deriveEvidenceBundle(evidenceInput({ evaluatedAt: '2026-08-09T07:00:00.000Z' })))
  assert.throws(() => deriveEvidenceBundle(evidenceInput({ symbol: 'aaa' })))
})

test('Evidence projector rejects artifact, policy, snapshot and duplicate-id tampering', () => {
  const input = evidenceInput()
  const built = deriveEvidenceBundle(input)
  const resolved = input.resolvedSnapshots.concat(built.resolvedSnapshots)
  const tampered = structuredClone(built.evidence)
  tampered.items[0].confidence = 0
  assert.equal(projectEvidenceBundle(tampered, 'AAA', resolved), null)
  const badResolved = structuredClone(resolved)
  badResolved.at(-1).payload.longTermGate = 'FAIL'
  assert.equal(projectEvidenceBundle(built.evidence, 'AAA', badResolved), null)
  assert.equal(projectEvidenceBundle(built.evidence, 'AAA', resolved.concat(resolved[0])), null)

  for (const role of ['SOURCE', 'SOURCE_POLICY', 'GATE_POLICY']) {
    const independentlyTampered = structuredClone(resolved)
    const target = independentlyTampered.find(item => item.payload?.role === role)
    target.payload.asOf = '2026-08-09T07:54:59.000Z'
    assert.equal(projectEvidenceBundle(built.evidence, 'AAA', independentlyTampered), null, role)
  }
})
