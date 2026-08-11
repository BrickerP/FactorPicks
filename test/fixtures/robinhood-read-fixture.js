export const ACCOUNT_NUMBER = 'RH-PRIVATE-4321'
export const ROBINHOOD_CAPTURED_AT = '2026-08-10T20:00:00.000Z'
export const REGULAR_QUOTE_AS_OF = '2026-08-10T19:59:00.000Z'

function position(symbol, quantity = '100') {
  return {
    symbol,
    quantity,
    type: 'long',
    intraday_quantity: '0',
    shares_available_for_sells: quantity,
    shares_held_for_asset_transfer: '0',
    shares_held_for_options_events: '0',
    shares_held_for_sells: '0',
    shares_held_for_stock_grants: '0',
    shares_pending_from_options_events: '0',
  }
}

function quoteResult(symbol, price = '95', asOf = REGULAR_QUOTE_AS_OF) {
  return {
    quote: {
      symbol,
      state: 'active',
      has_traded: true,
      last_trade_price: price,
      venue_last_trade_time: asOf,
      last_non_reg_trade_price: null,
      venue_last_non_reg_trade_time: null,
    },
  }
}

function earningsResult({
  symbol = 'AAA',
  year = 2026,
  quarter = 2,
  estimate = 1.1,
  actual = 1.2,
  date = '2026-07-30',
  timing = 'pm',
  verified = true,
} = {}) {
  return {
    symbol,
    year,
    quarter,
    eps: { estimate, actual },
    report: date === null ? null : { date, timing, verified },
  }
}

function earningsData({ results, notFound = [] } = {}) {
  return {
    not_found: notFound,
    results: results ?? [earningsResult()],
  }
}

export function robinhoodRead({
  targetSymbol = 'AAA',
  positions = [],
  positionPages,
  quoteBatches,
  earnings = earningsData({ results: [earningsResult({ symbol: targetSymbol })] }),
  totalValue = '100000.00',
  capturedAt = ROBINHOOD_CAPTURED_AT,
} = {}) {
  const pages = positionPages ?? [{
    accountNumber: ACCOUNT_NUMBER,
    cursor: null,
    next: null,
    positions,
  }]
  const tickers = [...new Set([
    ...pages.flatMap(page => page.positions.map(item => item.symbol)),
    targetSymbol,
  ])].sort()
  const batches = quoteBatches ?? [{
    requestedSymbols: tickers,
    results: tickers.map(ticker => quoteResult(ticker)),
  }]
  return {
    schemaVersion: 2,
    capturedAt,
    targetSymbol,
    selectedAccountNumber: ACCOUNT_NUMBER,
    accounts: [{
      account_number: ACCOUNT_NUMBER,
      agentic_allowed: true,
      state: 'active',
      type: 'cash',
      deactivated: false,
      permanently_deactivated: false,
    }],
    portfolio: {
      accountNumber: ACCOUNT_NUMBER,
      data: {
        currency: 'USD',
        total_value: totalValue,
        equity_value: tickers.length === 1 && positions.length === 0 ? '0' : '5000',
        options_value: '0',
        crypto_value: '0',
        fixed_income_value: '0',
        futures_value: '0',
        mutual_funds_value: '0',
        event_contracts_value: '0',
      },
    },
    positionPages: pages,
    quoteBatches: batches,
    earnings: { symbol: targetSymbol, data: earnings },
  }
}

export function addRead() {
  return robinhoodRead({
    positionPages: [
      {
        accountNumber: ACCOUNT_NUMBER,
        cursor: null,
        next: 'https://api.robinhood.com/positions/?cursor=next-page',
        positions: [position('BBB')],
      },
      {
        accountNumber: ACCOUNT_NUMBER,
        cursor: 'next-page',
        next: null,
        positions: [position('AAA', '10')],
      },
    ],
  })
}

export {
  earningsData as robinhoodEarningsData,
  earningsResult as robinhoodEarningsResult,
  position as robinhoodPosition,
  quoteResult as robinhoodQuoteResult,
}
