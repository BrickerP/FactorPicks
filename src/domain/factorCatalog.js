export const FACTOR_GROUPS = Object.freeze([
  'quality',
  'growth',
  'financialSafety',
  'valuation',
  'timing',
])

export const FACTOR_CATALOG = Object.freeze([
  Object.freeze({ id: 'returnOnEquity', field: 'ROE', group: 'quality', direction: 'higher' }),
  Object.freeze({ id: 'returnOnAssets', field: 'ROA', group: 'quality', direction: 'higher' }),
  Object.freeze({ id: 'earningsGrowthNextYear', field: 'EPS next Y_%', group: 'growth', direction: 'higher' }),
  Object.freeze({ id: 'salesGrowthFiveYear', field: 'Sales past 5Y', group: 'growth', direction: 'higher' }),
  Object.freeze({ id: 'debtToEquity', field: 'Debt/Eq', group: 'financialSafety', direction: 'lower' }),
  Object.freeze({ id: 'currentRatio', field: 'Current Ratio', group: 'financialSafety', direction: 'higher' }),
  Object.freeze({ id: 'priceToEarnings', field: 'P/E', group: 'valuation', direction: 'lower' }),
  Object.freeze({ id: 'priceEarningsGrowth', field: 'PEG', group: 'valuation', direction: 'lower' }),
  Object.freeze({ id: 'freeCashFlowYield', field: 'FCFF/EV', group: 'valuation', direction: 'higher' }),
  Object.freeze({ id: 'quarterPerformance', field: 'Perf Quarter', group: 'timing', direction: 'higher' }),
  Object.freeze({ id: 'priceVsSma200', field: 'SMA200', group: 'timing', direction: 'higher' }),
])
