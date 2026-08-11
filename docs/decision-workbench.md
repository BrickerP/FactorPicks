# Headless Decision Workbench

This document is the current non-UI contract for FactorPicks. The sole local
entry point is:

```bash
npm run workbench -- --symbol AAPL --case private-case.json --robinhood - \
  [--market-url https://brickerp.github.io/FactorPicks/] \
  [--evaluated-at 2026-08-10T08:00:00.000Z] \
  [--ledger /external/private/decisions.jsonl]
```

The CLI reads the private case only from the named local file and reads one
canonical `RobinhoodReadV1` collector bundle of allow-listed normalized
projections only from stdin. `--case -` and any
`--robinhood` value other than `-` are rejected before stdin or network access.
It then makes exactly two public, bodyless requests: `GET <base>/stat.json` and
`GET <base>/data-quality.json`. The default base is
`https://brickerp.github.io/FactorPicks/`. No private case value is sent in a
request, and the path has no direct broker HTTP/auth, order, or public UI capability.
It may append the sanitized `DecisionRecordV2` to an external private ledger.
Identity verification establishes byte integrity and provenance binding, not
external-source authenticity.

The CLI retains `stat.json` as the exact UTF-8 response text. It may parse that
text only to validate its top-level JSON shape; it must not stringify the parsed
value or otherwise change bytes before evaluation. `data-quality.json` is JSON,
and its required `statArtifact` contract binds the raw text by exact SHA-256,
UTF-8 byte count, and symbol count. The manifest's `succeeded` count, bound
symbol count, and parsed top-level symbol count must agree. A mismatch is a
semantic blocker, never a fallback to an unbound market object.

The stage order is fixed:

```text
public stat + quality manifest + private case + RobinhoodReadV1 collector bundle
  → evaluateSymbolCase
  → evaluateResearch
  → deriveEvidenceBundle
  → deriveStructuredUnderwriting
  → deriveTimingAssessment
  → deriveRobinhoodPortfolioInput
  → derivePortfolioCapacitySnapshot
  → evaluateDecision
```

The private case accepts exactly `schemaVersion`, `researchPolicy`,
`sourceSnapshots`, `evidence`, `underwriting`, `timing`, `capacityPolicy`, and
`decisionPolicy`. Symbol and evaluation time are CLI values. The public universe
and quality manifest come only from the two public responses. A private case
must not reintroduce `research`, occupy the reserved current-price Evidence
namespace (`key=price`, `claimKey=PRICE`, `factKey=CURRENT_PRICE`), submit a
different timing `currentPriceFactKey`, or provide derived Evidence,
valuation/entry output, timing status, capacity snapshot, sizing, or action.

Only after the raw artifact and manifest agree does the adapter select a public
row. That row is the only current-price authority: its `Close`, `asOf`,
`observedAt`, and `currency` become one secondary Yahoo market-data observation.
The adapter injects that observation only into the reserved `price` / `PRICE` /
`CURRENT_PRICE` Evidence namespace, and the timing policy is fixed to
`currentPriceFactKey=CURRENT_PRICE`. Analyst targets, historical prices, and
other price-like facts may remain ordinary Evidence under distinct keys, claims,
and fact keys. They may support underwriting, but cannot satisfy the reserved
current-price lookup or become `evaluatedPrice`. The adapter does not infer a
missing or stale quote, thesis, valuation, entry range, timing state, account
capacity, personal limits, policy, or action from ranks or neighboring symbols.
Missing, stale, conflicting, or wrong-symbol semantic data returns
`EVALUATION_BLOCKED` + `NO_ACTION` with exit zero. Invalid argv, private-case
JSON/top-level shape, collected-bundle stdin transport/JSON or missing collection,
public HTTP/non-object JSON, URL, or file I/O exits one with generalized stderr.
A parsed but semantically invalid collector bundle is a domain blocker and also
returns `EVALUATION_BLOCKED` + `NO_ACTION` with exit zero.

Evidence timestamps are derived from resolved source facts and inference
parents. Freshness is rechecked at each downstream boundary with
`evidence.asOf <= underwriting.asOf <= decidedAt`. The resolved decision-policy
payload is the sole authority for action and sizing; an outer artifact cannot
override it.

