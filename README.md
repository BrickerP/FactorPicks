# FactorPicks

A minimal US stock factor-ranking dashboard. Scores the S&P 500 on quality
(ROE), growth (PEG) and cash-flow value (FCFF/EV), then ranks by a weighted
z-score composite.

**Live site:** https://brickerp.github.io/FactorPicks/

## What it does

- Pulls fundamentals for 503 S&P 500 stocks from Yahoo Finance (free, no API key)
- Scores every stock on ROE, PEG and FCFF/EV (z-score normalized)
- Ranks by a weighted composite of those three factors
- Renders a single sortable table — click any column header to sort
- Watchlist mode (default) or the full S&P 500

## Ranking

The default composite is equal-weight **ROE + PEG + FCFF/EV**:

| Factor | What it measures | Direction |
|---|---|---|
| ROE | Quality — how well equity is deployed | Higher is better |
| PEG | Growth — price relative to earnings growth | Lower is better |
| FCFF/EV | Value — cash yield on enterprise value | Higher is better |

Weights are adjustable in the UI via presets (Quality+Value / ROE / PEG / FCFF/EV)
or per-factor inputs. Scores are z-score composites computed cross-sectionally
across the whole universe; z-scores are winsorized to ±3σ so a single outlier
cannot dominate the ranking.

## Data quality

Source data is sanitized before ranking:

- ROE outside −200%..+300%, or inflated by negative stockholders' equity, is dropped
- P/E ≤ 0 or > 200 is dropped (loss-making or bad data)
- PEG < 0 or > 10 is dropped
- FCFF/EV outside −50%..+30% is dropped (implausible values)

## Data pipeline

```
GitHub Actions (daily 02:10 UTC, or manual dispatch)
  → .github/fetch_stock_data/fetch_stock_data.py
      yfinance Ticker.info + 1y history for 503 S&P500 stocks
      → public/stat.json
  → npm install
  → vite build
  → peaceiris/actions-gh-pages → gh-pages branch
```

## DecisionRecordV2 CLI

The private, headless decision seam consumes one already normalized decision
bundle. It does not fetch or score the full research universe at request time:

```text
{
  research, evaluatedPrice, evidence, underwriting, timingAssessment,
  portfolioCapacity, decisionPolicy, resolvedSnapshots, now
}
```

`portfolioCapacity` contains only NLV-denominated weights, hard limits,
remaining capacities, and immutable references/digests. The resulting
`DecisionRecordV2` excludes raw NLV, quantity, market value, and account ID.
Persisted IDs and references use `<type>:<64 lowercase hex>`; digests use
`sha256:<64 lowercase hex>`. Plain account identifiers and credential-bearing
URLs are rejected rather than copied into a decision or ledger.
The evidence digest is recomputed from an allow-listed Evidence projection,
stably sorted by opaque evidence ID. Unknown upstream research or timing codes
are collapsed to bounded fallback codes instead of being persisted verbatim.
The complete contract and action matrix are documented in
[`docs/decision-workbench.md`](docs/decision-workbench.md).

```bash
npm run decision -- /secure/path/decision-v2.json

# Optionally append the same DecisionRecordV2 to an external private ledger.
npm run decision -- /secure/path/decision-v2.json \
  --ledger /secure/private-ledger/decisions.jsonl
```

The ledger path must resolve outside this repository. The CLI evaluates the
bundle once through `evaluateDecision`; it never places an order. Snapshot
verification resolves each supplied ID/version to an independent payload and
recomputes its canonical SHA-256 digest in process. This proves payload identity
only; it does not prove source authenticity, persistence, or full SnapshotStore
reproducibility. Resolved payloads are validation inputs and are never copied
into the `DecisionRecordV2` or ledger.

## Portfolio capacity CLI

The broker-neutral capacity seam derives one sanitized
`PortfolioCapacitySnapshot` from a complete, time-coherent USD cash-account
snapshot, explicit capacity policy, and an independent liquidity limit. It is a
pure local transformation: no broker SDK, OAuth flow, network request, ledger
write, or order capability is involved.

The input must include an explicit `evaluatedAt`, freshness limits for the
portfolio and liquidity observations, and capacity-policy provenance with
`sourceRef`, `effectiveFrom`, and `effectiveUntil`. Portfolio positions and the
target symbol use canonical uppercase ticker identifiers. Portfolio and
liquidity observations must share one as-of timestamp, and that timestamp must
fall inside the policy validity window.

```bash
npm run capacity -- /secure/path/portfolio-capacity-input.json

# Or pipe one JSON object through stdin.
npm run capacity -- - < /secure/path/portfolio-capacity-input.json
```

Raw NLV, quantity, mark price, account ID, buying power, and cost basis are
accepted only as ephemeral input facts where applicable and are never emitted.
The output contains the derived capacity plus two sanitized resolved snapshot
payloads that can be merged directly into a `DecisionRecordV2` bundle.
Incomplete, margin, multi-account, non-USD, short, option, crypto, mixed-as-of,
or unclassified inputs fail closed.

## Local development

```bash
npm install
npm run dev   # http://localhost:5173
```

To regenerate data locally:

```bash
pip install -r .github/fetch_stock_data/requirements.txt
python .github/fetch_stock_data/fetch_stock_data.py
```

## Tech

- **Vite + React** — no heavy UI framework, single-table interface
- **yfinance** — free stock fundamentals data
- **GitHub Actions + gh-pages** — zero-cost hosting, daily refresh

## License

MIT (see LICENSE). Data is provided by Yahoo Finance via `yfinance`.
