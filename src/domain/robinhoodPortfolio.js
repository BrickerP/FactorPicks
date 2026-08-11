import { digest, opaqueRef } from './contentAddressing.js'

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/
const BUNDLE_KEYS = [
  'schemaVersion',
  'capturedAt',
  'selectedAccountNumber',
  'accounts',
  'portfolio',
  'positionPages',
  'quoteBatches',
]
const INPUT_KEYS = ['symbol', 'evaluatedAt', 'stat', 'robinhoodRead', 'capacityPolicy']
const CAPACITY_POLICY_KEYS = ['policy', 'liquidity', 'freshnessPolicy']
const POLICY_KEYS = [
  'sourceRef',
  'effectiveFrom',
  'effectiveUntil',
  'userHardLimit',
  'systemRiskLimit',
  'sectorHardLimit',
  'industryHardLimit',
  'portfolioHardLimit',
  'minimumCashBufferWeight',
]
const LIQUIDITY_KEYS = ['maxPositionWeight', 'asOf', 'sourceRef']
const FRESHNESS_KEYS = ['maxPortfolioAgeMs', 'maxLiquidityAgeMs', 'maxFutureSkewMs']
const PAGE_KEYS = ['accountNumber', 'cursor', 'next', 'positions']
const BATCH_KEYS = ['requestedSymbols', 'results']
const PORTFOLIO_WRAPPER_KEYS = ['accountNumber', 'data']
const CLIENT_KEYS = [
  'getAccounts',
  'getPortfolio',
  'getEquityPositions',
  'getEquityQuotes',
]
const ACCOUNT_KEYS = [
  'account_number',
  'affiliate',
  'agentic_allowed',
  'brokerage_account_type',
  'deactivated',
  'is_default',
  'management_type',
  'nickname',
  'option_level',
  'permanently_deactivated',
  'rhc_account_number',
  'rhs_account_number',
  'state',
  'type',
  'unsettled_funds',
]
const PORTFOLIO_KEYS = [
  'buying_power',
  'cash',
  'crypto_buying_power',
  'crypto_value',
  'currency',
  'equity_value',
  'event_contracts_value',
  'fixed_income_value',
  'futures_value',
  'mutual_funds_value',
  'options_value',
  'pending_deposits',
  'total_value',
]
const POSITION_KEYS = [
  'average_buy_price',
  'intraday_quantity',
  'quantity',
  'shares_available_for_sells',
  'shares_held_for_asset_transfer',
  'shares_held_for_options_events',
  'shares_held_for_sells',
  'shares_held_for_stock_grants',
  'shares_pending_from_options_events',
  'symbol',
  'type',
]
const QUOTE_KEYS = [
  'adjusted_previous_close',
  'ask_price',
  'bid_price',
  'has_traded',
  'last_non_reg_trade_price',
  'last_trade_price',
  'previous_close',
  'previous_close_date',
  'state',
  'symbol',
  'venue_ask_time',
  'venue_bid_time',
  'venue_last_non_reg_trade_time',
  'venue_last_trade_time',
]
const CLOSE_KEYS = ['date', 'interpolated', 'price', 'source', 'symbol']
const NON_EQUITY_VALUES = [
  'options_value',
  'crypto_value',
  'fixed_income_value',
  'futures_value',
  'mutual_funds_value',
  'event_contracts_value',
]

class RobinhoodPortfolioInputError extends TypeError {
  constructor() {
    super('Robinhood portfolio input is invalid')
    this.code = 'INVALID_ROBINHOOD_PORTFOLIO_INPUT'
  }
}

function fail() {
  throw new RobinhoodPortfolioInputError()
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value, keys) {
  return object(value) && Object.keys(value).every(key => keys.includes(key))
}

function exactKeys(value, keys) {
  return onlyKeys(value, keys) && keys.every(key => Object.hasOwn(value, key))
}

function timestamp(value) {
  return typeof value === 'string' && value.trim() === value && Number.isFinite(Date.parse(value))
}

function decimal(value, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0) ? parsed : null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

// Robinhood transports stay outside this module. The collector accepts four
// read-only methods and projects their JSON results onto this module's allow-list.
function project(value, keys) {
  if (!object(value)) fail()
  return Object.fromEntries(keys
    .filter(key => Object.hasOwn(value, key))
    .map(key => [key, structuredClone(value[key])]))
}