Downstream freshness applies to every Evidence item's `asOf` and `observedAt`,
using the stricter of the Evidence policy and DecisionPolicy age/skew limits.
Invalid timing input has no partial/raw fallback in a blocked record: its public
projection is `null`.

## Product goal and action language

The workbench helps an investor answer four questions for a security: what is observable now, does the long-term case hold, is entry acceptable at the current price and timing, and how much room remains in the portfolio? It produces an auditable private decision record for human review; it never places an order.

The only five `BuyAction` values are:

| Action | Meaning | Entry condition |
| --- | --- | --- |
| `OPEN` | Start a new position. | No holding, valid evidence-backed gates, current price inside `EntryRange`, and `positionSizing.targetPosition` greater than zero. |
| `ADD` | Increase an existing position toward its target. | Holding exists, all entry gates pass, and `positionSizing.additionalCapacity` is positive. |
| `PILOT` | Take a policy-capped first small position while timing has event risk. | No holding, long-term and valuation gates pass, `TimingAssessment` is `EVENT_RISK`, and policy permits a positive pilot within capacity. |
| `WATCH` | Keep a valid candidate under observation without adding capital. | Research and underwriting are valid but entry is currently prohibited, such as an out-of-range price or failed timing gate. |
| `NO_ACTION` | Make no new purchase. | The position is at/above its limit, capacity is zero, or an existing holding requires review rather than an add. |

`Evaluation Blocked` is a decision status, not a sixth action: it returns `NO_ACTION` and blocker reasons because required inputs cannot be trusted. `Entry Prohibited` is a valid, evaluated state that normally yields `WATCH` for a non-holder or `NO_ACTION` plus `HoldingRisk` for a holder.

## Target flow

The final path is deliberately one-way and has no timing signal hidden inside fundamental research:

```text
MarketDataSnapshot
  → FundamentalResearch (timing excluded)
  → LongTermGate
  → Structured Underwriting
       [Evidence, ValuationRange, EntryRange, InvalidationRule]
  → TimingAssessment
  → PortfolioCapacity
  → DecisionPolicy + PositionSizing
  → DecisionRecord v2
  → PrivateLedger
```

`MarketDataSnapshot` is the time-consistent observation of prices, identity, fundamentals, and source quality for a `Research Universe`. `FundamentalResearch` derives only long-horizon quality, growth, safety, and valuation observations; quarter performance, moving averages, and other near-term timing observations are not fundamental catalog factors. The `LongTermGate` answers whether the durable business case is eligible for private underwriting; it cannot be passed by timing data.

`Structured Underwriting` is private and contains a thesis, evidence references, a `ValuationRange`, an `EntryRange`, and explicit `InvalidationRule`s. `TimingAssessment` is also private and is evaluated after the long-term and valuation gates; it can delay or cap an action but never repair missing evidence or a failed long-term gate.

## Public research and private decision boundary

Public artifacts may contain the `Research Universe`, source-normalized `MarketDataSnapshot`, `Quality Manifest`, and `FundamentalResearch` facts that can be independently inspected. They must not contain a personal thesis, valuation assumptions, entry range, invalidation state, timing judgment, account holdings, personal/industry/portfolio limits, or a `DecisionRecord`. Fetching those artifacts is read-only and never uploads the private case.

Private state begins with the `Underwriting Case` and includes its evidence interpretation, valuation and entry assumptions, invalidation rules, timing assessment, portfolio capacity, decision policy, and private ledger. Evidence may point back to a public source, but the claim it supports and the investor's confidence remain private; publishing a source does not publish the thesis.

The plain Node workbench has no MCP authentication and does not contact
Robinhood. The Codex runtime binds
`collectRobinhoodRead({selectedAccountNumber, capturedAt, client})` to an
authenticated client. The injected client exposes exactly `getAccounts`,
`getPortfolio`, `getEquityPositions`, and `getEquityQuotes`, corresponding to the
MCP read allowlist `get_accounts`, `get_portfolio`, `get_equity_positions`, and
`get_equity_quotes`. Their calls are fixed to `getAccounts()`,
`getPortfolio({accountNumber})`,
`getEquityPositions({accountNumber, cursor?})`, and
`getEquityQuotes({symbols})`. The collector explicitly selects one account, follows every
position page, obtains quotes for all held equity symbols, and returns only
allow-listed normalized projections. MCP transport responses are not the
collector bundle and never enter the Node CLI. No order, cancel, review-order,
watchlist mutation, retry, cache, or fallback call is allowed in collection.

