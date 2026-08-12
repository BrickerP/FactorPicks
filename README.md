# FactorPicks

FactorPicks is a private opening-and-adding decision workbench for long-horizon
US-stock candidates. Its headless pipeline combines public research, structured
underwriting, read-only Robinhood market/portfolio facts, timing, and portfolio
capacity into a canonical `DecisionRecordV2[]`. The static site reviews that
derived batch without recomputing a decision or exposing the private inputs.

**Live site:** https://brickerp.github.io/FactorPicks/

## Decision workbench UI

The site accepts one local JSON file containing a non-empty canonical
`DecisionRecordV2[]`. Import is atomic: malformed records, duplicate symbols,
unknown schemas, or unknown actions reject the complete replacement and leave
the current in-memory session unchanged.

The UI displays the five supplied actions without deriving or upgrading them:

| Domain action | Display meaning |
| --- | --- |
| `WATCH` | Observe without adding capital. |
| `PILOT` | Open a policy-capped trial position under event risk. |
| `OPEN` | Open a new position. |
| `ADD` | Add to an existing position. |
| `NO_ACTION` | Do not place a new purchase. |

`EVALUATION_BLOCKED` is shown prominently as a separate data status, never as a
sixth action or an ordinary `NO_ACTION`. The candidate queue can be filtered and
sorted, while the case memo presents the supplied current price, valuation and
entry ranges, target/additional position capacity, timing, blocker/reason codes,
holding risk, invalidation states, and content-addressed evidence/provenance.

The current record deliberately exposes opaque evidence and invalidation-rule
references rather than private claim text or rule conditions. The UI therefore
labels the human-readable evidence and invalidation-condition summaries as not
provided; it does not reconstruct them from private cases.

### Privacy and execution boundary

- The browser reads the selected file with the File API and retains only the
  validated projection in React memory.
- It does not upload the file, fetch decisions, persist them in local/session
  storage or IndexedDB, encode them in a URL, log them, or place them in a public
  asset.
- Replacing or clearing the import removes the current in-memory batch; a page
  refresh always starts empty.
- The UI is read-only and has no order, cancel, amend, broker-write, or simulated
  execution affordance.
- Every displayed action, status, weight, range, code, and reference comes from
  the imported record. Missing data remains unavailable rather than becoming
  zero.

## Headless batch generation

The CLI remains the one end-to-end producer for a candidate batch. It reads an
external owner-only cases file and one canonical `RobinhoodReadV3` bundle from
stdin, then performs exactly one `GET` each for `stat.json` and
`data-quality.json`, regardless of candidate count. The default public base is
`https://brickerp.github.io/FactorPicks/`; `--market-url` selects another trusted
base.

```text
candidate cases + public stat/quality + one RobinhoodReadV3
  -> evaluateCandidateBatch
  -> canonicalize, reject duplicates, validate the exact target set
  -> evaluateSymbolCase once per candidate
  -> symbol-sorted DecisionRecordV2[]
  -> local UI import or optional private ledger
```

The cases file has this exact envelope:

```text
{ schemaVersion: 1, candidates: [{ symbol, privateCase }] }
```

It must be outside the repository, a regular `0400` or `0600` file, and have no
symlink target or ancestor. The CLI opens it with `O_RDONLY | O_NOFOLLOW`, binds
the verified descriptor to the checked path/device/inode, reads it once, and
revalidates it before continuing. Canonical duplicate symbols fail before stdin,
public I/O, or ledger creation. The cases file and optional ledger must also have
different device/inode identities.

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
`getEquityPositions`, `getEquityQuotes`, and `getEarningsResults`. Plain Node
owns no MCP authentication and makes no Robinhood call. Neither path can place
or modify an order.

Per-candidate semantic gaps produce fail-closed `NO_ACTION` records inside a
successful array. Cases/provider/public transport errors, duplicate symbols, V3
target-set mismatch, or any global structural error exit one with no stdout or
ledger append. Successful stdout is one JSON-array line; `--ledger` appends that
same sanitized line once to an external `0600` file. See
[`docs/decision-workbench.md`](docs/decision-workbench.md) for the full contract.

## Public data pipeline and cleaning

GitHub Actions refreshes the public research artifacts daily and before a Pages
deployment:

```text
GitHub Actions (daily 02:10 UTC, push to master, or manual dispatch)
  -> .github/fetch_stock_data/fetch_stock_data.py
       -> public/stat.json
       -> public/data-quality.json
  -> contract tests and quality gate
  -> Vite build
  -> gh-pages
```

The producer obtains US-stock fundamentals through `yfinance` and sanitizes
implausible source values before publishing them. Examples include ROE outside
the accepted range or inflated by negative equity, non-positive/extreme P/E,
PEG outside the accepted range, and implausible FCFF/EV. The quality manifest
binds the exact `stat.json` bytes by SHA-256, byte count, and symbol count. These
artifacts are research inputs to the headless evaluator; the browser does not
use them to recreate the retired ranking dashboard.

Robinhood is the sole current-price authority for a decision. Yahoo `Close` and
single-point analyst targets are not promoted to an actionable current price or
authoritative valuation.

## Local development

```bash
npm install
npm run dev   # http://localhost:5173
npm test
```

To regenerate the public research artifacts locally:

```bash
pip install -r .github/fetch_stock_data/requirements.txt
python .github/fetch_stock_data/fetch_stock_data.py
```

Production builds are performed by GitHub Actions.

## Technology

- React 18 + Vite 5 + plain CSS
- Node's built-in test runner for domain and pure UI-model tests
- Python + `yfinance` for public research collection
- GitHub Actions + GitHub Pages for the static application

## License

MIT (see LICENSE). Public market data is provided by Yahoo Finance via
`yfinance`; private decision and account inputs are not published.
