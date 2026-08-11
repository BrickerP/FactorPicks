import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectRobinhoodRead,
  deriveRobinhoodPortfolioInput,
} from '../src/domain/robinhoodPortfolio.js'
import { evaluateSymbolCase } from '../src/domain/evaluateSymbolCase.js'
import { NOW } from './fixtures/workbench-fixture.js'
import {
  ACCOUNT_NUMBER,
  addRead,
  robinhoodPosition,
  robinhoodQuoteResult,
  robinhoodRead,
} from './fixtures/robinhood-portfolio-fixture.js'
import { symbolMarketCase } from './fixtures/symbol-market-case-fixture.js'

function capacityPolicy() {
  return symbolMarketCase().privateCase.capacityPolicy
}

test('normalizes an empty Robinhood target into the existing portfolio-capacity input', () => {
  const stat = JSON.parse(symbolMarketCase().statArtifact)
  const derived = deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat,
    robinhoodRead: robinhoodRead(), capacityPolicy: capacityPolicy(),
  })

  assert.equal(derived.portfolio.positions.length, 0)
  assert.deepEqual(derived.portfolio.targetClassification,
    { sector: 'Technology', industry: 'Software' })
  assert.doesNotMatch(JSON.stringify(derived.portfolio.sourceRef), /RH-PRIVATE|4321/)
})

test('evaluates an empty target as OPEN and a target on a later page as ADD', () => {
  assert.equal(evaluateSymbolCase(symbolMarketCase()).buyAction, 'OPEN')
  assert.equal(evaluateSymbolCase(symbolMarketCase({ robinhoodRead: addRead() })).buyAction, 'ADD')
})

test('fails an invalid Robinhood bundle closed through the DecisionRecord seam', () => {
  const input = symbolMarketCase()
  input.robinhoodRead.portfolio.data.total_value = '0'
  const result = evaluateSymbolCase(input)

  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

test('derives NO_ACTION through the existing capacity formula when capacity is zero', () => {
  const input = symbolMarketCase()
  input.privateCase.capacityPolicy.liquidity.maxPositionWeight = 0
  const result = evaluateSymbolCase(input)

  assert.equal(result.dataStatus, 'VALID')
  assert.equal(result.buyAction, 'NO_ACTION')
  assert.deepEqual(result.reasonCodes, ['NO_EFFECTIVE_CAPACITY'])
})

test('selects the newer non-regular quote and rejects an equal-time price conflict', () => {
  const stat = JSON.parse(symbolMarketCase().statArtifact)
  const chosen = robinhoodQuoteResult('BBB', '40', '2026-08-10T07:59:00.000Z')
  chosen.quote.last_non_reg_trade_price = '50'
  chosen.quote.venue_last_non_reg_trade_time = '2026-08-10T08:00:00.000Z'
  const read = robinhoodRead({
    positions: [robinhoodPosition('BBB')],
    quoteBatches: [{ requestedSymbols: ['BBB'], results: [chosen] }],
  })
  const derived = deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat, robinhoodRead: read,
    capacityPolicy: capacityPolicy(),
  })
  assert.equal(derived.portfolio.positions[0].markPrice, 50)

  chosen.quote.venue_last_non_reg_trade_time = chosen.quote.venue_last_trade_time
  assert.throws(() => deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat, robinhoodRead: read,
    capacityPolicy: capacityPolicy(),
  }), /Robinhood portfolio input is invalid/)
})

test('rejects stale quotes, incomplete pagination, oversized batches, and missing classifications', () => {
  const stat = JSON.parse(symbolMarketCase().statArtifact)
  const policy = capacityPolicy()
  const stale = robinhoodRead({
    positions: [robinhoodPosition('BBB')],
    quoteBatches: [{ requestedSymbols: ['BBB'], results: [
      robinhoodQuoteResult('BBB', '50', '2026-08-10T07:00:00.000Z'),
    ] }],
  })
  assert.throws(() => deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat, robinhoodRead: stale, capacityPolicy: policy,
  }))

  const incomplete = addRead()
  incomplete.positionPages.pop()
  assert.throws(() => deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat, robinhoodRead: incomplete, capacityPolicy: policy,
  }))

  const oversized = robinhoodRead()
  oversized.quoteBatches = [{
    requestedSymbols: Array.from({ length: 21 }, (_, index) => `A${index}`),
    results: [],
  }]
  assert.throws(() => deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat, robinhoodRead: oversized, capacityPolicy: policy,
  }))

  const noClassification = structuredClone(stat)
  delete noClassification.BBB.industry
  const holding = robinhoodRead({ positions: [robinhoodPosition('BBB')] })
  assert.throws(() => deriveRobinhoodPortfolioInput({
    symbol: 'AAA', evaluatedAt: NOW, stat: noClassification,
    robinhoodRead: holding, capacityPolicy: policy,
  }))
})

test('preserves inputs, emits account-independent refs, and keeps broker facts out of records', () => {
  const input = symbolMarketCase({ robinhoodRead: addRead() })
  const before = structuredClone(input)
  const result = evaluateSymbolCase(input)
  const serialized = JSON.stringify(result)

  assert.deepEqual(input, before)
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT_NUMBER))
  assert.doesNotMatch(serialized,
    /account_number|selectedAccountNumber|cursor|total_value|netLiquidationValue|quantity|markPrice|last_trade_price/)
})