The stdin bundle is exact and versioned:

```text
RobinhoodReadV1 {
  schemaVersion,
  capturedAt,
  selectedAccountNumber,
  accounts,
  portfolio: { accountNumber, data },
  positionPages,
  quoteBatches
}
```

The normalized collector bundle exists only in the collector and CLI process
memory. It is never written to a temporary file, case file, ledger, cache,
stdout, stderr, or public artifact. The ledger contains only the emitted
`DecisionRecordV2`.
Account number/`selectedAccountNumber`, NLV/`total_value`, `quantity`,
`markPrice`, `average_buy_price`, pagination `cursor`, and raw payload canaries
must never appear in stdout, stderr, or the ledger.

The canonical position denominator is `netLiquidationValue` (NLV), captured at the same account as-of time as the holding facts. Position weights, hard limits, `effectiveLimit`, `positionSizing.targetPosition`, and `positionSizing.additionalCapacity` are all expressed against NLV; personal, industry, and portfolio strategies remain private policy inputs and are never inferred from the public ranking.

## Core contract shapes

These are compact domain shapes. They are intentionally independent of a UI, broker SDK, or a particular persistence technology.

### Evidence

```text
Evidence {
  id: string,
  claim: string,
  source: { kind: string, reference: string },
  observedAt: ISO-8601 timestamp,
  asOf: ISO-8601 timestamp,
  scope: { symbol: string, universe?: string },
  stance: SUPPORTS | CHALLENGES,
  sourceQuality: PRIMARY | SECONDARY,
  derivation: OBSERVED | INFERRED,
  confidence: number in [0, 1]
}
```

`reference` must identify a retrievable source without embedding credentials. A gate may be `PASS` or `FAIL` only when it names one or more applicable evidence IDs; otherwise the result is `Evaluation Blocked`, never an ungrounded status. Timing claims are stricter: the pass, fail, and event-risk claims named by the timing policy must be directly `OBSERVED` source-backed Evidence and cannot reuse a long-term gate claim key.

`sourceQuality` describes the source; `derivation` describes whether the observation is directly observed or inferred. These dimensions are independent and must not be collapsed into one quality value.

### ValuationRange and EntryRange

```text
ValuationRange {
  low: number,
  base: number,
  high: number,
  currency: string,
  asOf: ISO-8601 timestamp,
  method: string,
  evidenceIds: string[],
  uncertainty: string
}

EntryRange {
  lower: number,
  upper: number,
  currency: string,
  asOf: ISO-8601 timestamp,
  marginOfSafety: number in [0, 1],
  derivedFrom: ValuationRange,
  evidenceIds: string[]
}
```

`ValuationRange` requires `low <= base <= high`, a common currency, and a non-empty evidence set. `EntryRange` is derived from that range and a stated margin of safety; it must not be a single Yahoo-derived target price, and the current price is eligible only when it lies within the range.

### InvalidationRule

```text
InvalidationRule {
  id: string,
  condition: string,
  evidenceIds: string[],
  predicate: {
    kind: METRIC | MANUAL,
    metric: string | null,
    operator: GT | GTE | LT | LTE | EQ | NEQ | null,
    threshold: number | string | null,
    lookback: duration | null,
    consecutive: positive integer | null,
    source: string | null
  },
  manualStatus: NOT_REQUIRED | PENDING | CONFIRMED | REJECTED,
  severity: REVIEW | PROHIBIT_ENTRY | EXIT_REVIEW,
  state: UNTRIGGERED | TRIGGERED | UNKNOWN,
  observedAt: ISO-8601 timestamp,
  response: string
}
```

For `kind=METRIC`, the predicate is mechanically checkable from the named metric, operator, threshold, lookback, consecutive count, and source; `manualStatus` is `NOT_REQUIRED`. `kind=MANUAL` is allowed only with an explicit `manualStatus`, and the workbench never claims that a manual rule was automatically evaluated. `UNKNOWN` is not treated as `UNTRIGGERED` when the rule is material; missing evidence blocks evaluation or prohibits entry according to policy.

