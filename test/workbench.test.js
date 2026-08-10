import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveEvidenceBundle } from '../src/domain/evidence.js'
import { deriveTimingAssessment, projectTimingAssessment } from '../src/domain/timingAssessment.js'
import { evaluateWorkbench } from '../src/domain/workbench.js'
import { createSnapshot } from '../src/domain/contentAddressing.js'
import { AS_OF, NOW, rawCase, sourceSnapshot } from './fixtures/workbench-fixture.js'

test('timing derives evaluated price and rejects caller status/price fields', () => {
  const source = sourceSnapshot()
  const evidenceResult = deriveEvidenceBundle({
    ...rawCase().evidence,
    symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const resolved = [source.resolved, ...evidenceResult.resolvedSnapshots]
  assert.throws(() => deriveTimingAssessment({
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceResult.evidence,
    resolvedSnapshots: resolved, policy: rawCase().timing.policy,
    status: 'FAIL', evaluatedPrice: { value: 1 },
  }), /Timing assessment input is invalid/)
  const timing = deriveTimingAssessment({
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceResult.evidence,
    resolvedSnapshots: resolved, policy: rawCase().timing.policy,
  })
  assert.equal(timing.timingAssessment.status, 'PASS')
  assert.equal(timing.evaluatedPrice.value, 95)
  assert.throws(() => deriveTimingAssessment({
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceResult.evidence,
    resolvedSnapshots: resolved,
    policy: { ...rawCase().timing.policy, requirePassSupport: true },
  }), /Timing assessment input is invalid/)
})

test('timing derivation rejects every derived artifact field at the public seam', () => {
  const source = sourceSnapshot()
  const evidenceResult = deriveEvidenceBundle({
    ...rawCase().evidence,
    symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const base = {
    symbol: 'AAA', evaluatedAt: NOW, evidence: evidenceResult.evidence,
    resolvedSnapshots: [source.resolved, ...evidenceResult.resolvedSnapshots],
    policy: rawCase().timing.policy,
  }
  for (const field of [
    'snapshotRef', 'priceEvidenceId', 'reasonCodes', 'asOf', 'evidenceDigest',
    'timingPolicyRef', 'status', 'evaluatedPrice', 'evidenceIds',
  ]) {
    assert.throws(() => deriveTimingAssessment({ ...base, [field]: {} }),
      /Timing assessment input is invalid/)
  }
})

test('timing derives FAIL and EVENT_RISK from evidence stances', () => {
  const source = sourceSnapshot()
  for (const expected of ['FAIL', 'EVENT_RISK']) {
    const input = rawCase()
    const draft = input.evidence.drafts.find(item => item.key === 'pass')
    const passSupport = { ...draft, key: 'pass-support', stance: 'SUPPORTS' }
    if (expected === 'FAIL') {
      draft.stance = 'CHALLENGES'
      input.evidence.drafts.push(passSupport)
    } else {
      draft.claimKey = 'EVENT_RISK'
      draft.factKey = 'EVENT_RISK'
      input.evidence.drafts.push(passSupport)
    }
    const evidenceResult = deriveEvidenceBundle({
      ...input.evidence, symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
    })
    const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
      evidence: evidenceResult.evidence, resolvedSnapshots: [source.resolved, ...evidenceResult.resolvedSnapshots],
      policy: input.timing.policy })
    assert.equal(timing.timingAssessment.status, expected)
  }
})

test('timing event risk requires independent pass support', () => {
  const input = rawCase()
  const draft = input.evidence.drafts.find(item => item.key === 'pass')
  draft.claimKey = 'EVENT_RISK'
  draft.factKey = 'EVENT_RISK'
  const source = sourceSnapshot()
  const evidenceResult = deriveEvidenceBundle({
    ...input.evidence, symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
    evidence: evidenceResult.evidence,
    resolvedSnapshots: [source.resolved, ...evidenceResult.resolvedSnapshots],
    policy: input.timing.policy })
  assert.equal(timing.timingAssessment.status, 'BLOCKED')
})

test('workbench runs the full headless path and opens the worked case', () => {
  const result = evaluateWorkbench(rawCase())
  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.buyAction, 'OPEN')
  assert.equal(result.evaluatedPrice.value, 95)
  assert.equal(result.underwriting.entryRange.lower, 72.04)
  assert.equal(result.underwriting.entryRange.upper, 96.04)
  assert.ok(result.marketSnapshot?.id)
  assert.ok(result.qualitySnapshot?.id)
  assert.ok(result.researchSnapshot?.id)
  assert.ok(result.underwritingSnapshot?.id)
  assert.doesNotMatch(JSON.stringify(result), /netLiquidationValue|quantity/)
})

test('workbench blocks missing or stale timing quote and ignores supplied timing status', () => {
  const stale = rawCase()
  stale.evidence.drafts[0].asOf = '2026-08-10T07:00:00.000Z'
  stale.sourceSnapshots[0].payload.facts[0].asOf = '2026-08-10T07:00:00.000Z'
  stale.sourceSnapshots[0].payload.asOf = '2026-08-10T07:00:00.000Z'
  stale.sourceSnapshots[0].payload.observedAt = '2026-08-10T07:00:00.000Z'
  stale.timing.status = 'PASS'
  assert.throws(() => evaluateWorkbench(stale), /Derived timing is not accepted/)
  delete stale.timing.status
  const result = evaluateWorkbench(stale)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
})

test('timing projector rejects tampering and wrong symbol', () => {
  const source = sourceSnapshot()
  const evidenceResult = deriveEvidenceBundle({
    ...rawCase().evidence,
    symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const resolved = [source.resolved, ...evidenceResult.resolvedSnapshots]
  const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
    evidence: evidenceResult.evidence, resolvedSnapshots: resolved, policy: rawCase().timing.policy })
  const all = [...resolved, ...timing.resolvedSnapshots]
  assert.equal(projectTimingAssessment({ ...timing.timingAssessment, status: 'FAIL' }, 'AAA',
    evidenceResult.evidence, all, { evaluatedAt: NOW }), null)
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'BBB', evidenceResult.evidence,
    all, { evaluatedAt: NOW }), null)
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'AAA', evidenceResult.evidence,
    [...all, all[0]], { evaluatedAt: NOW }), null)
  const timingResolved = all.find(item => item.id === timing.timingAssessment.snapshotRef.id)
  const wrongAsOf = '2026-08-10T07:00:00.000Z'
  const rehashed = createSnapshot('timing-assessment', {
    ...timingResolved.payload,
    asOf: wrongAsOf,
  })
  assert.equal(projectTimingAssessment({ ...timing.timingAssessment, asOf: wrongAsOf,
    snapshotRef: rehashed.ref }, 'AAA', evidenceResult.evidence,
  [...all.filter(item => item.id !== timingResolved.id), rehashed.resolved], { evaluatedAt: NOW }), null)
})

