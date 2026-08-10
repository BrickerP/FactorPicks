import { createHash } from 'node:crypto'

const OPAQUE_REF_PATTERN = /^[a-z][a-z0-9-]*:[0-9a-f]{64}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Content must be JSON-compatible')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (!isObject(value)) throw new TypeError('Content must be JSON-compatible')
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export function opaqueRef(kind, value) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind) ||
      typeof value !== 'string') throw new TypeError('Content identity input is invalid')
  return `${kind}:${createHash('sha256').update(value).digest('hex')}`
}

export function isOpaqueRef(value) {
  return typeof value === 'string' && OPAQUE_REF_PATTERN.test(value)
}

export function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

export function isSnapshotRef(value) {
  return isObject(value) && isOpaqueRef(value.id) &&
    isOpaqueRef(value.version) && isDigest(value.digest)
}

export function snapshotIdentity(value) {
  return { id: value.id, version: value.version, digest: value.digest }
}

export function createSnapshot(kind, payload, schemaVersion = 1) {
  const payloadDigest = digest(payload)
  const id = opaqueRef(kind, payloadDigest)
  const version = opaqueRef('version', `${kind}:${schemaVersion}:${payloadDigest}`)
  return {
    ref: { id, version, digest: payloadDigest },
    resolved: { id, version, payload },
  }
}

export function sameCanonical(left, right) {
  try {
    return canonicalize(left) === canonicalize(right)
  } catch {
    return false
  }
}

export function resolvedSnapshotsById(resolvedSnapshots) {
  if (resolvedSnapshots instanceof Map) return resolvedSnapshots
  if (!Array.isArray(resolvedSnapshots)) return null
  const result = new Map()
  for (const resolved of resolvedSnapshots) {
    if (!isObject(resolved) || !isOpaqueRef(resolved.id) || result.has(resolved.id)) return null
    result.set(resolved.id, resolved)
  }
  return result
}