The private underwriting snapshot retains the full condition, predicate, and
response needed to re-evaluate a rule. The public `DecisionRecordV2` projection
does not: each invalidation rule is reduced to its opaque rule ID, evidence
references, bounded severity, and derived state. Free-form thesis text never
reaches the record or external ledger.

### TimingAssessment

`deriveTimingAssessment` accepts only the exact raw policy fields: current-price,
pass/fail/event-risk keys, freshness limits, and event-risk reason code. For the
symbol-case adapter, `currentPriceFactKey` is fixed to `CURRENT_PRICE`; aliases,
other fact keys, defaults, and caller-supplied `requirePassSupport` are rejected.
Pass support is always required. The policy is stored as a content-addressed
`TIMING_POLICY` snapshot. The builder then resolves Evidence and derives the only
allowed current quote from exactly one fresh, non-conflicting `OBSERVED` item in
the reserved `key=price`, `claimKey=PRICE`, `factKey=CURRENT_PRICE` namespace for
the same symbol in USD. Caller-supplied status, price, price evidence ID, reason
codes, or timing artifact fields are rejected. Other target or historical price
Evidence is never eligible for `evaluatedPrice`.

The resulting content-addressed artifact binds the symbol, Evidence snapshot and
digest, price evidence ID, status, as-of, evidence IDs, and bounded reason codes.
`PASS`, `FAIL`, `EVENT_RISK`, and `BLOCKED` are derived from fresh support or
challenge stances. A missing/stale/conflicting quote or missing required support
is `BLOCKED`; a challenge (or explicit fail support) is `FAIL`; event-risk
support is `EVENT_RISK`. Timing never changes the long-term gate. The projector
re-resolves policy, Evidence, and artifact payloads and returns the canonical
evaluated price plus assessment only when all identities and freshness checks
still match.

### PortfolioCapacitySnapshot

```text
PortfolioCapacitySnapshot {
  asOf: ISO-8601 timestamp,
  denominator: {
    kind: NET_LIQUIDATION_VALUE,
    asOf: ISO-8601 timestamp,
    sourceRef: string,
    snapshotRef: string,
    digest: string
  },
  currentPosition: { weight: non-negative number, positionRef: string },
  hardLimits: {
    userHardLimit: positive number,
    systemRiskLimit: positive number,
    sectorHardLimit: non-negative number,
    industryHardLimit: non-negative number,
    portfolioHardLimit: non-negative number,
    liquidityHardLimit: non-negative number
  },
  remainingCapacity: {
    sector: non-negative number,
    industry: non-negative number,
    portfolio: non-negative number,
    liquidity: non-negative number
  },
  effectiveLimit: non-negative number,
  capacityToLimit: non-negative number
}
```

All values are ratios against NLV; raw NLV, quantity, and market value remain in the private input and are represented here only by references and digests. `effectiveLimit` is the minimum of every applicable hard limit and `currentPosition.weight + remainingCapacity` for sector, industry, portfolio, and liquidity. `capacityToLimit = max(0, effectiveLimit - currentPosition.weight)`.

If the NLV reference, a required limit, or the current holding fact is missing, contradictory, stale, or non-finite, the snapshot is invalid and evaluation fails closed. A zero `capacityToLimit` is valid and means no room exists under the hard limit; it is not a data blocker by itself.

`PositionSizing` runs after this snapshot and after the private valuation/decision policy. It produces `positionSizing.targetPosition` as a total NLV-weighted position clipped to `effectiveLimit`, then derives `positionSizing.additionalCapacity = max(0, positionSizing.targetPosition - currentPosition.weight)`; neither field belongs in `PortfolioCapacitySnapshot`.

```text
PositionSizing {
  targetPosition: non-negative number,
  additionalCapacity: non-negative number
}
```

### SnapshotStore

```text
SnapshotStore {
  snapshotRef: { id: string, version: string, digest: string },
  visibility: PUBLIC | PRIVATE,
  contentAddressed: true,
  immutable: true
}
```