test('timing projector rejects policy/evidence payload and binding tampering', () => {
  const source = sourceSnapshot()
  const evidenceResult = deriveEvidenceBundle({
    ...rawCase().evidence,
    symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const resolved = [source.resolved, ...evidenceResult.resolvedSnapshots]
  const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
    evidence: evidenceResult.evidence, resolvedSnapshots: resolved, policy: rawCase().timing.policy })
  const all = [...resolved, ...timing.resolvedSnapshots]
  const policy = all.find(item => item.id === timing.timingAssessment.timingPolicyRef.id)
  const tamperedPolicy = structuredClone(policy)
  tamperedPolicy.payload.policy.maxAgeMs = 1
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'AAA', evidenceResult.evidence,
    [...all.filter(item => item.id !== policy.id), tamperedPolicy], { evaluatedAt: NOW }), null)
  assert.equal(projectTimingAssessment({ ...timing.timingAssessment,
    timingPolicyRef: { ...timing.timingAssessment.timingPolicyRef,
      digest: 'sha256:' + '0'.repeat(64) } }, 'AAA', evidenceResult.evidence, all,
  { evaluatedAt: NOW }), null)

  const evidence = all.find(item => item.id === evidenceResult.evidence.snapshotRef.id)
  const tamperedEvidence = structuredClone(evidence)
  tamperedEvidence.payload.items[0].value = 999
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'AAA', evidenceResult.evidence,
    [...all.filter(item => item.id !== evidence.id), tamperedEvidence], { evaluatedAt: NOW }), null)
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'AAA',
    { ...evidenceResult.evidence, digest: 'sha256:' + '0'.repeat(64) }, all,
    { evaluatedAt: NOW }), null)
  assert.equal(projectTimingAssessment({ ...timing.timingAssessment,
    evidenceSnapshotRef: timing.timingAssessment.timingPolicyRef }, 'AAA',
  evidenceResult.evidence, all, { evaluatedAt: NOW }), null)
})