function projectQuoteResult(value) {
  if (!object(value) || !object(value.quote)) fail()
  const result = { quote: project(value.quote, QUOTE_KEYS) }
  if (Object.hasOwn(value, 'close')) {
    result.close = value.close === null ? null : project(value.close, CLOSE_KEYS)
  }
  return result
}

function validateFreshness(asOf, evaluatedAt, freshnessPolicy) {
  if (!timestamp(asOf) || !timestamp(evaluatedAt) || !object(freshnessPolicy) ||
      !Number.isFinite(freshnessPolicy.maxPortfolioAgeMs) || freshnessPolicy.maxPortfolioAgeMs < 0 ||
      !Number.isFinite(freshnessPolicy.maxFutureSkewMs) || freshnessPolicy.maxFutureSkewMs < 0) fail()
  const age = Date.parse(evaluatedAt) - Date.parse(asOf)
  if (age > freshnessPolicy.maxPortfolioAgeMs || age < -freshnessPolicy.maxFutureSkewMs) fail()
}

function nextCursor(next) {
  if (next === null || next === undefined || next === '') return null
  if (typeof next !== 'string') fail()
  try {
    const cursor = new URL(next).searchParams.get('cursor')
    if (!nonEmpty(cursor)) fail()
    return cursor
  } catch {
    fail()
  }
}

function chosenQuote(result, expectedSymbol, evaluatedAt, freshnessPolicy) {
  if (!object(result) || !onlyKeys(result, ['quote', 'close']) || !object(result.quote) ||
      !onlyKeys(result.quote, QUOTE_KEYS)) fail()
  if (Object.hasOwn(result, 'close') && result.close !== null &&
      !onlyKeys(result.close, CLOSE_KEYS)) fail()
  const quote = result.quote
  if (quote.symbol !== expectedSymbol || quote.state !== 'active' || quote.has_traded !== true) fail()

  const regularPrice = decimal(quote.last_trade_price, { positive: true })
  const regularAt = quote.venue_last_trade_time
  if (regularPrice === null || !timestamp(regularAt)) fail()
  let price = regularPrice
  let asOf = regularAt
  if (quote.last_non_reg_trade_price !== null || quote.venue_last_non_reg_trade_time !== null) {
    const nonRegularPrice = decimal(quote.last_non_reg_trade_price, { positive: true })
    const nonRegularAt = quote.venue_last_non_reg_trade_time
    if (nonRegularPrice === null || !timestamp(nonRegularAt)) fail()
    const comparison = Date.parse(nonRegularAt) - Date.parse(regularAt)
    if (comparison === 0 && nonRegularPrice !== regularPrice) fail()
    if (comparison > 0) {
      price = nonRegularPrice
      asOf = nonRegularAt
    }
  }
  validateFreshness(asOf, evaluatedAt, freshnessPolicy)
  return { price, asOf }
}