Every public or private snapshot referenced by a `DecisionRecordV2` must resolve through its `snapshotRef`; a missing resolver result is an evaluation failure, not a recoverable warning. Private snapshots are encrypted at rest. Retention for a snapshot cannot be shorter than the lifetime of any `DecisionRecordV2` that references it, and deletion is allowed only after no decision record references it. Until these resolver, encryption, retention, and deletion guarantees are implemented, the system may claim only identity verification, not reproducibility.

### DecisionRecord v2

```text
DecisionRecordV2 {
  schemaVersion: 2,
  symbol: string,
  decidedAt: ISO-8601 timestamp,
  dataStatus: VALID | EVALUATION_BLOCKED,
  entryStatus: PERMITTED | PROHIBITED,
  evaluatedPrice: {
    value: number,
    currency: string,
    asOf: ISO-8601 timestamp,
    source: string
  },
  marketSnapshot: { id: string, version: string, digest: string },
  qualitySnapshot: { id: string, version: string, digest: string },
  researchSnapshot: { id: string, version: string, digest: string },
  underwritingSnapshot: { id: string, version: string, digest: string },
  evidence: { digest: string, refs: string[] },
  blockerCodes: string[],
  underwriting: {
    longTermGate: PASS | FAIL | BLOCKED,
    evidenceIds: string[],
    valuationRange: ValuationRange | null,
    entryRange: EntryRange | null,
    invalidationRules: InvalidationRule[]
  },
  timingAssessment: {
    status: PASS | EVENT_RISK | FAIL | BLOCKED,
    asOf: ISO-8601 timestamp,
    evidenceIds: string[],
    reasonCodes: string[]
  },
  capacitySummary: {
    currentPosition: { weight: non-negative number, positionRef: string },
    effectiveLimit: non-negative number,
    capacityToLimit: non-negative number,
    portfolioSnapshotRef: { id: string, version: string, digest: string },
    capacityPolicyRef: { id: string, version: string, digest: string },
    digests: { capacity: string, portfolio: string, capacityPolicy: string }
  } | null,
  positionSizing: {
    targetPosition: non-negative number,
    additionalCapacity: non-negative number
  } | null,
  decisionPolicyRef: { id: string, version: string, digest: string },
  buyAction: OPEN | ADD | PILOT | WATCH | NO_ACTION,
  holdingRisk: NONE | REVIEW | EXIT_REVIEW | REDUCE_REVIEW,
  reasonCodes: string[]
}
```

The evaluated price and every market, quality, research, underwriting, and portfolio snapshot reference carry an ID, version, and digest; the evidence digest and references bind the claims to those snapshots. `capacitySummary` contains only the derived current position, effective limit, capacity to limit, `portfolioSnapshotRef`, `capacityPolicyRef`, and digests; complete private hard limits remain only in the encrypted `SnapshotStore`. `capacityPolicyRef` identifies the policy that supplied capacity constraints, while `decisionPolicyRef` identifies the separate action and timing policy; they must not be conflated. `positionSizing.targetPosition` is a total NLV-weighted position, never an amount to add; `positionSizing.additionalCapacity` is the addable amount. There is no top-level position alias in v2. A blocked record has no actionable target, retains blocker codes, and never silently downgrades an unknown value to zero.

## Decision invariants and fail-closed rules

- A single decision uses one coherent `MarketDataSnapshot` and quality as-of; mixed timestamps are blocked.
- Every positive-weight fundamental factor needs a finite raw value, a valid peer sample, and a finite normalized observation. Missing, constant, or under-sampled factors contribute no score; zero-weight factors cannot block a single-factor policy.
- Timing is downstream of the `LongTermGate` and `ValuationRange`. Timing cannot promote a failed or evidence-free long-term case.
- `PASS` and `FAIL` are evidence-backed claims. A missing, stale, contradictory, or unscoped evidence reference yields `Evaluation Blocked` rather than a guessed status.
- Valuation and entry ranges are ordered, same-currency intervals with explicit uncertainty and provenance. A single Yahoo target is never authoritative; Yahoo may be one evidence source only.
- All capacity values share the NLV denominator. `effectiveLimit` is the minimum of hard limits and current position plus each remaining capacity; `capacityToLimit >= 0` must hold. Position sizing then enforces `0 <= positionSizing.targetPosition <= effectiveLimit` and `positionSizing.additionalCapacity = max(0, positionSizing.targetPosition - currentPosition.weight)`.
- `OPEN`, `ADD`, and `PILOT` require `entryStatus=PERMITTED`, positive `positionSizing`, and a valid `capacitySummary` whose private snapshot references resolve. `PILOT` is only a first small position for a non-holder with event risk; `WATCH` and `NO_ACTION` never imply an order.
- A holding above its effective limit cannot receive an add action; it produces `NO_ACTION` with `REDUCE_REVIEW` or another policy-selected holding risk.
- Private underwriting, timing, account facts, limits, and decision records never enter public research artifacts. The external boundary is read-only and has no order side effect.

