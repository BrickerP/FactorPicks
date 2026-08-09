const LONG_TERM_GATE_STATUSES = new Set(['PASS', 'FAIL'])
const THESIS_STATUSES = new Set(['INTACT', 'INVALIDATED'])
const VALUATION_STATUSES = new Set(['PASS', 'FAIL'])
const TIMING_STATUSES = new Set(['PASS', 'EVENT_RISK', 'FAIL'])
const EVENT_RISK_MODES = new Set(['downgrade', 'block'])

const CAPACITY_REASON_BY_FIELD = Object.freeze({
  userHardLimit: 'USER_HARD_LIMIT_REQUIRED',
  systemRiskLimit: 'SYSTEM_RISK_LIMIT_REQUIRED',
  sectorRemainingCapacity: 'SECTOR_REMAINING_CAPACITY_REQUIRED',
  portfolioRemainingCapacity: 'PORTFOLIO_REMAINING_CAPACITY_REQUIRED',
})
const STRICTLY_POSITIVE_CAPACITY_FIELDS = new Set([
  'userHardLimit',
  'systemRiskLimit',
])

function capacityFor(underwriting, portfolio) {
  const capacity = {
    userHardLimit: portfolio.userHardLimit,
    systemRiskLimit: underwriting.systemRiskLimit,
    sectorRemainingCapacity: portfolio.sectorRemainingCapacity,
    portfolioRemainingCapacity: portfolio.portfolioRemainingCapacity,
  }
  const invalidFields = Object.entries(capacity)
    .filter(([field, value]) => !Number.isFinite(value) || value < 0 ||
      (STRICTLY_POSITIVE_CAPACITY_FIELDS.has(field) && value === 0))
    .map(([field]) => CAPACITY_REASON_BY_FIELD[field])
  const currentPositionIsValid = Number.isFinite(portfolio.currentPosition) &&
    portfolio.currentPosition >= 0

  capacity.effectiveLimit = invalidFields.length === 0 && currentPositionIsValid
    ? Math.min(
        capacity.userHardLimit,
        capacity.systemRiskLimit,
        portfolio.currentPosition + capacity.sectorRemainingCapacity,
        portfolio.currentPosition + capacity.portfolioRemainingCapacity,
      )
    : null

  return { capacity, invalidFields }
}

function decisionRecord(context, {
  dataStatus = 'VALID',
  buyAction,
  holdingRisk = 'NONE',
  recommendedPosition = null,
  reasonCodes,
}) {
  return {
    symbol: context.symbol,
    decidedAt: context.decidedAt,
    dataStatus,
    buyAction,
    holdingRisk,
    recommendedPosition,
    capacity: context.capacity,
    reasonCodes,
  }
}

function blockedDecision(context, reasonCodes) {
  return decisionRecord(context, {
    dataStatus: 'BLOCKED',
    buyAction: 'NO_ACTION',
    reasonCodes,
  })
}

