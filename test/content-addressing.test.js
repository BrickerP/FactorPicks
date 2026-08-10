import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalize,
  createSnapshot,
  digest,
  resolvedSnapshotsById,
} from '../src/domain/contentAddressing.js'

test('content addressing matches an independent fixed SHA-256 vector', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(
    digest({ b: 2, a: 1 }),
    'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  )
})

test('content snapshots bind identity to canonical payload and reject duplicate resolution ids', () => {
  const snapshot = createSnapshot('example', { b: 2, a: 1 })
  assert.equal(snapshot.ref.digest, digest({ a: 1, b: 2 }))
  assert.equal(resolvedSnapshotsById([snapshot.resolved]).get(snapshot.ref.id), snapshot.resolved)
  assert.equal(resolvedSnapshotsById([snapshot.resolved, snapshot.resolved]), null)
})
