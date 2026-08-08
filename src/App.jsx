import React, { useEffect, useMemo, useState } from 'react'
import { queryStocks } from './lib/queryStocks'
import { MFDataTemplate } from './lib/mf'
import { StockSectorDict, StockIndustryDict } from './lib/stockdef'
import { WATCHLIST } from './lib/watchlist'

const CORE_FACTORS = ['FCFF/EV_w', 'PEG_w', 'ROE_w']

const PRESETS = {
  'Quality+Value': { ROE_w: '1.0', 'FCFF/EV_w': '1.0', PEG_w: '1.0' },
  ROE: { ROE_w: '1.0' },
  PEG: { PEG_w: '1.0' },
  'FCFF/EV': { 'FCFF/EV_w': '1.0' },
}

const DEFAULT_WEIGHTS = MFDataTemplate.weights.reduce((acc, w) => {
  acc[w.name] = CORE_FACTORS.includes(w.name) ? w.val : '0'
  return acc
}, {})

const NO_DATA = -Number.MAX_VALUE

function fmtNum(v) {
  if (v === null || v === undefined || v === NO_DATA || Number.isNaN(v)) return 'NaN'
  return Number.isFinite(v) ? v.toFixed(2) : 'NaN'
}

function fmtPct(v) {
  if (v === null || v === undefined || v === NO_DATA || Number.isNaN(v)) return 'NaN'
  return (v * 100).toFixed(1) + '%'
}

function fmtMc(v) {
  if (v === null || v === undefined || v === NO_DATA || Number.isNaN(v)) return 'NaN'
  const b = v / 1e9
  if (b >= 1000) return (b / 1000).toFixed(2) + 'T'
  return b.toFixed(1) + 'B'
}

function App() {
  const [rows, setRows] = useState([])
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS)
  const [mode, setMode] = useState('watchlist')
  const [sortKey, setSortKey] = useState('multiFactor')
  const [sortDir, setSortDir] = useState('desc')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const doQuery = async (w = weights, m = mode) => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('stat.json')
      if (!resp.ok) throw new Error('stat.json fetch failed: ' + resp.status)
      const data = await resp.json()

      const queryData = {
        data: {
          baseArg: [],
          advArg: [],
          sector_industries: {},
          Factor_Intersectional_v1: { args: { ...w } },
        },
      }

      let out = queryStocks(data, queryData)
      if (m === 'watchlist') {
        out = out.filter(v => WATCHLIST.includes(v.symbol))
      }
      setRows(out)
    } catch (err) {
      setError(String(err && err.message ? err.message : err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    doQuery()
  }, [])

  const onWeightChange = (name, value) => {
    const next = { ...weights, [name]: value }
    setWeights(next)
  }

  const onPreset = (preset) => {
    const next = { ...DEFAULT_WEIGHTS, ...preset }
    setWeights(next)
    doQuery(next, mode)
  }

  const toggleMode = () => {
    const next = mode === 'watchlist' ? 'all' : 'watchlist'
    setMode(next)
    doQuery(weights, next)
  }

  const onSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' || key === 'name' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      if (a[sortKey] === b[sortKey]) return 0
      if (a[sortKey] == null) return 1
      if (b[sortKey] == null) return -1
      return a[sortKey] > b[sortKey] ? dir : -dir
    })
  }, [rows, sortKey, sortDir])

  const cols = [
    { key: 'symbol', label: 'Symbol', cls: 'num' },
    { key: 'name', label: 'Name', cls: '' },
    { key: 'marketCap', label: 'Market Cap', cls: 'num', fmt: fmtMc },
    { key: 'PE', label: 'P/E', cls: 'num', fmt: fmtNum },
    { key: 'PEG', label: 'PEG', cls: 'num', fmt: fmtNum },
    { key: 'FCFFEV', label: 'FCFF/EV', cls: 'num', fmt: fmtPct },
    { key: 'ROE', label: 'ROE', cls: 'num', fmt: fmtPct },
    { key: 'multiFactor', label: 'Rank', cls: 'num', fmt: fmtNum },
  ]

  const sectors = new Set(rows.map(r => r.sector).filter(Boolean))

  return (
    <div className="wrap">
      <header className="top">
        <h1>NornScreener</h1>
        <button className="btn" onClick={toggleMode}>
          {mode === 'watchlist' ? `Watchlist (${WATCHLIST.length})` : 'All Stocks'}
        </button>
      </header>

      <section className="panel">
        <div className="presets">
          <span className="label">Rank by:</span>
          {Object.entries(PRESETS).map(([name, preset]) => (
            <button key={name} className="btn small" onClick={() => onPreset(preset)}>
              {name}
            </button>
          ))}
          <button className="btn small" onClick={() => onPreset({})}>Clear weights</button>
        </div>
        <div className="weights">
          {CORE_FACTORS.map(name => (
            <label key={name} className="weight">
              {MFDataTemplate.weights.find(w => w.name === name)?.display_name}
              <input
                type="number"
                step="0.1"
                value={weights[name]}
                onChange={e => onWeightChange(name, e.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="actions">
          <span className="muted">{rows.length} stocks</span>
          {sectors.size > 0 && <span className="muted">{sectors.size} sectors</span>}
          <button className="btn primary" onClick={() => doQuery()}>Apply</button>
        </div>
      </section>

      {error && <div className="error">Query failed: {error}</div>}

      <section className="table-wrap">
        {loading ? (
          <div className="loading">Loading…</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} className={c.cls}>
                    <button className={sortKey === c.key ? `th-sort ${sortDir}` : 'th-sort'} onClick={() => onSort(c.key)}>
                      {c.label}
                      {sortKey === c.key && <span className="arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.symbol}>
                  {cols.map(c => (
                    <td key={c.key} className={c.cls}>
                      {c.fmt ? c.fmt(r[c.key]) : r[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="foot">
        <a href="https://github.com/BrickerP/Norn-StockScreener" target="_blank" rel="noreferrer noopener">Source</a>
        <span className="muted">Data: yfinance · S&P 500 · updated daily</span>
      </footer>
    </div>
  )
}

export default App
