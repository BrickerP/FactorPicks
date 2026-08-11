import { createSnapshot } from '../../src/domain/contentAddressing.js'
import { AS_OF, NOW, rawCase } from './workbench-fixture.js'
import { robinhoodRead } from './robinhood-read-fixture.js'

const STAT_ARTIFACT = '{"AAA":{"sector":"Technology","industry":"Software","Close":95,"name":"AAA","Market Cap":100,"P/E":20,"ROE":0.2,"Debt/Eq":0.2,"FCFF/EV":0.1,"asOf":"2026-08-10T08:00:00.000Z","observedAt":"2026-08-10T08:00:00.000Z","currency":"USD"},"BBB":{"sector":"Technology","industry":"Software","Close":95,"name":"BBB","Market Cap":100,"P/E":20,"ROE":0.1,"Debt/Eq":0.2,"FCFF/EV":0.1,"asOf":"2026-08-10T08:00:00.000Z","observedAt":"2026-08-10T08:00:00.000Z","currency":"USD"}}'
const STAT_ARTIFACT_CONTRACT = Object.freeze({
  sha256: '782c11f2438d8599138a9ce7143442df9e17f519dcb81908eae36ccfe34a0449',
  bytes: 463,
  symbols: 2,
})

function vector(raw, sha256, bytes = 463, symbols = 2) {
  return Object.freeze({
    raw,
    contract: Object.freeze({ sha256, bytes, symbols }),
  })
}

const STAT_ARTIFACT_VECTORS = Object.freeze({
  canonical: vector(STAT_ARTIFACT, STAT_ARTIFACT_CONTRACT.sha256),
  unicode: vector(
    STAT_ARTIFACT.replace('"name":"AAA"', '"name":"艾"'),
    '111135ea345a5d16c22550092a2f4a3175ea14f03f1f71e0d85a69dfbd7fec31',
  ),
  invalidAsOf: vector(
    STAT_ARTIFACT.replace(
      '"asOf":"2026-08-10T08:00:00.000Z"',
      '"asOf":"2026-02-30T08:00:00.000Z"',
    ),
    'fac1950bbb6e65bbafaf751397e4e1d050b1a36c8258bcf7bf15a184731e0408',
  ),
  lowercaseObservedAt: vector(
    STAT_ARTIFACT.replace(
      '"observedAt":"2026-08-10T08:00:00.000Z"',
      '"observedAt":"2026-08-10T08:00:00.000z"',
    ),
    '6a5fd0d3f10fa71c703eb4fdeec2a001994c3b49563cbcc582417d47cbcf8c36',
  ),
  spacedAsOf: vector(
    STAT_ARTIFACT.replace(
      '"asOf":"2026-08-10T08:00:00.000Z"',
      '"asOf":"2026-08-10T08:00:00.000Z "',
    ),
    '551bfdec86ee483320d55e7e3d03eb29527499b905fc48b5b432189f86db7abf',
    464,
  ),
  future: vector(
    STAT_ARTIFACT
      .replace(
        '"asOf":"2026-08-10T08:00:00.000Z"',
        '"asOf":"2026-08-10T08:02:00.000Z"',
      )
      .replace(
        '"observedAt":"2026-08-10T08:00:00.000Z"',
        '"observedAt":"2026-08-10T08:02:00.000Z"',
      ),
    '76f96bdfc44cae4c8c6914ac7ff867513e35a1b0429320fb7cb7a8d64ee13ff7',
  ),
  stale: vector(
    STAT_ARTIFACT.replace(
      '"asOf":"2026-08-10T08:00:00.000Z"',
      '"asOf":"2026-08-10T07:44:59.999Z"',
    ),
    'cc5582cda90045fc10a3e275ce387bb1486b29420b5c40a96508378ca51565aa',
  ),
  nonUsd: vector(
    STAT_ARTIFACT.replace('"currency":"USD"', '"currency":"EUR"'),
    '781beca025495777c0fad44f5ab089eaaf011ea77ea186066f6c3b2b3bfbcb1e',
  ),
  invalidPrice: vector(
    STAT_ARTIFACT.replace('"Close":95', '"Close":"-"'),
    'aa0462da7586974d3e1a35c202bc68e90521ef8def68a728d7e5675348ec69e1',
    464,
  ),
  missingAaa: vector(
    '{"BBB":{"sector":"Technology","industry":"Software","Close":95,"name":"BBB","Market Cap":100,"P/E":20,"ROE":0.1,"Debt/Eq":0.2,"FCFF/EV":0.1,"asOf":"2026-08-10T08:00:00.000Z","observedAt":"2026-08-10T08:00:00.000Z","currency":"USD"}}',
    '3ae564007d15d6c1743cd69c25e1c0e55e609d2c18d7ed7e11a763d8d14a29e6',
    232,
    1,
  ),
})

export function symbolMarketCase(overrides = {}) {
  const raw = rawCase()
  const sourcePayload = structuredClone(raw.sourceSnapshots[0].payload)
  const source = createSnapshot('source', sourcePayload)
  const evidence = structuredClone(raw.evidence)
  evidence.drafts = evidence.drafts
    .filter(draft => ![
      'price', 'market-session', 'earnings-schedule-known', 'next-earnings-at',
    ]
      .includes(draft.key))
    .map(draft => draft.sourceRef === raw.sourceSnapshots[0].id
      ? { ...draft, sourceRef: source.ref.id }
      : draft)
  delete evidence.sourcePolicy.kinds.ROBINHOOD_EQUITY_QUOTE
  delete evidence.sourcePolicy.kinds.ROBINHOOD_EARNINGS_CALENDAR

  const read = overrides.robinhoodRead ?? robinhoodRead()
  return {
    symbol: 'AAA',
    evaluatedAt: NOW,
    statArtifact: STAT_ARTIFACT,
    qualityManifest: {
      ...structuredClone(raw.research.qualityManifest),
      statArtifact: { ...STAT_ARTIFACT_CONTRACT },
    },
    robinhoodRead: read,
    privateCase: {
      schemaVersion: 1,
      researchPolicy: structuredClone(raw.research.policy),
      sourceSnapshots: [source.resolved],
      evidence,
      underwriting: structuredClone(raw.underwriting),
      timing: structuredClone(raw.timing),
      capacityPolicy: {
        policy: structuredClone(raw.portfolio.policy),
        liquidity: { ...structuredClone(raw.portfolio.liquidity), asOf: read.capturedAt },
        freshnessPolicy: structuredClone(raw.portfolio.freshnessPolicy),
      },
      decisionPolicy: structuredClone(raw.decisionPolicy),
    },
    ...overrides,
  }
}

export {
  AS_OF,
  NOW,
  STAT_ARTIFACT,
  STAT_ARTIFACT_CONTRACT,
  STAT_ARTIFACT_VECTORS,
}