export function evaluateDecision({ research, underwriting, portfolio, policy, now }) {
  const { capacity, invalidFields } = capacityFor(underwriting, portfolio)
  const context = {
    symbol: research.symbol,
    decidedAt: new Date(now).toISOString(),
    capacity,
  }

  if (research.dataStatus === 'BLOCKED') {
    const reasonCodes = [...new Set(research.blockers.map(blocker => blocker.code))]
    return blockedDecision(context, reasonCodes)
  }

  const { currentPosition } = portfolio
  if (!Number.isFinite(currentPosition) || currentPosition < 0) {
    return blockedDecision(context, ['CURRENT_POSITION_REQUIRED'])
  }
  const holding = currentPosition > 0

  if (!LONG_TERM_GATE_STATUSES.has(underwriting.longTermGate)) {
    return blockedDecision(context, ['INVALID_LONG_TERM_GATE'])
  }
  if (underwriting.longTermGate === 'FAIL') {
    return decisionRecord(context, {
      buyAction: holding ? 'NO_ACTION' : 'WATCH',
      holdingRisk: holding ? 'REVIEW' : 'NONE',
      reasonCodes: ['LONG_TERM_GATE_FAILED'],
    })
  }

  if (!THESIS_STATUSES.has(underwriting.thesisStatus)) {
    return blockedDecision(context, ['INVALID_THESIS_STATUS'])
  }
  if (underwriting.thesisStatus === 'INVALIDATED') {
    return decisionRecord(context, {
      buyAction: holding ? 'NO_ACTION' : 'WATCH',
      holdingRisk: holding ? 'EXIT_REVIEW' : 'NONE',
      reasonCodes: ['THESIS_INVALIDATED'],
    })
  }

  if (!VALUATION_STATUSES.has(underwriting.valuationStatus)) {
    return blockedDecision(context, ['INVALID_VALUATION_STATUS'])
  }
  if (underwriting.valuationStatus === 'FAIL') {
    return decisionRecord(context, {
      buyAction: 'WATCH',
      reasonCodes: ['VALUATION_FAILED'],
    })
  }

  if (invalidFields.length > 0) {
    return blockedDecision(context, invalidFields)
  }
  if (currentPosition > capacity.effectiveLimit) {
    return decisionRecord(context, {
      buyAction: 'NO_ACTION',
      holdingRisk: 'REDUCE_REVIEW',
      reasonCodes: ['POSITION_ABOVE_EFFECTIVE_LIMIT'],
    })
  }
  if (capacity.effectiveLimit === 0) {
    return decisionRecord(context, {
      buyAction: 'NO_ACTION',
      reasonCodes: ['NO_EFFECTIVE_CAPACITY'],
    })
  }
  if (currentPosition === capacity.effectiveLimit) {
    return decisionRecord(context, {
      buyAction: 'NO_ACTION',
      reasonCodes: ['POSITION_AT_EFFECTIVE_LIMIT'],
    })
  }

  const decisionPolicy = policy?.decision
  if (!EVENT_RISK_MODES.has(decisionPolicy?.eventRiskMode)) {
    return blockedDecision(context, ['INVALID_EVENT_RISK_MODE'])
  }
  if (!Number.isFinite(decisionPolicy.pilotPositionLimit) ||
      decisionPolicy.pilotPositionLimit <= 0) {
    return blockedDecision(context, ['INVALID_PILOT_POSITION_LIMIT'])
  }

  if (!TIMING_STATUSES.has(underwriting.timingStatus)) {
    return blockedDecision(context, ['INVALID_TIMING_STATUS'])
  }
  if (underwriting.timingStatus === 'FAIL') {
    return decisionRecord(context, {
      buyAction: holding ? 'NO_ACTION' : 'WATCH',
      reasonCodes: ['TIMING_FAILED'],
    })
  }
  if (underwriting.timingStatus === 'EVENT_RISK') {
    const pilotPosition = decisionPolicy.eventRiskMode === 'downgrade'
      ? Math.min(decisionPolicy.pilotPositionLimit, capacity.effectiveLimit)
      : null
    const pilot = pilotPosition > currentPosition
    return decisionRecord(context, {
      buyAction: pilot ? 'PILOT' : holding ? 'NO_ACTION' : 'WATCH',
      recommendedPosition: pilot ? pilotPosition : null,
      reasonCodes: ['EVENT_RISK'],
    })
  }

  if (currentPosition === 0) {
    return decisionRecord(context, {
      buyAction: 'OPEN',
      recommendedPosition: capacity.effectiveLimit,
      reasonCodes: ['ALL_GATES_PASSED'],
    })
  }
  if (currentPosition < capacity.effectiveLimit) {
    return decisionRecord(context, {
      buyAction: 'ADD',
      recommendedPosition: capacity.effectiveLimit,
      reasonCodes: ['ALL_GATES_PASSED'],
    })
  }

  throw new Error('Unsupported decision state')
}