test('timing projector applies strict context freshness to referenced support', () => {
  const input = rawCase()
  const stalePassAsOf = '2026-08-10T07:59:59.999Z'
  const payload = structuredClone(input.sourceSnapshots[0].payload)
  payload.facts = payload.facts.map(fact => fact.factKey === 'TIMING_PASS'
    ? { ...fact, asOf: stalePassAsOf } : fact)
  const source = createSnapshot('source', payload)
  input.sourceSnapshots = [source.resolved]
  input.evidence.drafts = input.evidence.drafts.map(draft => draft.sourceRef
    ? { ...draft, sourceRef: source.ref.id,
        ...(draft.key === 'pass' ? { asOf: stalePassAsOf } : {}) }
    : draft)
  const evidenceResult = deriveEvidenceBundle({
    ...input.evidence, symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const resolved = [source.resolved, ...evidenceResult.resolvedSnapshots]
  const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
    evidence: evidenceResult.evidence, resolvedSnapshots: resolved, policy: input.timing.policy })
  assert.equal(projectTimingAssessment(timing.timingAssessment, 'AAA', evidenceResult.evidence,
    [...resolved, ...timing.resolvedSnapshots], {
      evaluatedAt: NOW, maxInputAgeMs: 0, maxFutureSkewMs: 60_000,
    }), null)
})

test('a derived BLOCKED timing artifact yields no partial timing projection', () => {
  const source = sourceSnapshot()
  const input = rawCase()
  input.evidence.drafts = input.evidence.drafts.filter(draft => !['price', 'pass'].includes(draft.key))
  const evidenceResult = deriveEvidenceBundle({
    ...input.evidence, symbol: 'AAA', evaluatedAt: NOW, resolvedSnapshots: [source.resolved],
  })
  const timing = deriveTimingAssessment({ symbol: 'AAA', evaluatedAt: NOW,
    evidence: evidenceResult.evidence, resolvedSnapshots: [source.resolved, ...evidenceResult.resolvedSnapshots],
    policy: input.timing.policy })
  assert.equal(timing.timingAssessment.status, 'BLOCKED')
  assert.equal(timing.evaluatedPrice, null)
})