export function deriveRobinhoodPortfolioInput(input) {
  if (!exactKeys(input, INPUT_KEYS)) fail()
  const { symbol, evaluatedAt, stat, robinhoodRead, capacityPolicy } = input
  if (!TICKER.test(symbol ?? '') || !timestamp(evaluatedAt) || !object(stat) ||
      !exactKeys(robinhoodRead, BUNDLE_KEYS) || robinhoodRead.schemaVersion !== 1 ||
      !timestamp(robinhoodRead.capturedAt) || !nonEmpty(robinhoodRead.selectedAccountNumber) ||
      !Array.isArray(robinhoodRead.accounts) ||
      !exactKeys(robinhoodRead.portfolio, PORTFOLIO_WRAPPER_KEYS) ||
      robinhoodRead.portfolio.accountNumber !== robinhoodRead.selectedAccountNumber ||
      !object(robinhoodRead.portfolio.data) ||
      !Array.isArray(robinhoodRead.positionPages) || robinhoodRead.positionPages.length === 0 ||
      !Array.isArray(robinhoodRead.quoteBatches) ||
      !exactKeys(capacityPolicy, CAPACITY_POLICY_KEYS) ||
      !exactKeys(capacityPolicy.policy, POLICY_KEYS) ||
      !exactKeys(capacityPolicy.liquidity, LIQUIDITY_KEYS) ||
      !exactKeys(capacityPolicy.freshnessPolicy, FRESHNESS_KEYS)) fail()

  validateFreshness(robinhoodRead.capturedAt, evaluatedAt, capacityPolicy.freshnessPolicy)
  if (robinhoodRead.accounts.some(account =>
    !object(account) || !onlyKeys(account, ACCOUNT_KEYS) || !nonEmpty(account.account_number))) fail()
  const selected = robinhoodRead.accounts.filter(account =>
    object(account) && account.account_number === robinhoodRead.selectedAccountNumber)
  if (selected.length !== 1 || selected[0].agentic_allowed !== true ||
      selected[0].state !== 'active' || selected[0].type !== 'cash' ||
      selected[0].deactivated !== false || selected[0].permanently_deactivated !== false) fail()

  const portfolioData = robinhoodRead.portfolio.data
  const totalValue = decimal(portfolioData.total_value, { positive: true })
  if (!onlyKeys(portfolioData, PORTFOLIO_KEYS) ||
      portfolioData.currency !== 'USD' || totalValue === null ||
      decimal(portfolioData.equity_value) === null ||
      NON_EQUITY_VALUES.some(key => decimal(portfolioData[key]) !== 0)) fail()

  const rawPositions = []
  let expectedCursor = null
  for (const page of robinhoodRead.positionPages) {
    if (!exactKeys(page, PAGE_KEYS) || page.accountNumber !== robinhoodRead.selectedAccountNumber ||
        (page.cursor ?? null) !== expectedCursor || !Array.isArray(page.positions)) fail()
    for (const position of page.positions) {
      if (!object(position) || !onlyKeys(position, POSITION_KEYS) ||
          !TICKER.test(position.symbol ?? '') || position.type !== 'long' ||
          decimal(position.quantity, { positive: true }) === null) fail()
      rawPositions.push(position)
    }
    expectedCursor = nextCursor(page.next)
  }
  if (expectedCursor !== null) fail()

  const heldSymbols = new Set()
  for (const position of rawPositions) {
    if (heldSymbols.has(position.symbol)) fail()
    heldSymbols.add(position.symbol)
  }
  const quotes = new Map()
  const requested = new Set()
  for (const batch of robinhoodRead.quoteBatches) {
    if (!exactKeys(batch, BATCH_KEYS) || !Array.isArray(batch.requestedSymbols) ||
        batch.requestedSymbols.length === 0 || batch.requestedSymbols.length > 20 ||
        !Array.isArray(batch.results)) fail()
    const batchRequested = new Set(batch.requestedSymbols)
    if (batchRequested.size !== batch.requestedSymbols.length ||
        batch.results.length !== batch.requestedSymbols.length) fail()
    for (const ticker of batch.requestedSymbols) {
      if (!TICKER.test(ticker) || requested.has(ticker)) fail()
      requested.add(ticker)
    }
    for (const result of batch.results) {
      const ticker = result?.quote?.symbol
      if (!batchRequested.has(ticker) || quotes.has(ticker)) fail()
      quotes.set(ticker, chosenQuote(result, ticker, evaluatedAt, capacityPolicy.freshnessPolicy))
    }
  }
  if (requested.size !== heldSymbols.size ||
      [...heldSymbols].some(ticker => !requested.has(ticker) || !quotes.has(ticker))) fail()

  const targetClassification = stat[symbol]
  if (!nonEmpty(targetClassification?.sector) || !nonEmpty(targetClassification?.industry)) fail()
  const positions = rawPositions.map(position => {
    const classification = stat[position.symbol]
    if (!nonEmpty(classification?.sector) || !nonEmpty(classification?.industry)) fail()
    return {
      symbol: position.symbol,
      quantity: decimal(position.quantity, { positive: true }),
      markPrice: quotes.get(position.symbol).price,
      asOf: robinhoodRead.capturedAt,
      currency: 'USD',
      assetType: 'EQUITY',
      side: 'LONG',
      sector: classification.sector,
      industry: classification.industry,
    }
  })
  const sanitizedFacts = {
    schemaVersion: 1,
    capturedAt: robinhoodRead.capturedAt,
    currency: 'USD',
    totalValue,
    positions: positions.map(({ symbol: ticker, quantity, markPrice, sector, industry }) => ({
      symbol: ticker,
      quantity,
      markPrice,
      quoteAsOf: quotes.get(ticker).asOf,
      sector,
      industry,
    })).sort((left, right) => left.symbol.localeCompare(right.symbol)),
  }
  const sourceRef = opaqueRef('robinhood-portfolio', digest(sanitizedFacts))

  return {
    symbol,
    evaluatedAt,
    portfolio: {
      asOf: robinhoodRead.capturedAt,
      sourceRef,
      completeness: 'COMPLETE',
      accountCount: 1,
      accountType: 'CASH',
      currency: 'USD',
      netLiquidationValue: totalValue,
      hasOptions: false,
      hasCrypto: false,
      positions,
      targetClassification: {
        sector: targetClassification.sector,
        industry: targetClassification.industry,
      },
    },
    policy: structuredClone(capacityPolicy.policy),
    liquidity: structuredClone(capacityPolicy.liquidity),
    freshnessPolicy: structuredClone(capacityPolicy.freshnessPolicy),
  }
}