test('rejects derived/order aliases and non-equity account value at the adapter seam', () => {
  const stat = JSON.parse(symbolMarketCase().statArtifact)
  const base = {
    symbol: 'AAA', evaluatedAt: NOW, stat,
    robinhoodRead: robinhoodRead(), capacityPolicy: capacityPolicy(),
  }
  assert.throws(() => deriveRobinhoodPortfolioInput({ ...base, buyAction: 'ADD' }),
    /Robinhood portfolio input is invalid/)
  assert.throws(() => deriveRobinhoodPortfolioInput({
    ...base,
    capacityPolicy: { ...base.capacityPolicy, order: { symbol: 'AAA' } },
  }), /Robinhood portfolio input is invalid/)
  for (const mutate of [
    read => { read.buyAction = 'ADD' },
    read => { read.order = { symbol: 'AAA' } },
    read => { read.portfolio.data.options_value = '1' },
  ]) {
    const read = robinhoodRead()
    mutate(read)
    assert.throws(() => deriveRobinhoodPortfolioInput({
      symbol: 'AAA', evaluatedAt: NOW, stat,
      robinhoodRead: read, capacityPolicy: capacityPolicy(),
    }), /Robinhood portfolio input is invalid/)
  }
})

test('rejects a portfolio annotation that points at another eligible account', () => {
  const input = symbolMarketCase()
  const other = 'RH-PRIVATE-9876'
  input.robinhoodRead.accounts.push({
    ...input.robinhoodRead.accounts[0],
    account_number: other,
  })
  input.robinhoodRead.portfolio.accountNumber = other

  const result = evaluateSymbolCase(input)
  assert.equal(result.dataStatus, 'EVALUATION_BLOCKED')
  assert.ok(result.blockerCodes.includes('INVALID_PORTFOLIO_CAPACITY'))
})

function collectorClient({ positionsByCursor, quoteCalls = [], transportError = null } = {}) {
  const accounts = [{
    account_number: ACCOUNT_NUMBER,
    agentic_allowed: true,
    state: 'active',
    type: 'cash',
    deactivated: false,
    permanently_deactivated: false,
  }]
  const portfolio = robinhoodRead().portfolio.data
  return {
    getAccounts: async () => ({ accounts }),
    getPortfolio: async ({ accountNumber }) => {
      if (transportError) throw transportError
      assert.equal(accountNumber, ACCOUNT_NUMBER)
      return portfolio
    },
    getEquityPositions: async ({ accountNumber, cursor }) => {
      assert.equal(accountNumber, ACCOUNT_NUMBER)
      return positionsByCursor?.get(cursor ?? null) ?? { positions: [], next: null }
    },
    getEquityQuotes: async ({ symbols }) => {
      quoteCalls.push([...symbols])
      return { results: symbols.map(symbol => robinhoodQuoteResult(symbol)) }
    },
  }
}

test('collector follows position cursors and supplies the later-page ADD bundle', async () => {
  const positionsByCursor = new Map([
    [null, {
      positions: [robinhoodPosition('BBB')],
      next: 'https://api.robinhood.com/positions/?cursor=later',
    }],
    ['later', { positions: [robinhoodPosition('AAA', '10')], next: null }],
  ])
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client: collectorClient({ positionsByCursor }),
  })

  assert.equal(read.portfolio.accountNumber, ACCOUNT_NUMBER)
  assert.equal(read.positionPages.length, 2)
  assert.equal(evaluateSymbolCase(symbolMarketCase({ robinhoodRead: read })).buyAction, 'ADD')
})

test('collector batches more than twenty quote symbols', async () => {
  const symbols = Array.from({ length: 21 }, (_, index) => `S${String(index).padStart(2, '0')}`)
  const positions = symbols.map(symbol => robinhoodPosition(symbol))
  const quoteCalls = []
  const read = await collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client: collectorClient({
      positionsByCursor: new Map([[null, { positions, next: null }]]),
      quoteCalls,
    }),
  })

  assert.deepEqual(quoteCalls.map(batch => batch.length), [20, 1])
  assert.equal(read.positionPages[0].positions.length, 21)
})

test('collector rejects an identical symbol repeated across position pages', async () => {
  const duplicate = robinhoodPosition('BBB')
  const positionsByCursor = new Map([
    [null, {
      positions: [duplicate],
      next: 'https://api.robinhood.com/positions/?cursor=overlap',
    }],
    ['overlap', { positions: [structuredClone(duplicate)], next: null }],
  ])

  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client: collectorClient({ positionsByCursor }),
  }), /Robinhood portfolio input is invalid/)
})

test('collector propagates transport failures, rejects cursor cycles, and preserves responses', async () => {
  const transportError = new Error('transport probe')
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client: collectorClient({ transportError }),
  }), error => error === transportError)

  const page = {
    positions: [robinhoodPosition('BBB')],
    next: 'https://api.robinhood.com/positions/?cursor=cycle',
  }
  const positionsByCursor = new Map([[null, page], ['cycle', page]])
  const before = structuredClone(page)
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client: collectorClient({ positionsByCursor }),
  }), /Robinhood portfolio input is invalid/)
  assert.deepEqual(page, before)
})

test('collector accepts only the four read methods', async () => {
  const client = { ...collectorClient(), placeOrder() {} }
  await assert.rejects(() => collectRobinhoodRead({
    selectedAccountNumber: ACCOUNT_NUMBER,
    capturedAt: '2026-08-10T08:00:00.000Z',
    client,
  }), /Robinhood portfolio input is invalid/)
})

test('evaluateSymbolCase rethrows unexpected adapter failures', () => {
  const original = globalThis.structuredClone
  const probe = new Error('unexpected adapter probe')
  let calls = 0
  globalThis.structuredClone = value => {
    calls += 1
    if (calls === 2) throw probe
    return original(value)
  }
  try {
    assert.throws(() => evaluateSymbolCase(symbolMarketCase()), error => error === probe)
  } finally {
    globalThis.structuredClone = original
  }
})
