import { createSnapshot, digest, opaqueRef } from './contentAddressing.js'

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/
const BUNDLE_KEYS = [
  'schemaVersion',
  'capturedAt',
  'targetSymbols',
  'selectedAccountNumber',
  'accounts',
  'portfolio',
  'positionPages',
  'quoteBatches',
  'earnings',
]
const INPUT_KEYS = [
  'symbol',
  'evaluatedAt',
  'stat',
  'robinhoodRead',
  'capacityPolicy',
]
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
const BATCH_KEYS = ['requestedSymbols', 'observedAt', 'results']
const PORTFOLIO_WRAPPER_KEYS = ['accountNumber', 'data']
const EARNINGS_WRAPPER_KEYS = ['symbol', 'observedAt', 'data']
const EARNINGS_DATA_KEYS = ['not_found', 'results']
const EARNINGS_RESULT_KEYS = ['symbol', 'year', 'quarter', 'eps', 'report']
const EPS_KEYS = ['estimate', 'actual']
const REPORT_KEYS = ['date', 'timing', 'verified']
const CLIENT_KEYS = [
  'getAccounts',
  'getPortfolio',
  'getEquityPositions',
  'getEquityQuotes',
  'getEarningsResults',
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
const QUOTE_TIMESTAMP_KEYS = [
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
const SOURCE_KINDS = Object.freeze({
  ROBINHOOD_EQUITY_QUOTE: 'PRIMARY',
  ROBINHOOD_EARNINGS_CALENDAR: 'PRIMARY',
})
const RFC3339_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const NEW_YORK_DATE = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const NEW_YORK_CLOCK = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
class RobinhoodReadInputError extends TypeError {
  constructor() {
    super('Robinhood read input is invalid')
    this.code = 'INVALID_ROBINHOOD_READ_INPUT'
  }
}

function fail() {
  throw new RobinhoodReadInputError()
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function epochNanoseconds(value) {
  if (!nonEmpty(value)) return null
  const match = RFC3339_PATTERN.exec(value)
  if (!match) return null
  const fraction = match[2] ?? ''
  const milliseconds = fraction.slice(0, 3).padEnd(3, '0')
  const parsed = Date.parse(`${match[1]}.${milliseconds}${match[3]}`)
  if (!Number.isFinite(parsed)) return null
  const fractionNanoseconds = BigInt(fraction.padEnd(9, '0') || '0')
  const parsedMilliseconds = BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND
  return BigInt(parsed) * NANOSECONDS_PER_MILLISECOND +
    fractionNanoseconds - parsedMilliseconds
}

function normalizeTimestamp(value) {
  const nanoseconds = epochNanoseconds(value)
  if (nanoseconds === null) return null
  let milliseconds = nanoseconds / NANOSECONDS_PER_MILLISECOND
  let remainder = nanoseconds % NANOSECONDS_PER_MILLISECOND
  if (remainder < 0n) {
    milliseconds -= 1n
    remainder += NANOSECONDS_PER_MILLISECOND
  }
  const iso = new Date(Number(milliseconds)).toISOString()
  return remainder === 0n
    ? iso
    : `${iso.slice(0, -1)}${remainder.toString().padStart(6, '0')}Z`
}

function canonicalTimestamp(value) {
  return normalizeTimestamp(value) === value
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function decimal(value, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0) ? parsed : null
}

function metric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function metricOrNull(value) {
  return value === null ? null : metric(value)
}

function project(value, keys) {
  if (!object(value)) fail()
  return Object.fromEntries(keys
    .filter(key => Object.hasOwn(value, key))
    .map(key => [key, structuredClone(value[key])]))
}

function projectQuoteResult(value) {
  if (!object(value) || !object(value.quote)) fail()
  const quote = project(value.quote, QUOTE_KEYS)
  for (const key of QUOTE_TIMESTAMP_KEYS) {
    if (!Object.hasOwn(quote, key) || quote[key] === null) continue
    const normalized = normalizeTimestamp(quote[key])
    if (normalized === null) fail()
    quote[key] = normalized
  }
  const result = { quote }
  if (Object.hasOwn(value, 'close')) {
    result.close = value.close === null ? null : project(value.close, CLOSE_KEYS)
  }
  return result
}

function projectEarningsData(value, targetSymbol) {
  if (!object(value) || !Array.isArray(value.results) ||
      (Object.hasOwn(value, 'not_found') && !Array.isArray(value.not_found))) fail()
  const notFound = value.not_found ?? []
  if (notFound.some(symbol => !TICKER.test(symbol ?? '')) ||
      new Set(notFound).size !== notFound.length) fail()
  const results = value.results.map(raw => {
    if (!object(raw) || !object(raw.eps) ||
        !Number.isInteger(raw.year) || !Number.isInteger(raw.quarter) ||
        raw.quarter < 1 || raw.quarter > 4 || raw.symbol !== targetSymbol ||
        !Object.hasOwn(raw.eps, 'estimate') || !Object.hasOwn(raw.eps, 'actual')) fail()
    const estimate = metricOrNull(raw.eps.estimate)
    const actual = metricOrNull(raw.eps.actual)
    if (raw.eps.estimate !== null && estimate === null) fail()
    if (raw.eps.actual !== null && actual === null) fail()
    let report = null
    if (raw.report !== null) {
      if (!object(raw.report) || !dateOnly(raw.report.date) ||
          !['am', 'pm', null].includes(raw.report.timing) ||
          typeof raw.report.verified !== 'boolean') fail()
      report = {
        date: raw.report.date,
        timing: raw.report.timing,
        verified: raw.report.verified,
      }
    }
    return {
      symbol: targetSymbol,
      year: raw.year,
      quarter: raw.quarter,
      eps: { estimate, actual },
      report,
    }
  }).sort((left, right) => left.year - right.year || left.quarter - right.quarter)
  return { not_found: [...notFound], results }
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

function validateFreshnessPolicy(policy) {
  if (!Number.isFinite(policy.maxPortfolioAgeMs) || policy.maxPortfolioAgeMs < 0 ||
      !Number.isFinite(policy.maxLiquidityAgeMs) || policy.maxLiquidityAgeMs < 0 ||
      !Number.isFinite(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0) fail()
}

function validateClose(close, expectedSymbol) {
  if (close === undefined || close === null) return
  if (!onlyKeys(close, CLOSE_KEYS)) fail()
  if (Object.hasOwn(close, 'symbol') && close.symbol !== expectedSymbol) fail()
  if (Object.hasOwn(close, 'date') && !dateOnly(close.date)) fail()
  if (Object.hasOwn(close, 'price') && decimal(close.price, { positive: true }) === null) fail()
  if (Object.hasOwn(close, 'interpolated') && typeof close.interpolated !== 'boolean') fail()
  if (Object.hasOwn(close, 'source') && !nonEmpty(close.source)) fail()
}

function marketQuote(result, expectedSymbol) {
  if (!object(result) || !onlyKeys(result, ['quote', 'close']) || !object(result.quote) ||
      !onlyKeys(result.quote, QUOTE_KEYS)) fail()
  const quote = result.quote
  validateClose(result.close, expectedSymbol)
  if (quote.symbol !== expectedSymbol || quote.state !== 'active' || quote.has_traded !== true) fail()
  const regularPrice = decimal(quote.last_trade_price, { positive: true })
  const regularAt = quote.venue_last_trade_time
  const regularAtNanoseconds = epochNanoseconds(regularAt)
  if (regularPrice === null || regularAtNanoseconds === null ||
      !canonicalTimestamp(regularAt)) fail()
  let price = regularPrice
  let asOf = normalizeTimestamp(regularAt)
  let session = 'REGULAR'

  const hasNonRegularPrice = quote.last_non_reg_trade_price !== null &&
    quote.last_non_reg_trade_price !== undefined
  const hasNonRegularTime = quote.venue_last_non_reg_trade_time !== null &&
    quote.venue_last_non_reg_trade_time !== undefined
  if (hasNonRegularPrice !== hasNonRegularTime) fail()
  if (hasNonRegularPrice) {
    const nonRegularPrice = decimal(quote.last_non_reg_trade_price, { positive: true })
    const nonRegularAt = quote.venue_last_non_reg_trade_time
    const nonRegularAtNanoseconds = epochNanoseconds(nonRegularAt)
    if (nonRegularPrice === null || nonRegularAtNanoseconds === null ||
        !canonicalTimestamp(nonRegularAt)) fail()
    if (nonRegularAtNanoseconds === regularAtNanoseconds && nonRegularPrice !== regularPrice) fail()
    if (nonRegularAtNanoseconds > regularAtNanoseconds) {
      price = nonRegularPrice
      asOf = normalizeTimestamp(nonRegularAt)
      session = 'EXTENDED'
    }
  }
  return { price, asOf, session }
}

function selectedAccount(accounts, selectedAccountNumber) {
  if (!Array.isArray(accounts) || accounts.some(account =>
    !object(account) || !onlyKeys(account, ACCOUNT_KEYS) || !nonEmpty(account.account_number))) fail()
  const selected = accounts.filter(account => account.account_number === selectedAccountNumber)
  if (selected.length !== 1) fail()
  return selected[0]
}

function validateAccountEligibility(account) {
  if (account.agentic_allowed !== true || account.state !== 'active' || account.type !== 'cash' ||
      account.deactivated !== false || account.permanently_deactivated !== false) fail()
}

function validateSharedSemantics(context) {
  validateAccountEligibility(context.selectedAccount)
  const portfolioData = context.portfolioData
  const totalValue = decimal(portfolioData.total_value, { positive: true })
  if (portfolioData.currency !== 'USD' || totalValue === null ||
      decimal(portfolioData.equity_value) === null ||
      NON_EQUITY_VALUES.some(key => decimal(portfolioData[key]) !== 0)) fail()
  for (const position of context.rawPositions) {
    if (position.type !== 'long' || decimal(position.quantity, { positive: true }) === null) fail()
  }
  return totalValue
}

function observedMarketQuote(entry, expectedSymbol) {
  const quote = marketQuote(entry.result, expectedSymbol)
  if (epochNanoseconds(entry.observedAt) < epochNanoseconds(quote.asOf)) fail()
  return quote
}

function sortedUniqueTickers(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every(symbol => TICKER.test(symbol ?? '')) &&
    new Set(value).size === value.length &&
    value.every((symbol, index) => index === 0 || value[index - 1] < symbol)
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function structuralQuoteSymbol(result) {
  if (!object(result) || !onlyKeys(result, ['quote', 'close']) || !object(result.quote) ||
      !onlyKeys(result.quote, QUOTE_KEYS) || !TICKER.test(result.quote.symbol ?? '')) fail()
  if (Object.hasOwn(result, 'close') && result.close !== null &&
      (!object(result.close) || !onlyKeys(result.close, CLOSE_KEYS) ||
        (Object.hasOwn(result.close, 'symbol') && result.close.symbol !== result.quote.symbol))) fail()
  return result.quote.symbol
}

function inspectRobinhoodReadV3(bundle, expectedTargets) {
  if (!exactKeys(bundle, BUNDLE_KEYS) || bundle.schemaVersion !== 3 ||
      !canonicalTimestamp(bundle.capturedAt) || !sortedUniqueTickers(bundle.targetSymbols) ||
      !nonEmpty(bundle.selectedAccountNumber) ||
      !exactKeys(bundle.portfolio, PORTFOLIO_WRAPPER_KEYS) ||
      bundle.portfolio.accountNumber !== bundle.selectedAccountNumber ||
      !object(bundle.portfolio.data) || !Array.isArray(bundle.positionPages) ||
      bundle.positionPages.length === 0 || !Array.isArray(bundle.quoteBatches) ||
      bundle.quoteBatches.length === 0 || !Array.isArray(bundle.earnings)) fail()
  if (expectedTargets !== undefined && (!sortedUniqueTickers(expectedTargets) ||
      !sameValues(bundle.targetSymbols, expectedTargets))) fail()

  const account = selectedAccount(bundle.accounts, bundle.selectedAccountNumber)
  const portfolioData = bundle.portfolio.data
  if (!onlyKeys(portfolioData, PORTFOLIO_KEYS)) fail()

  const rawPositions = []
  const heldSymbols = new Set()
  const seenCursors = new Set()
  let expectedCursor = null
  for (const page of bundle.positionPages) {
    if (seenCursors.has(expectedCursor)) fail()
    seenCursors.add(expectedCursor)
    if (!exactKeys(page, PAGE_KEYS) || page.accountNumber !== bundle.selectedAccountNumber ||
        page.cursor !== expectedCursor || !Array.isArray(page.positions)) fail()
    for (const position of page.positions) {
      if (!object(position) || !onlyKeys(position, POSITION_KEYS) ||
          !TICKER.test(position.symbol ?? '') || heldSymbols.has(position.symbol)) fail()
      heldSymbols.add(position.symbol)
      rawPositions.push(position)
    }
    expectedCursor = nextCursor(page.next)
  }
  if (expectedCursor !== null) fail()

  const expectedSymbols = [...new Set([...heldSymbols, ...bundle.targetSymbols])].sort()
  const requested = []
  const results = new Map()
  for (const batch of bundle.quoteBatches) {
    if (!exactKeys(batch, BATCH_KEYS) || !canonicalTimestamp(batch.observedAt) ||
        !Array.isArray(batch.requestedSymbols) || batch.requestedSymbols.length === 0 ||
        batch.requestedSymbols.length > 20 || !Array.isArray(batch.results) ||
        batch.results.length > batch.requestedSymbols.length ||
        !sortedUniqueTickers(batch.requestedSymbols)) fail()
    requested.push(...batch.requestedSymbols)
    const batchRequested = new Set(batch.requestedSymbols)
    for (const result of batch.results) {
      const ticker = structuralQuoteSymbol(result)
      if (!batchRequested.has(ticker) || results.has(ticker)) fail()
      results.set(ticker, { result, observedAt: batch.observedAt })
    }
  }
  if (!sameValues(requested, expectedSymbols) ||
      [...heldSymbols].some(symbol => !results.has(symbol))) fail()

  if (bundle.earnings.length !== bundle.targetSymbols.length) fail()
  const earnings = new Map()
  for (let index = 0; index < bundle.earnings.length; index += 1) {
    const wrapper = bundle.earnings[index]
    const symbol = bundle.targetSymbols[index]
    if (!exactKeys(wrapper, EARNINGS_WRAPPER_KEYS) || wrapper.symbol !== symbol ||
        !canonicalTimestamp(wrapper.observedAt) ||
        !exactKeys(wrapper.data, EARNINGS_DATA_KEYS) ||
        !Array.isArray(wrapper.data.not_found) || !Array.isArray(wrapper.data.results)) fail()
    earnings.set(symbol, wrapper)
  }
  return {
    selectedAccount: account,
    portfolioData,
    rawPositions,
    heldSymbols,
    quoteResults: results,
    earnings,
  }
}

export function validateRobinhoodReadV3(robinhoodRead, expectedTargets) {
  inspectRobinhoodReadV3(robinhoodRead, expectedTargets)
  return true
}

function newYorkDate(value) {
  const parts = Object.fromEntries(NEW_YORK_DATE.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function actualReportCouldHaveOccurred(report, observedAt) {
  const observedDate = newYorkDate(observedAt)
  if (report.date !== observedDate) return report.date < observedDate
  if (report.timing === null) return false

  const parts = Object.fromEntries(NEW_YORK_CLOCK.formatToParts(new Date(observedAt))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  const secondOfDay = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60) +
    Number(parts.second)
  const observedNanoseconds = epochNanoseconds(observedAt)
  const fraction = ((observedNanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n
  const nanosecondsOfDay = BigInt(secondOfDay) * 1_000_000_000n + fraction
  const boundary = BigInt(report.timing === 'am' ? 34_200 : 57_600) * 1_000_000_000n
  return report.timing === 'am'
    ? nanosecondsOfDay >= boundary
    : nanosecondsOfDay > boundary
}

function validateEarnings(earnings, symbol, observedAt) {
  if (!exactKeys(earnings, EARNINGS_WRAPPER_KEYS) || earnings.symbol !== symbol ||
      !exactKeys(earnings.data, EARNINGS_DATA_KEYS) ||
      !Array.isArray(earnings.data.not_found) || earnings.data.not_found.length !== 0 ||
      !Array.isArray(earnings.data.results) || earnings.data.results.length === 0) fail()

  const seenPeriods = new Set()
  const pending = []
  for (const result of earnings.data.results) {
    if (!exactKeys(result, EARNINGS_RESULT_KEYS) || result.symbol !== symbol ||
        !Number.isInteger(result.year) || !Number.isInteger(result.quarter) ||
        result.quarter < 1 || result.quarter > 4 || !exactKeys(result.eps, EPS_KEYS) ||
        ![result.eps.estimate, result.eps.actual].every(value =>
          value === null || (typeof value === 'number' && Number.isFinite(value)))) fail()
    const period = `${result.year}-Q${result.quarter}`
    if (seenPeriods.has(period)) fail()
    seenPeriods.add(period)

    if (result.report !== null && (!exactKeys(result.report, REPORT_KEYS) ||
        !dateOnly(result.report.date) || !['am', 'pm', null].includes(result.report.timing) ||
        typeof result.report.verified !== 'boolean')) fail()
    if (result.eps.actual !== null && (result.report === null ||
        !actualReportCouldHaveOccurred(result.report, observedAt))) fail()
    if (result.eps.actual === null) {
      if (result.report === null) fail()
      pending.push(result.report)
    }
  }
  if (pending.length > 1) fail()
  const nextReport = pending[0] ?? null
  return {
    nextReport: nextReport === null ? null : {
      date: nextReport.date,
      timing: nextReport.timing,
      verified: nextReport.verified,
    },
  }
}

function buildMarketEvidence(symbol, quote, quoteObservedAt, earnings, earningsObservedAt) {
  const scope = { symbol }
  const quoteSource = createSnapshot('source', {
    role: 'SOURCE',
    kind: 'ROBINHOOD_EQUITY_QUOTE',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: quote.asOf,
    observedAt: quoteObservedAt,
    facts: [
      {
        factKey: 'CURRENT_PRICE',
        value: quote.price,
        asOf: quote.asOf,
        scope,
        currency: 'USD',
      },
      {
        factKey: 'MARKET_SESSION',
        value: quote.session,
        asOf: quote.asOf,
        scope,
      },
    ],
  })
  const earningsFacts = [{
    key: 'earnings-schedule-known',
    claimKey: 'EARNINGS_SCHEDULE',
    factKey: 'EARNINGS_SCHEDULE_KNOWN',
    value: true,
  }]
  if (earnings.nextReport !== null) {
    earningsFacts.push({
      key: 'next-earnings-at',
      claimKey: 'EARNINGS_SCHEDULE',
      factKey: 'NEXT_EARNINGS_AT',
      value: earnings.nextReport,
    })
  }
  const earningsSource = createSnapshot('source', {
    role: 'SOURCE',
    kind: 'ROBINHOOD_EARNINGS_CALENDAR',
    schemaVersion: 1,
    symbol,
    currency: 'USD',
    asOf: earningsObservedAt,
    observedAt: earningsObservedAt,
    facts: earningsFacts.map(fact => ({
      factKey: fact.factKey,
      value: fact.value,
      asOf: earningsObservedAt,
      scope,
    })),
  })
  const observed = (draft, sourceRef, asOf, extra = {}) => ({
    ...draft,
    sourceRef,
    asOf,
    scope,
    stance: 'SUPPORTS',
    confidence: 1,
    ...extra,
  })
  return {
    sourceSnapshots: [quoteSource.resolved, earningsSource.resolved],
    evidenceDrafts: [
      observed({
        key: 'price',
        claimKey: 'MARKET_PRICE',
        factKey: 'CURRENT_PRICE',
        value: quote.price,
      }, quoteSource.ref.id, quote.asOf, { currency: 'USD' }),
      observed({
        key: 'market-session',
        claimKey: 'MARKET_SESSION',
        factKey: 'MARKET_SESSION',
        value: quote.session,
      }, quoteSource.ref.id, quote.asOf),
      ...earningsFacts.map(fact => observed(fact, earningsSource.ref.id, earningsObservedAt)),
    ],
    sourceKinds: { ...SOURCE_KINDS },
  }
}

function derive(input) {
  if (!exactKeys(input, INPUT_KEYS)) fail()
  const {
    symbol,
    evaluatedAt,
    stat,
    robinhoodRead,
    capacityPolicy,
  } = input
  if (!TICKER.test(symbol ?? '') || !canonicalTimestamp(evaluatedAt) || !object(stat) ||
      !exactKeys(capacityPolicy, CAPACITY_POLICY_KEYS) ||
      !exactKeys(capacityPolicy.policy, POLICY_KEYS) ||
      !exactKeys(capacityPolicy.liquidity, LIQUIDITY_KEYS) ||
      !exactKeys(capacityPolicy.freshnessPolicy, FRESHNESS_KEYS)) fail()

  validateFreshnessPolicy(capacityPolicy.freshnessPolicy)
  const context = inspectRobinhoodReadV3(robinhoodRead)
  if (!robinhoodRead.targetSymbols.includes(symbol)) fail()
  const totalValue = validateSharedSemantics(context)

  const quotes = new Map()
  for (const ticker of context.heldSymbols) {
    quotes.set(ticker, observedMarketQuote(context.quoteResults.get(ticker), ticker))
  }
  const targetQuoteEntry = context.quoteResults.get(symbol)
  if (!targetQuoteEntry) fail()
  const targetQuote = quotes.get(symbol) ?? observedMarketQuote(targetQuoteEntry, symbol)
  quotes.set(symbol, targetQuote)

  const targetClassification = stat[symbol]
  if (!nonEmpty(targetClassification?.sector) || !nonEmpty(targetClassification?.industry)) fail()
  const positions = context.rawPositions.map(position => {
    const classification = stat[position.symbol]
    if (!nonEmpty(classification?.sector) || !nonEmpty(classification?.industry)) fail()
    const quote = quotes.get(position.symbol)
    return {
      symbol: position.symbol,
      quantity: decimal(position.quantity, { positive: true }),
      markPrice: quote.price,
      asOf: quote.asOf,
      currency: 'USD',
      assetType: 'EQUITY',
      side: 'LONG',
      sector: classification.sector,
      industry: classification.industry,
    }
  })
  const sanitizedFacts = {
    schemaVersion: 3,
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
  const portfolio = {
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
  const earningsWrapper = context.earnings.get(symbol)
  const earnings = validateEarnings(earningsWrapper, symbol, earningsWrapper.observedAt)
  return deepFreeze({
    portfolio,
    ...buildMarketEvidence(
      symbol,
      targetQuote,
      targetQuoteEntry.observedAt,
      earnings,
      earningsWrapper.observedAt,
    ),
  })
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function deriveRobinhoodInputs(input) {
  return derive(structuredClone(input))
}

export async function collectRobinhoodRead(input) {
  if (!onlyKeys(input, ['selectedAccountNumber', 'targetSymbols', 'client', 'clock']) ||
      !['selectedAccountNumber', 'targetSymbols', 'client'].every(key => Object.hasOwn(input, key))) fail()
  const { selectedAccountNumber, targetSymbols, client } = input
  const clock = input.clock ?? (() => new Date().toISOString())
  if (!nonEmpty(selectedAccountNumber) || !sortedUniqueTickers(targetSymbols) ||
      typeof clock !== 'function' || !exactKeys(client, CLIENT_KEYS) ||
      CLIENT_KEYS.some(key => typeof client[key] !== 'function')) fail()
  const readClock = () => {
    const value = normalizeTimestamp(clock())
    if (value === null) fail()
    return value
  }

  const accountResponse = await client.getAccounts()
  if (!object(accountResponse) || !Array.isArray(accountResponse.accounts)) fail()
  const accounts = accountResponse.accounts.map(account => project(account, ACCOUNT_KEYS))
  validateAccountEligibility(selectedAccount(accounts, selectedAccountNumber))

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
      if (!TICKER.test(position.symbol ?? '') || positionsBySymbol.has(position.symbol)) fail()
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

  const capturedAt = readClock()
  const symbols = [...new Set([...positionsBySymbol.keys(), ...targetSymbols])].sort()
  const quoteBatches = []
  for (let start = 0; start < symbols.length; start += 20) {
    const requestedSymbols = symbols.slice(start, start + 20)
    const response = await client.getEquityQuotes({ symbols: [...requestedSymbols] })
    const observedAt = readClock()
    if (!object(response) || !Array.isArray(response.results)) fail()
    const resultsBySymbol = new Map()
    for (const rawResult of response.results) {
      const result = projectQuoteResult(rawResult)
      const ticker = result.quote.symbol
      if (!requestedSymbols.includes(ticker) || resultsBySymbol.has(ticker)) fail()
      resultsBySymbol.set(ticker, result)
    }
    quoteBatches.push({
      requestedSymbols,
      observedAt,
      results: requestedSymbols
        .filter(ticker => resultsBySymbol.has(ticker))
        .map(ticker => resultsBySymbol.get(ticker)),
    })
  }

  const earnings = []
  for (const symbol of targetSymbols) {
    const response = await client.getEarningsResults({ symbol })
    const observedAt = readClock()
    earnings.push({
      symbol,
      observedAt,
      data: projectEarningsData(response, symbol),
    })
  }
  const result = {
    schemaVersion: 3,
    capturedAt,
    targetSymbols: [...targetSymbols],
    selectedAccountNumber,
    accounts,
    portfolio: { accountNumber: selectedAccountNumber, data: portfolioData },
    positionPages,
    quoteBatches,
    earnings,
  }
  validateRobinhoodReadV3(result, targetSymbols)
  return deepFreeze(result)
}
