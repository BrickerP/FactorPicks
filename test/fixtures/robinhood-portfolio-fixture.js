import { AS_OF } from './workbench-fixture.js'

export const ACCOUNT_NUMBER = 'RH-PRIVATE-4321'

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

function result(symbol, price = '50', asOf = AS_OF) {
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

export function robinhoodRead({
  positions = [],
  positionPages,
  quoteBatches,
  totalValue = '100000.00',
} = {}) {
  const pages = positionPages ?? [{
    accountNumber: ACCOUNT_NUMBER,
    cursor: null,
    next: null,
    positions,
  }]
  const tickers = pages.flatMap(page => page.positions.map(item => item.symbol))
  const batches = quoteBatches ?? (tickers.length === 0 ? [] : [{
    requestedSymbols: tickers,
    results: tickers.map(ticker => result(ticker)),
  }])
  return {
    schemaVersion: 1,
    capturedAt: AS_OF,
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
        equity_value: tickers.length === 0 ? '0' : '5000',
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
  }
}

export function addRead() {
  const later = position('AAA', '10')
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
        positions: [later],
      },
    ],
  })
}

export { position as robinhoodPosition, result as robinhoodQuoteResult }