## Five-action determination

Decision policy evaluates gates in this order: research integrity, long-term gate, invalidation and thesis state, valuation and entry range, capacity, then timing. The first blocking condition wins; later gates cannot repair it.

1. Invalid research, missing evidence, invalid policy, or invalid capacity produces `dataStatus=EVALUATION_BLOCKED`, `entryStatus=PROHIBITED`, and `NO_ACTION`.
2. A failed long-term gate or triggered material invalidation produces `WATCH` for a non-holder, or `NO_ACTION` with `REVIEW`/`EXIT_REVIEW` for a holder.
3. A failed valuation, out-of-range price, or prohibited entry range produces `WATCH` for a non-holder; a holder receives `NO_ACTION` and retains its holding-risk assessment.
4. A valid case with zero capacity or a position at/above `effectiveLimit` produces `NO_ACTION`; it is not an evaluation blocker.
5. With entry permitted and capacity available, `TimingAssessment=FAIL` yields `WATCH`/`NO_ACTION`, `EVENT_RISK` yields `PILOT` only for a non-holder's first small position and yields `NO_ACTION` for a holder, and `PASS` yields `OPEN` for no holding or `ADD` for a holding below `positionSizing.targetPosition`.

The gate-to-action mapping is deterministic:

| First decisive result | No holding | Existing holding | HoldingRisk |
| --- | --- | --- | --- |
| Research/evidence/policy/capacity invalid | `NO_ACTION` with `EVALUATION_BLOCKED` | `NO_ACTION` with `EVALUATION_BLOCKED` | `REVIEW` when a holding fact is present |
| Long-term gate `FAIL` | `WATCH` | `NO_ACTION` | `REVIEW` |
| Invalidation `TRIGGERED` with severity `REVIEW` | `WATCH` | `NO_ACTION` | `REVIEW` |
| Invalidation `TRIGGERED` with severity `PROHIBIT_ENTRY` | `WATCH` | `NO_ACTION` | `REVIEW` |
| Invalidation `TRIGGERED` with severity `EXIT_REVIEW` | `WATCH` | `NO_ACTION` | `EXIT_REVIEW` |
| Valuation `FAIL` or current price outside `EntryRange` | `WATCH` | `NO_ACTION` | `REVIEW` |
| Capacity zero or at `effectiveLimit` | `NO_ACTION` | `NO_ACTION` | `NONE` |
| Timing `FAIL` | `WATCH` | `NO_ACTION` | `REVIEW` |
| Timing `EVENT_RISK` | `PILOT` only if no holding and policy permits | `NO_ACTION` (never `PILOT`) | `REVIEW` |
| All gates `PASS`, target above current | `OPEN` | `ADD` | `NONE` |
| All gates `PASS`, no additional capacity | `NO_ACTION` | `NO_ACTION` | `NONE` |

## Symbol-case orchestration

The public producer publishes a coherent `stat.json` and `data-quality.json`
pair before a request. For one invocation, the CLI:

1. validates argv and the optional ledger path before reading stdin or making a
   request, then reads the private case file and one normalized
   `RobinhoodReadV1` collector bundle from stdin;
2. reads each public file once from one base URL using `GET` without a body,
   preserving the `stat.json` response text byte-for-byte;
3. verifies the manifest's raw-artifact hash/bytes/symbol counts, then selects
   the canonicalized symbol row and builds one secondary public price observation;
4. normalizes the complete Robinhood read facts with the verified public
   classifications, without accepting caller-supplied capacity or action fields;
