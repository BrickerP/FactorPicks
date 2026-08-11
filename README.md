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

## Headless decision workbench

The private workbench is the one end-to-end entry point for a symbol decision.
The CLI reads the private case from a named local file and one canonical
`RobinhoodReadV1` collector bundle of allow-listed normalized projections from
stdin, then obtains the public research inputs
itself: exactly one `GET` each for `stat.json` and `data-quality.json`. The
default public base is `https://brickerp.github.io/FactorPicks/`; `--market-url`
selects another trusted base, such as a local read-only test server. The private
case is never placed in a request body, header, URL, log, or public artifact.
`stat.json` is retained as the exact UTF-8 response text, never parsed and
re-serialized before evaluation. The quality manifest's `statArtifact`
`sha256`, byte count, and symbol count bind that exact text to the manifest;
any artifact/manifest mismatch fails closed.

```text
public stat + quality manifest + private case + RobinhoodReadV1 collector bundle
  → evaluateSymbolCase
  → evaluateResearch
  → deriveEvidenceBundle
  → deriveStructuredUnderwriting
  → deriveTimingAssessment (price is derived from one fresh quote)
  → deriveRobinhoodPortfolioInput
  → derivePortfolioCapacitySnapshot
  → evaluateDecision
```

The private case contains only `schemaVersion`, `researchPolicy`,
`sourceSnapshots`, `evidence`, `underwriting`, `timing`, `capacityPolicy`, and
`decisionPolicy`. The collector bundle contains exactly `schemaVersion`,
`capturedAt`, `selectedAccountNumber`, `accounts`, `portfolio`, `positionPages`,
and `quoteBatches`; `portfolio` is bound to the selected account as
`{accountNumber, data}`. Neither input contains the symbol, evaluation time, public market
universe, quality manifest, or a private current-price source. After validating
the raw artifact binding, the adapter reserves `key=price`, `claimKey=PRICE`, and
`factKey=CURRENT_PRICE` for the selected public row, while timing is fixed to
`currentPriceFactKey=CURRENT_PRICE`. Analyst targets, historical prices, and
other price-like facts may remain ordinary evidence under different names, but
they cannot become `evaluatedPrice`. The adapter does not infer missing quotes,
valuation, timing state, capacity, policy, or action from the public ranking.
Content-addressed projectors reject tampering,
duplicates, stale/conflicting observations, and wrong-symbol/as-of data. The
final action is only `OPEN`, `ADD`, `PILOT`, `WATCH`, or `NO_ACTION`; this
repository has no order path, direct Robinhood HTTP/auth client, or workbench UI.

```bash
npm run workbench -- --symbol AAPL --case /secure/path/private-case.json --robinhood -

# Optional public base and deterministic evaluation time.
npm run workbench -- --symbol AAPL --case /secure/path/private-case.json \
  --robinhood - \
  --market-url https://brickerp.github.io/FactorPicks/ \
  --evaluated-at 2026-08-10T08:00:00.000Z

# Optional append to an external private ledger (never inside this repository).
npm run workbench -- --symbol AAPL --case /secure/path/private-case.json \
  --robinhood - \
  --ledger /secure/private-ledger/decisions.jsonl
```

The Codex runtime binds `collectRobinhoodRead` to an authenticated client with
only `getAccounts`, `getPortfolio`, `getEquityPositions`, and `getEquityQuotes`.
Those methods correspond to the MCP read allowlist `get_accounts`,
`get_portfolio`, `get_equity_positions`, and `get_equity_quotes`. The collector
selects the account explicitly and emits normalized projections with complete
pagination and quote batches; MCP transport responses are not the CLI bundle.
Plain Node holds no MCP authentication and only consumes the collected bundle
on stdin. It never calls Robinhood, retries collection, caches or writes the
bundle, or places, amends, cancels, or simulates an order. There is no alternate
CLI or UI path.
Portfolio capacity remains authoritative only in
`derivePortfolioCapacitySnapshot`, and `OPEN`/`ADD` remain authoritative only in
`evaluateDecision`.

Semantic data problems, including a structurally complete but invalid collector
bundle, produce `EVALUATION_BLOCKED` + `NO_ACTION` with bounded blocker codes and
exit zero. Missing collection, invalid arguments or stdin transport JSON,
private-case JSON/top-level shape, public HTTP/JSON, and file I/O errors exit one
with generalized stderr. NLV/`total_value`, quantity, mark price,
average buy price, pagination cursors, account identifiers,
credentials, source payloads, free-form invalidation conditions/responses, and
private claims are never copied to the output or ledger. The public invalidation
projection contains only rule identity, evidence references, bounded severity,
and state. Derived fields submitted by a caller are rejected; only canonical
raw sections are accepted. The complete contract and action matrix are documented in
[`docs/decision-workbench.md`](docs/decision-workbench.md).

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