test('workbench rejects injected derived fields at every public boundary', () => {
  for (const field of ['buyAction', 'evaluatedPrice', 'portfolioCapacity', 'timingAssessment',
    'decisionRecord', 'resolvedSnapshots']) {
    const input = rawCase({ [field]: {} })
    assert.throws(() => evaluateWorkbench(input), /Derived workbench fields are not accepted/)
  }
  const nested = [
    ['evidence', 'items'], ['underwriting', 'entryRange'], ['timing', 'status'],
    ['portfolio', 'currentPosition'], ['decisionPolicy', 'ref'],
  ]
  for (const [section, field] of nested) {
    const input = rawCase()
    input[section][field] = {}
    assert.throws(() => evaluateWorkbench(input), /Derived/)
  }
  const topLevelTimingAlias = rawCase()
  topLevelTimingAlias.timingPolicy = topLevelTimingAlias.timing.policy
  assert.throws(() => evaluateWorkbench(topLevelTimingAlias), /Derived workbench fields/)
  const nestedTimingAlias = rawCase()
  nestedTimingAlias.timing = { timingPolicy: nestedTimingAlias.timing.policy }
  assert.throws(() => evaluateWorkbench(nestedTimingAlias), /Timing input must contain only policy/)

  for (const field of ['universe', 'qualityManifest', 'policy', 'researchPolicy']) {
    const input = rawCase()
    input[field] = {}
    assert.throws(() => evaluateWorkbench(input), /canonical|Derived workbench fields/)
  }
  const nestedResearchPolicyAlias = rawCase()
  nestedResearchPolicyAlias.research.policy = { research: nestedResearchPolicyAlias.research.policy }
  assert.throws(() => evaluateWorkbench(nestedResearchPolicyAlias), /nested|canonical/)
})