5. combines only the public research inputs with the explicit private sections;
6. evaluates the fixed domain stages and emits one sanitized `DecisionRecordV2`;
7. when requested, appends that exact stdout record once to the external ledger.

The CLI does not refresh an account, place an order, call a broker, write public
data, or mutate a UI. It never falls back to a private quote, another symbol,
an unqualified ranking, or an inferred personal policy. A late, partial, stale,
or inconsistent semantic input is `Evaluation Blocked`.

`derivePortfolioCapacitySnapshot` is the only authority for NLV-denominated
capacity and limits. `evaluateDecision` is the only authority for `OPEN`, `ADD`,
and every other action. The collector and Robinhood adapter may supply facts but
must not duplicate either decision.

## Privacy and execution boundary

The public pipeline may be cached, reviewed, and published without an account identity. Private inputs are kept outside public artifacts and repository history, with access limited to the investor's decision context; request URLs, bodies, headers, stderr, logs, and evidence references must not contain credentials or raw account secrets.

`PrivateLedger` stores only derived weights, action/risk outcomes, policy references, and snapshot/evidence references or digests. It does not store raw NLV, quantity, market value, account ID, or the normalized collector bundle. Collector-bundle persistence is not part of this contract. The private `SnapshotStore` is encrypted, content-addressed, and immutable; its retention cannot end before any referencing decision record, and deletion requires no remaining references.

The workbench is decision support only. It may read and normalize holdings, evaluate policy, and write a private `DecisionRecordV2`; it must not submit, schedule, amend, cancel, or simulate a broker order as if it had executed. Any future execution requires a separate, explicit, human-authorized system at the `Execution Boundary`. If `--ledger` is used, the target must be an external owner-only (`0600`) regular file; symlinked targets/parents, repository paths, devices, and group/other-readable files are rejected. Before writing, the CLI revalidates every parent component, opens with `O_NOFOLLOW`, verifies the opened regular file's device/inode and mode against the final real path, rechecks the components, and writes only through that verified file descriptor.

## Migration order and deletion list

Migration is a clean cutover to the target contracts; no compatibility layer, alias, fallback path, or dual-write is planned.

1. Define and test the target domain contracts and invariants for snapshots, evidence, underwriting, valuation, invalidation, timing, capacity, policy, and `DecisionRecordV2`.
2. Replace the public producer with `MarketDataSnapshot` and `FundamentalResearch`, remove timing from the fundamental catalog, and make the quality manifest the required research gate.
3. Introduce private structured underwriting and evidence-backed valuation/entry/invalidation, followed by the downstream `TimingAssessment`.
4. Replace position math with the NLV-denominated `PortfolioCapacitySnapshot`;
   accept only the exact normalized `RobinhoodReadV1` collector bundle on stdin,
   keep capacity policy in the private case, and do not add an account-provider
   client or MCP authentication to Node.
5. Replace decision output with `DecisionRecordV2` and private-ledger persistence, then remove the old decision field names and ungrounded status paths.
6. After the v2 cutover, rewrite or delete the old `docs/decision-core.md` v1 description so it is no longer an authoritative contract; do not leave two decision models in force.

The following old mechanisms are deleted as each step lands:

- `queryStocks` and the old ranking path in `src/lib/queryStocks.js`.
- The direct `queryStocks` and `MFDataTemplate` consumption in `src/App.jsx`; the application must consume the target research/decision boundary instead.
- `mf`/`MFDataTemplate` in `src/lib/mf.js` and the associated multi-factor compatibility path.
- `computeRiskScores`; risk is represented by structured underwriting, invalidation, timing, and capacity instead of a second opaque score.
- Timing entries in the fundamental catalog, including near-term performance and moving-average factors.
- Any direct `PASS`/`FAIL` emission that has no evidence references and no blocker outcome for unknown data.
- The `recommendedPosition` field; v2 uses `targetPosition`, with `additionalCapacity` carrying the amount that may be added.
- Yahoo's single-point target price as an authoritative valuation; source observations may remain evidence, but the decision requires an evidence-backed range.
- The v1 `docs/decision-core.md` authority after v2 is live; rewrite or remove it as part of the cutover rather than preserving a stale specification.

No compatibility layer is added for these deletions. Consumers migrate to the final names and boundaries in order, and stale paths are removed rather than retained behind aliases.
