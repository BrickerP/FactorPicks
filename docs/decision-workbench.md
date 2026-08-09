# Target Architecture / Not yet fully implemented

This document describes the final non-UI architecture for FactorPicks. It is a target contract and migration plan, not a claim that the repository already implements every boundary below; existing CLI usage remains documented separately.

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

Public artifacts may contain the `Research Universe`, source-normalized `MarketDataSnapshot`, `Quality Manifest`, and `FundamentalResearch` facts that can be independently inspected. They must not contain a personal thesis, valuation assumptions, entry range, invalidation state, timing judgment, account holdings, personal/industry/portfolio limits, or a `DecisionRecord`.

Private state begins with the `Underwriting Case` and includes its evidence interpretation, valuation and entry assumptions, invalidation rules, timing assessment, portfolio capacity, decision policy, and private ledger. Evidence may point back to a public source, but the claim it supports and the investor's confidence remain private; publishing a source does not publish the thesis.

Robinhood is an external, read-only adapter. It may normalize authenticated account facts such as symbol, quantity, market value, account as-of time, and net liquidation value into a private holdings input; it does not expose credentials, personal policy, industry/sector strategy, portfolio strategy, or any write capability to this repository.

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

`reference` must identify a retrievable source without embedding credentials. A gate may be `PASS` or `FAIL` only when it names one or more applicable evidence IDs; otherwise the result is `Evaluation Blocked`, never an ungrounded status.

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

## Five-minute prefetch orchestration (request-time only)

The five-minute budget applies to request-time assembly, not to a full-market fetch. Full-market research is prefetched offline well before a decision request and is accepted only when its `Quality Manifest` is valid:

1. An earlier offline batch freezes the `Research Universe`, fetches the full market, validates source identity/counts/freshness/critical-field coverage, and derives timing-excluded `FundamentalResearch`.
2. At request start, read the most recent valid `FundamentalResearch` and quality snapshot by reference; do not start a full-market fetch at `T-5` or inside the request.
3. Refresh only the requested symbol's quote and `TimingAssessment`, using one quote as-of and explicit timing evidence.
4. When capacity is needed, refresh the external read-only Robinhood account facts and normalize only holdings/denominator references; do not fetch or infer private strategy from public research.
5. Load the private `Underwriting Case`, compute `PortfolioCapacitySnapshot`, run `DecisionPolicy` and `PositionSizing`, create `DecisionRecordV2`, and append the sanitized derived record to `PrivateLedger`.

If no recent valid fundamental snapshot exists, or any request-time quote, timing, account fact, or evidence is late, partial, stale, or internally inconsistent, the evaluation is `Evaluation Blocked`. The request never mixes rows from different fundamental snapshots or falls back to an unqualified ranking. Timing and quote refreshes may update the single-symbol decision inputs, but cannot mutate the published fundamental snapshot.

## Privacy and execution boundary

The public pipeline may be cached, reviewed, and published without an account identity. Private inputs are kept outside public artifacts and repository history, with access limited to the investor's decision context; logs and evidence references must not contain credentials or raw account secrets.

By default, `PrivateLedger` stores only derived weights, action/risk outcomes, policy references, and snapshot/evidence references or digests. It does not store raw NLV, quantity, market value, or account ID. The private `SnapshotStore` is encrypted, content-addressed, and immutable; its retention cannot end before any referencing decision record, and deletion requires no remaining references. If an external system ever persists the raw private input bundle, that system must encrypt it and enforce an explicit retention policy; encrypted raw-bundle persistence is not implemented in the current target.

The workbench is decision support only. It may read and normalize holdings, evaluate policy, and write a private `DecisionRecordV2`; it must not submit, schedule, amend, cancel, or simulate a broker order as if it had executed. Any future execution requires a separate, explicit, human-authorized system at the `Execution Boundary`.

## Migration order and deletion list

Migration is a clean cutover to the target contracts; no compatibility layer, alias, fallback path, or dual-write is planned.

1. Define and test the target domain contracts and invariants for snapshots, evidence, underwriting, valuation, invalidation, timing, capacity, policy, and `DecisionRecordV2`.
2. Replace the public producer with `MarketDataSnapshot` and `FundamentalResearch`, remove timing from the fundamental catalog, and make the quality manifest the required research gate.
3. Introduce private structured underwriting and evidence-backed valuation/entry/invalidation, followed by the downstream `TimingAssessment`.
4. Replace position math with the NLV-denominated `PortfolioCapacitySnapshot`; add the external read-only Robinhood holdings adapter without moving private limits or strategy into public research.
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
