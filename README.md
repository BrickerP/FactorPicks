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

The private workbench is the one end-to-end entry point for a batch of candidate
decisions. It reads an external owner-only cases file and one canonical
`RobinhoodReadV3` bundle from stdin, then performs exactly one `GET` each for
`stat.json` and `data-quality.json`, regardless of candidate count. The default
public base is `https://brickerp.github.io/FactorPicks/`; `--market-url` selects
another trusted base. Private cases never enter a request, log, public artifact,
stdout, stderr, or the ledger. The raw `stat.json` bytes remain bound to the
quality manifest by SHA-256, byte count, and symbol count.

```text
candidate cases + public stat/quality + one RobinhoodReadV3
  → evaluateCandidateBatch
  → canonicalize, reject duplicates, validate the exact target set
  → evaluateSymbolCase once per candidate
  → sorted DecisionRecordV2[]
```

The cases file is exact:

```text
{ schemaVersion: 1, candidates: [{ symbol, privateCase }] }
```

It must be outside the repository, a regular `0400` or `0600` file, and have no
symlink target or ancestor. The CLI opens it with `O_RDONLY | O_NOFOLLOW`, binds
the verified file descriptor to the checked path/device/inode, reads it once,
and revalidates the path before continuing. Canonical duplicate symbols fail
before stdin, public I/O, or ledger creation. `--symbol`, `--case`, V2, unknown
arguments, and trading arguments are not compatibility paths.

The cases file and ledger must also resolve to different device/inode identities;
a second path or hard link is not a separate file. The CLI rejects that alias
before stdin, public I/O, evaluation, or writing, and rechecks the opened ledger
against the bound cases identity before the append.

The Codex runtime connects the normalized V3 collector result directly to stdin
and closes the stream; neither provider input is persisted.

```bash
npm run workbench -- --cases /secure/path/candidate-cases.json

# Optional public base, deterministic evaluation time, and sanitized ledger.
npm run workbench -- --cases /secure/path/candidate-cases.json \
  --market-url https://brickerp.github.io/FactorPicks/ \
  --evaluated-at 2026-08-10T20:00:00.000Z \
  --ledger /secure/private-ledger/decisions.jsonl
```

The Codex runtime binds
`collectRobinhoodRead({selectedAccountNumber, targetSymbols, client, clock?})`
to an authenticated client with only `getAccounts`, `getPortfolio`,
`getEquityPositions`, `getEquityQuotes`, and `getEarningsResults`.
It quotes the sorted de-duplicated union of all targets and holdings in batches
of at most 20 and retrieves one earnings result per target. Plain Node owns no
MCP authentication and makes no Robinhood call. It has no UI, order, cancel,
amend, simulation, or alternate market CLI.

Per-candidate semantic gaps return an exit-zero array containing fail-closed
`NO_ACTION` records. Cases/provider/public transport errors, duplicate symbols,
V3 target-set mismatch, or any global input error exit one with no stdout or
ledger append. Successful stdout is one JSON array line; `--ledger` appends that
exact sanitized line once to an external `0600` file. The complete contract and
action matrix are documented in
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
