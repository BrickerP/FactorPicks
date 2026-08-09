export const CAPACITY_AS_OF = '2026-08-09T07:55:00.000Z'

export function capacityInput(overrides = {}) {
  const input = {
    symbol: 'AAA',
    evaluatedAt: '2026-08-09T08:00:00.000Z',
    freshnessPolicy: {
      maxPortfolioAgeMs: 600_000,
      maxLiquidityAgeMs: 600_000,
      maxFutureSkewMs: 60_000,
    },
    portfolio: {
      asOf: CAPACITY_AS_OF,
      sourceRef: `source:${'1'.repeat(64)}`,
      completeness: 'COMPLETE',
      accountCount: 1,
      accountType: 'CASH',
      currency: 'USD',
      netLiquidationValue: 100_000,
      hasOptions: false,
      hasCrypto: false,
      positions: [
        {
          symbol: 'AAA', quantity: 20, markPrice: 100,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Software',
        },
        {
          symbol: 'BBB', quantity: 100, markPrice: 100,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Technology', industry: 'Hardware',
        },
        {
          symbol: 'CCC', quantity: 300, markPrice: 100,
          asOf: CAPACITY_AS_OF, currency: 'USD', assetType: 'EQUITY',
          side: 'LONG', sector: 'Healthcare', industry: 'Biotechnology',
        },
      ],
    },
    policy: {
      sourceRef: `source:${'3'.repeat(64)}`,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveUntil: '2026-09-01T00:00:00.000Z',
      userHardLimit: 0.1,
      systemRiskLimit: 0.08,
      sectorHardLimit: 0.2,
      industryHardLimit: 0.12,
      portfolioHardLimit: 0.9,
      minimumCashBufferWeight: 0.1,
    },
    liquidity: {
      maxPositionWeight: 0.06,
      asOf: CAPACITY_AS_OF,
      sourceRef: `source:${'2'.repeat(64)}`,
    },
  }

  return {
    ...input,
    ...overrides,
    portfolio: { ...input.portfolio, ...overrides.portfolio },
    policy: { ...input.policy, ...overrides.policy },
    liquidity: { ...input.liquidity, ...overrides.liquidity },
  }
}