test('workbench preserves input and calls capacity independently when another stage fails', () => {
  const input = rawCase()
  input.evidence.drafts = [{}]
  const before = JSON.stringify(input)
  const result = evaluateWorkbench(input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.ok(result.capacitySummary?.effectiveLimit > 0)
  assert.ok(result.blockerCodes.includes('INVALID_EVIDENCE_BUNDLE'))

  const badResearch = rawCase()
  badResearch.research.policy = {}
  const researchResult = evaluateWorkbench(badResearch)
  assert.equal(researchResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(researchResult.capacitySummary?.effectiveLimit > 0)

  const badCapacity = rawCase()
  delete badCapacity.portfolio
  const capacityResult = evaluateWorkbench(badCapacity)
  assert.equal(capacityResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(capacityResult.capacitySummary, null)
  assert.ok(capacityResult.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

test('malformed or duplicate source snapshots are semantic evidence failures', () => {
  const malformed = rawCase()
  malformed.sourceSnapshots = [{ payload: { role: 'SOURCE' } }]
  const malformedResult = evaluateWorkbench(malformed)
  assert.equal(malformedResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(malformedResult.buyAction, 'NO_ACTION')
  assert.ok(malformedResult.blockerCodes.includes('INVALID_EVIDENCE_BUNDLE'))

  const duplicate = rawCase()
  duplicate.sourceSnapshots = [duplicate.sourceSnapshots[0], duplicate.sourceSnapshots[0]]
  const duplicateResult = evaluateWorkbench(duplicate)
  assert.equal(duplicateResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(duplicateResult.buyAction, 'NO_ACTION')
  assert.ok(duplicateResult.blockerCodes.includes('INVALID_EVIDENCE_BUNDLE'))
})

test('timing overlap and missing pass support fail closed without changing long-term gate', () => {
  const overlap = rawCase()
  overlap.evidence.gatePolicy.gates[0].claimKey = 'TIMING_PASS'
  const overlapResult = evaluateWorkbench(overlap)
  assert.equal(overlapResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(overlapResult.blockerCodes.includes('INVALID_TIMING_ASSESSMENT'))

  const noPass = rawCase()
  noPass.evidence.drafts = noPass.evidence.drafts.filter(draft => draft.key !== 'pass')
  const noPassResult = evaluateWorkbench(noPass)
  assert.equal(noPassResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(noPassResult.buyAction, 'NO_ACTION')
  assert.ok(noPassResult.blockerCodes.includes('TIMING_BLOCKED'))
  assert.equal(noPassResult.underwriting.longTermGate, 'PASS')
})

test('workbench derives the five actions from the same long-term case', () => {
  assert.equal(evaluateWorkbench(rawCase()).buyAction, 'OPEN')

  const add = rawCase()
  add.portfolio.portfolio.positions = [{ symbol: 'AAA', quantity: 1000, markPrice: 1,
    asOf: AS_OF, currency: 'USD', assetType: 'EQUITY', side: 'LONG', sector: 'Technology',
    industry: 'Software' }]
  assert.equal(evaluateWorkbench(add).buyAction, 'ADD')

  const pilot = rawCase()
  const event = pilot.evidence.drafts.find(draft => draft.key === 'pass')
  pilot.evidence.drafts.push({ ...event, key: 'pass-support', stance: 'SUPPORTS' })
  event.claimKey = 'EVENT_RISK'
  event.factKey = 'EVENT_RISK'
  assert.equal(evaluateWorkbench(pilot).buyAction, 'PILOT')

  const watch = rawCase()
  watch.evidence.drafts.find(draft => draft.key === 'pass').stance = 'CHALLENGES'
  assert.equal(evaluateWorkbench(watch).buyAction, 'WATCH')

  const noAction = rawCase()
  noAction.portfolio.liquidity.maxPositionWeight = 0
  assert.equal(evaluateWorkbench(noAction).buyAction, 'NO_ACTION')
})

test('a stale quote is a canonical timing block with no evaluated price', () => {
  const input = rawCase()
  const staleAsOf = '2026-08-10T07:30:00.000Z'
  const payload = structuredClone(input.sourceSnapshots[0].payload)
  payload.facts = payload.facts.map(fact => fact.factKey === 'CURRENT_PRICE'
    ? { ...fact, asOf: staleAsOf } : fact)
  const source = createSnapshot('source', payload)
  input.sourceSnapshots = [source.resolved]
  input.evidence.drafts = input.evidence.drafts.map(draft => draft.sourceRef
    ? { ...draft, sourceRef: source.ref.id,
        ...(draft.key === 'price' ? { asOf: staleAsOf } : {}) }
    : draft)
  const result = evaluateWorkbench(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.evaluatedPrice, null)
  assert.equal(result.timingAssessment, null)
  assert.ok(result.blockerCodes.includes('TIMING_BLOCKED'))
})

test('missing and conflicting current quotes never select a price', () => {
  const missing = rawCase()
  missing.evidence.drafts = missing.evidence.drafts.filter(draft => draft.key !== 'price')
  const missingResult = evaluateWorkbench(missing)
  assert.equal(missingResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(missingResult.evaluatedPrice, null)
  assert.ok(missingResult.blockerCodes.includes('TIMING_BLOCKED'))

  const conflict = rawCase()
  const original = conflict.sourceSnapshots[0]
  const prior = '2026-08-10T07:59:00.000Z'
  const payload = structuredClone(original.payload)
  payload.facts = [...payload.facts,
    { factKey: 'CURRENT_PRICE', value: 96, asOf: prior, scope: { symbol: 'AAA' }, currency: 'USD' }]
  const source = createSnapshot('source', payload)
  conflict.sourceSnapshots = [source.resolved]
  conflict.evidence.drafts = conflict.evidence.drafts.map(draft => draft.sourceRef
    ? { ...draft, sourceRef: source.ref.id } : draft)
  conflict.evidence.drafts.push({ key: 'price-2', claimKey: 'PRICE', factKey: 'CURRENT_PRICE',
    value: 96, sourceRef: source.ref.id, asOf: prior, scope: { symbol: 'AAA' },
    currency: 'USD', stance: 'SUPPORTS', confidence: 1 })
  const conflictResult = evaluateWorkbench(conflict)
  assert.equal(conflictResult.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(conflictResult.evaluatedPrice, null)
  assert.ok(conflictResult.blockerCodes.includes('TIMING_BLOCKED') ||
    conflictResult.blockerCodes.includes('INVALID_EVIDENCE_BUNDLE'))
})