export async function collectRobinhoodRead(input) {
  if (!exactKeys(input, ['selectedAccountNumber', 'capturedAt', 'client'])) fail()
  const { selectedAccountNumber, capturedAt, client } = input
  if (!nonEmpty(selectedAccountNumber) || !timestamp(capturedAt) ||
      !exactKeys(client, CLIENT_KEYS) || CLIENT_KEYS.some(key => typeof client[key] !== 'function')) {
    fail()
  }

  const accountResponse = await client.getAccounts()
  if (!object(accountResponse) || !Array.isArray(accountResponse.accounts)) fail()
  const accounts = accountResponse.accounts.map(account => project(account, ACCOUNT_KEYS))
  const selected = accounts.filter(account => account.account_number === selectedAccountNumber)
  if (selected.length !== 1 || selected[0].agentic_allowed !== true ||
      selected[0].state !== 'active' || selected[0].type !== 'cash' ||
      selected[0].deactivated !== false || selected[0].permanently_deactivated !== false) fail()

  const portfolioData = project(
    await client.getPortfolio({ accountNumber: selectedAccountNumber }),
    PORTFOLIO_KEYS,
  )
  const positionPages = []
  const positionsBySymbol = new Map()
  const seenCursors = new Set()
  let cursor = null
  while (true) {
    const cursorKey = cursor ?? '<first-page>'
    if (seenCursors.has(cursorKey)) fail()
    seenCursors.add(cursorKey)
    const args = { accountNumber: selectedAccountNumber }
    if (cursor !== null) args.cursor = cursor
    const response = await client.getEquityPositions(args)
    if (!object(response) || !Array.isArray(response.positions)) fail()
    const pagePositions = []
    for (const rawPosition of response.positions) {
      const position = project(rawPosition, POSITION_KEYS)
      if (!TICKER.test(position.symbol ?? '')) fail()
      const previous = positionsBySymbol.get(position.symbol)
      if (previous) fail()
      positionsBySymbol.set(position.symbol, position)
      pagePositions.push(position)
    }
    const next = response.next ?? null
    positionPages.push({
      accountNumber: selectedAccountNumber,
      cursor,
      next,
      positions: pagePositions,
    })
    cursor = nextCursor(next)
    if (cursor === null) break
  }

  const symbols = [...positionsBySymbol.keys()]
  const quoteBatches = []
  for (let start = 0; start < symbols.length; start += 20) {
    const requestedSymbols = symbols.slice(start, start + 20)
    const response = await client.getEquityQuotes({ symbols: [...requestedSymbols] })
    if (!object(response) || !Array.isArray(response.results)) fail()
    const resultsBySymbol = new Map()
    for (const rawResult of response.results) {
      const result = projectQuoteResult(rawResult)
      const ticker = result.quote.symbol
      if (!requestedSymbols.includes(ticker) || resultsBySymbol.has(ticker)) fail()
      resultsBySymbol.set(ticker, result)
    }
    if (resultsBySymbol.size !== requestedSymbols.length) fail()
    quoteBatches.push({
      requestedSymbols,
      results: requestedSymbols.map(ticker => resultsBySymbol.get(ticker)),
    })
  }

  return {
    schemaVersion: 1,
    capturedAt,
    selectedAccountNumber,
    accounts,
    portfolio: { accountNumber: selectedAccountNumber, data: portfolioData },
    positionPages,
    quoteBatches,
  }
}
