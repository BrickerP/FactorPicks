# Decision core

FactorPicks implements the complete decision domain as a headless core. It is not an MVP or a UI prototype. The current delivery boundary is the full research-to-decision path and its policy gates; a browser UI is intentionally later and must consume the same domain seams instead of duplicating their rules.

The two public seams are:

- `evaluateResearch({ universe, symbol, qualityManifest, policy, now })` in `src/domain/evaluateResearch.js`
- `evaluateDecision({ research, underwriting, portfolio, policy, now })` in `src/domain/evaluateDecision.js`

The command-line adapter in `scripts/evaluate-decision.js` calls them in that order. It does not supply policy defaults, repair inputs, or reinterpret the returned decision.

## Data boundary

Public research and private investment state are separate layers.

| Layer | Data | Publication boundary |
| --- | --- | --- |
| Public research | `universe`, `symbol`, `qualityManifest`, and the derived research snapshot | May feed a public research experience after a separate publisher has selected and reviewed it |
| Private decision | underwriting and thesis state, portfolio capacity, personal policy, and the resulting `DecisionRecord` | Must remain outside `public/`, Pages artifacts, and committed repository data |

`underwriting` is the private representation of the investor's thesis and gates. FactorPicks does not infer it from public ranking data. `portfolio` is also supplied at evaluation time; it is not fetched by this repository.

Robinhood MCP, when used, is an external read-only adapter. An agent may read an authenticated account outside this repository and normalize that data into the `portfolio` input. FactorPicks does not implement Robinhood OAuth, store Robinhood credentials, expose an account adapter in Pages, or write back orders.

## Input schema

The CLI accepts exactly one JSON bundle from a file or standard input. All fields are required. JSON callers represent `now` as an ISO-8601 timestamp string.

| Field | JSON shape | Destination |
| --- | --- | --- |
| `universe` | Domain research universe | `evaluateResearch` |
| `symbol` | String identifying the evaluated security | `evaluateResearch` |
| `qualityManifest` | Domain quality-manifest object | `evaluateResearch` |
| `underwriting` | Object described below | `evaluateDecision` |
| `portfolio` | Object described below | `evaluateDecision` |
| `policy` | Object with required `research` and `decision` objects | Both seams |
| `now` | ISO-8601 timestamp string | Both seams |

The private underwriting object is:

```json
{
  "longTermGate": "PASS",
  "thesisStatus": "INTACT",
  "valuationStatus": "PASS",
  "timingStatus": "PASS",
  "systemRiskLimit": 0.05
}
```

Allowed values are `PASS | FAIL` for `longTermGate` and `valuationStatus`, `INTACT | INVALIDATED` for `thesisStatus`, and `PASS | EVENT_RISK | FAIL` for `timingStatus`. `systemRiskLimit` is a hard limit and must be greater than zero.

The private portfolio object is:

```json
{
  "currentPosition": 0,
  "userHardLimit": 0.03,
  "sectorRemainingCapacity": 0.08,
  "portfolioRemainingCapacity": 0.1
}
```

`currentPosition` must be non-negative. `userHardLimit` is a hard limit and must be greater than zero; when it is absent, the domain returns a blocked decision rather than inventing a limit. `sectorRemainingCapacity` and `portfolioRemainingCapacity` are remaining-capacity values, so zero is valid and means no additional position can be recommended.

Policy is explicit and has this shape:

```json
{
  "research": {
    "factorWeights": {
      "factor.metric": 1
    },
    "minimumSectorSampleSize": 3,
    "minimumGlobalSampleSize": 10,
    "manifestMaxAgeMs": 86400000,
    "maxFutureSkewMs": 300000,
    "criticalFields": ["source_field"],
    "minimumCriticalFieldCoverage": 0.95,
    "minimumResearchCoverage": 0.8
  },
  "decision": {
    "eventRiskMode": "downgrade",
    "pilotPositionLimit": 0.01
  }
}
```

`factorWeights` maps catalog metric IDs to non-negative weights and must contain at least one positive weight. Sample sizes are positive integers. Age and future-skew limits are non-negative millisecond values. `minimumCriticalFieldCoverage` is a number from zero through one, while `minimumResearchCoverage` must be greater than zero and at most one. `criticalFields` is a non-empty array of source field names. `eventRiskMode` is `downgrade | block`. `pilotPositionLimit` must be finite and greater than zero; the actual `PILOT` position is the minimum of that limit and the computed effective/remaining capacity.

`universe` and `qualityManifest` use the canonical research contracts enforced by `evaluateResearch`; the CLI forwards them without transformation. It likewise leaves all validation and reason-code generation to the domain core.

## Output schema

Standard output is exactly the `DecisionRecord` returned by `evaluateDecision`, formatted as one JSON object. The CLI adds no envelope. Its stable top-level fields are:

```text
DecisionRecord {
  symbol
  decidedAt
  dataStatus
  buyAction
  holdingRisk
  recommendedPosition
  capacity
  reasonCodes
}
```

The domain module owns the values and nested shapes of these fields. `reasonCodes` explains applicable gates; consumers must not replace it with UI-only reasoning. The optional ledger contains the same `DecisionRecord` serialized on one JSONL line per successful invocation.

## Commands

Read a bundle from a file:

```sh
npm run decision -- /secure/path/decision-input.json
```

Read a bundle from standard input:

```sh
npm run decision -- - < /secure/path/decision-input.json
```

Append the successful decision to an explicitly selected private ledger:

```sh
npm run decision -- /secure/path/decision-input.json \
  --ledger /var/lib/factorpicks-private/decision-ledger.jsonl
```

Without `--ledger`, the command does not persist anything. A ledger path is resolved before use and must be outside the repository root; paths under `public/`, `dist/`, or any other repository directory are rejected. Existing ledger targets must be regular files rather than symbolic links, devices, or FIFOs. For a new ledger, the nearest existing parent is resolved before enforcing the same boundary. Its external parent directory must already exist, and the command appends one record; it does not redact or encrypt that file.

Malformed JSON, invalid arguments, domain validation failures, and ledger write failures are reported on standard error and set a non-zero exit status.

## Execution boundary

A `DecisionRecord` is decision support, not an order instruction. Neither seam nor the CLI calls a broker, submits an order, schedules an order, or changes a portfolio. Any future execution adapter must remain a separate, explicit, human-authorized boundary. A later UI may display research and decisions, but it must not turn evaluation into automatic trading or move private inputs into the public build.
