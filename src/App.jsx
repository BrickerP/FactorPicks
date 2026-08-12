import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  filterDecisionRecords,
  parseDecisionRecordBatch,
} from './ui/decisionRecords.js'

const ACTIONS = [
  { code: 'WATCH', label: '观察' },
  { code: 'PILOT', label: '试仓' },
  { code: 'OPEN', label: '开仓' },
  { code: 'ADD', label: '增持' },
  { code: 'NO_ACTION', label: '不操作' },
]

const STATUS_LABELS = {
  VALID: '数据有效',
  EVALUATION_BLOCKED: '评估阻断',
  PERMITTED: '允许入场',
  PROHIBITED: '禁止入场',
  PASS: '通过',
  FAIL: '未通过',
  BLOCKED: '阻断',
  EVENT_RISK: '事件风险',
  NONE: '无',
  REVIEW: '复核',
  EXIT_REVIEW: '退出复核',
  REDUCE_REVIEW: '减仓复核',
  TRIGGERED: '已触发',
  UNTRIGGERED: '未触发',
  UNKNOWN: '未知',
  PROHIBIT_ENTRY: '禁止入场',
}

const PROVENANCE_LABELS = {
  marketSnapshot: '市场快照',
  qualitySnapshot: '质量快照',
  researchSnapshot: '研究快照',
  underwritingSnapshot: '投研快照',
  portfolioSnapshot: '组合快照',
  capacityPolicy: '容量政策',
  decisionPolicy: '决策政策',
}

const CODE_LABELS = {
  ALL_GATES_PASSED: '全部决策门槛通过',
  EVENT_RISK: '存在近期事件风险',
  LONG_TERM_GATE_FAILED: '长期基本面门槛未通过',
  NO_EFFECTIVE_CAPACITY: '组合无有效新增容量',
  POSITION_ABOVE_EFFECTIVE_LIMIT: '当前仓位高于有效上限',
  PRICE_OUTSIDE_ENTRY_RANGE: '当前价格不在入场区间',
  TIMING_FAILED: '时机门槛未通过',
  UNDERWRITING_INVALIDATED: '投研假设已被失效规则触发',
  EARNINGS_SOON: '财报事件临近',
  TIMING_EVIDENCE_NOT_FRESH: '时机证据不够新鲜',
  TIMING_PRICE_CONFLICT: '时机价格证据冲突',
  TIMING_PRICE_FUTURE: '时机价格时间来自未来',
  TIMING_PRICE_MISSING: '缺少可用的时机价格',
  TIMING_PRICE_STALE: '时机价格已过期',
  TIMING_RESTRICTED: '时机评估受限',
  TIMING_SUPPORT_MISSING: '缺少时机支持证据',
  TIMING_SUPPORT_NOT_OBSERVED: '时机支持并非直接观察',
  EMPTY_MANIFEST_RESULTS: '质量清单没有成功结果',
  FAILED_SYMBOL_COUNT_CONFLICT: '失败股票数量冲突',
  FUTURE_QUALITY_MANIFEST: '质量清单时间来自未来',
  INSUFFICIENT_CRITICAL_FIELD_COVERAGE: '关键字段覆盖不足',
  INSUFFICIENT_RESEARCH_COVERAGE: '研究覆盖不足',
  INVALID_CRITICAL_FIELDS: '关键字段定义无效',
  INVALID_CRITICAL_FIELD_COVERAGE: '关键字段覆盖无效',
  INVALID_FACTOR_WEIGHT: '因子权重无效',
  INVALID_FACTOR_WEIGHTS: '因子权重集合无效',
  INVALID_FAILED_SYMBOLS: '失败股票列表无效',
  INVALID_MANIFEST_COUNTS: '质量清单计数无效',
  INVALID_MANIFEST_COVERAGE: '质量清单覆盖无效',
  INVALID_MINIMUM_RESEARCH_COVERAGE: '最低研究覆盖要求无效',
  INVALID_QUALITY_MANIFEST: '质量清单无效',
  INVALID_QUALITY_MANIFEST_TIME: '质量清单时间无效',
  INVALID_RESEARCH_MANIFEST_AGE: '研究清单时效要求无效',
  INVALID_RESEARCH_POLICY: '研究政策无效',
  INVALID_RESEARCH_SAMPLE_SIZE: '研究样本规模无效',
  MANIFEST_COUNTS_CONFLICT: '质量清单计数冲突',
  MANIFEST_COVERAGE_COUNTS_CONFLICT: '覆盖计数冲突',
  MANIFEST_COVERAGE_RATE_CONFLICT: '覆盖率冲突',
  MANIFEST_CRITICAL_FIELD_COVERAGE_BELOW_MINIMUM: '关键字段覆盖低于下限',
  MANIFEST_SUCCESS_RATE_BELOW_MINIMUM: '数据成功率低于下限',
  MANIFEST_SUCCESS_RATE_CONFLICT: '数据成功率冲突',
  MISSING_CANONICAL_COVERAGE_FIELD: '缺少标准覆盖字段',
  MISSING_CRITICAL_FIELD: '缺少关键字段',
  MISSING_POSITIVE_FACTOR_WEIGHT: '缺少正权重因子',
  MISSING_QUALITY_MANIFEST: '缺少质量清单',
  QUALITY_FAILURE_FOR_SYMBOL: '该股票数据质量失败',
  STALE_QUALITY_MANIFEST: '质量清单已过期',
  UNEXPECTED_QUALITY_MANIFEST_SOURCE: '质量清单来源不符',
  UNKNOWN_FACTOR_WEIGHT: '存在未知因子权重',
  UNSUPPORTED_QUALITY_MANIFEST_SCHEMA: '质量清单版本不受支持',
  DUPLICATE_RESOLVED_SNAPSHOT_ID: '解析后快照 ID 重复',
  FUTURE_DECISION_INPUT: '决策输入时间来自未来',
  FUTURE_EVIDENCE_BUNDLE: '证据包时间来自未来',
  INCOHERENT_AS_OF: '决策输入时点不一致',
  INVALID_DECISION_INPUT_TIMESTAMP: '决策输入时间无效',
  INVALID_DECISION_POLICY: '决策政策无效',
  INVALID_EVALUATED_PRICE: '评估价格无效',
  INVALID_EVIDENCE_BUNDLE: '证据包无效',
  INVALID_LONG_TERM_GATE: '长期门槛无效',
  INVALID_PORTFOLIO_CAPACITY: '组合容量无效',
  INVALID_STRUCTURED_UNDERWRITING: '结构化投研无效',
  INVALID_SYMBOL: '股票代码无效',
  INVALID_TIMING_ASSESSMENT: '时机评估无效',
  MISSING_RESOLVED_SNAPSHOT: '缺少可解析快照',
  MISSING_RESOLVED_SNAPSHOT_PAYLOAD: '缺少快照内容',
  MISSING_SNAPSHOT_REFERENCE: '缺少快照引用',
  RESEARCH_BLOCKED: '研究数据被阻断',
  SNAPSHOT_DIGEST_MISMATCH: '快照摘要不匹配',
  SNAPSHOT_IDENTITY_MISMATCH: '快照身份不匹配',
  STALE_DECISION_INPUT: '决策输入已过期',
  STALE_EVIDENCE_BUNDLE: '证据包已过期',
  TIMING_BLOCKED: '时机评估被阻断',
  UNKNOWN_INVALIDATION_STATE: '失效规则状态未知',
}

function display(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function statusLabel(value) {
  if (value === null || value === undefined) return '—'
  return `${STATUS_LABELS[value] ?? value} · ${value}`
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false })
    : '—'
}

function formatMoney(value, currency = 'USD') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatWeight(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(2)}%`
}

function formatRange(range, keys) {
  if (!range) return '—'
  const values = keys.map(key => formatMoney(range[key], range.currency))
  return values.includes('—') ? '—' : values.join(' – ')
}

function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

function CodeList({ values, empty = '—', describe = false }) {
  if (!Array.isArray(values) || values.length === 0) return <span className="unavailable">{empty}</span>
  return (
    <ul className={`code-list${describe ? ' code-list--described' : ''}`}>
      {values.map(value => (
        <li key={value}>
          {describe ? <span>{CODE_LABELS[value] ?? '未收录中文说明'}</span> : null}
          <code>{value}</code>
        </li>
      ))}
    </ul>
  )
}

function codeLabel(code) {
  return code ? `${CODE_LABELS[code] ?? '未收录中文说明'} · ${code}` : '—'
}

function invalidationSummary(rules) {
  if (!Array.isArray(rules)) return '—'
  if (rules.length === 0) return '未记录规则 · 0'
  const triggered = rules.filter(rule => rule.state === 'TRIGGERED').length
  const unknown = rules.filter(rule => rule.state === 'UNKNOWN').length
  if (triggered) return `已触发 ${triggered} / ${rules.length} · TRIGGERED`
  if (unknown) return `未知 ${unknown} / ${rules.length} · UNKNOWN`
  return `未触发 ${rules.length} / ${rules.length} · UNTRIGGERED`
}

function Metric({ label, value, note }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{display(value)}</dd>
      {note ? <span>{note}</span> : null}
    </div>
  )
}

function SnapshotRef({ label, value }) {
  if (!value) {
    return (
      <div className="provenance-item">
        <dt>{label}</dt>
        <dd className="unavailable">—</dd>
      </div>
    )
  }
  return (
    <div className="provenance-item">
      <dt>{label}</dt>
      <dd>
        <span><b>ID</b><code>{value.id}</code></span>
        <span><b>Version</b><code>{value.version}</code></span>
        <span><b>Digest</b><code>{value.digest}</code></span>
      </dd>
    </div>
  )
}

function CandidateStatus({ record }) {
  return (
    <div className="status-stack">
      <Badge tone={`action-${record.action.code.toLowerCase().replace('_', '-')}`}>
        {record.action.label} · {record.action.code}
      </Badge>
      {record.blocked ? <Badge tone="blocked">评估阻断 · EVALUATION_BLOCKED</Badge> : null}
      {record.holdingRisk !== 'NONE' ? <Badge tone="risk">{statusLabel(record.holdingRisk)}</Badge> : null}
    </div>
  )
}

function DetailMemo({ record, onClose, panelRef }) {
  const valuation = record.underwriting?.valuationRange
  const entry = record.underwriting?.entryRange
  const capacity = record.capacitySummary
  const sizing = record.positionSizing
  const rules = record.underwriting?.invalidationRules ?? []
  const provenance = record.provenance

  return (
    <aside
      id="case-memo"
      className={`case-memo${record.blocked ? ' case-memo--blocked' : ''}`}
      aria-labelledby="case-title"
      tabIndex="-1"
      ref={panelRef}
    >
      <div className="memo-header">
        <div>
          <p className="eyebrow">候选决策记录 · DecisionRecordV2</p>
          <h2 id="case-title">{record.symbol}</h2>
          <p className="memo-time">决策时间 {formatDate(record.decidedAt)}</p>
        </div>
        <button className="text-button memo-close" type="button" onClick={onClose} aria-label={`关闭 ${record.symbol} 详情`}>
          关闭
        </button>
      </div>

      <section className="memo-verdict" aria-labelledby="verdict-title">
        <div>
          <h3 id="verdict-title">结论</h3>
          <CandidateStatus record={record} />
        </div>
        <dl className="verdict-meta">
          <Metric label="入场状态" value={statusLabel(record.entryStatus)} />
          <Metric label="持仓风险" value={statusLabel(record.holdingRisk)} />
        </dl>
      </section>

      <section className="memo-section" aria-labelledby="price-title">
        <div className="section-heading">
          <p className="section-index">01</p>
          <h3 id="price-title">价格与估值边界</h3>
        </div>
        <dl className="metric-grid metric-grid--three">
          <Metric
            label="评估价格"
            value={formatMoney(record.evaluatedPrice?.value, record.evaluatedPrice?.currency)}
            note={record.evaluatedPrice ? `as of ${formatDate(record.evaluatedPrice.asOf)}` : null}
          />
          <Metric
            label="估值区间（低 / 基准 / 高）"
            value={formatRange(valuation, ['low', 'base', 'high'])}
            note={valuation ? `${valuation.method} · ${valuation.uncertainty} · as of ${formatDate(valuation.asOf)}` : null}
          />
          <Metric
            label="入场区间"
            value={formatRange(entry, ['lower', 'upper'])}
            note={entry ? `安全边际 ${formatWeight(entry.marginOfSafety)} · as of ${formatDate(entry.asOf)}` : null}
          />
        </dl>
      </section>

      <section className="memo-section" aria-labelledby="position-title">
        <div className="section-heading">
          <p className="section-index">02</p>
          <h3 id="position-title">仓位与组合容量</h3>
        </div>
        <p className="section-note">均为净清算价值（NLV）权重；缺值不视为 0。</p>
        <dl className="metric-grid">
          <Metric label="当前仓位" value={formatWeight(capacity?.currentPosition?.weight)} />
          <Metric label="目标总仓位" value={formatWeight(sizing?.targetPosition)} />
          <Metric label="可增持容量" value={formatWeight(sizing?.additionalCapacity)} />
          <Metric label="有效上限" value={formatWeight(capacity?.effectiveLimit)} />
          <Metric label="距上限剩余" value={formatWeight(capacity?.capacityToLimit)} />
        </dl>
      </section>

      <section className="memo-section" aria-labelledby="spine-title">
        <div className="section-heading">
          <p className="section-index">03</p>
          <h3 id="spine-title">决策主干</h3>
        </div>
        <ol className="decision-spine">
          <li><span>数据完整性</span><strong>{statusLabel(record.dataStatus)}</strong></li>
          <li><span>长期门槛</span><strong>{statusLabel(record.underwriting?.longTermGate)}</strong></li>
          <li><span>判断失效状态</span><strong>{invalidationSummary(record.underwriting?.invalidationRules)}</strong></li>
          <li><span>估值 / 入场区间</span><strong>{valuation && entry ? '已记录' : '—'}</strong></li>
          <li>
            <span>时机评估</span>
            <strong>
              {statusLabel(record.timingAssessment?.status)}
              {record.timingAssessment?.asOf ? <small>as of {formatDate(record.timingAssessment.asOf)}</small> : null}
            </strong>
          </li>
          <li><span>组合容量</span><strong>{capacity ? '已记录' : '—'}</strong></li>
          <li><span>入场结论</span><strong>{statusLabel(record.entryStatus)}</strong></li>
          <li><span>供审阅动作</span><strong>{record.action.label} · {record.action.code}</strong></li>
        </ol>
      </section>

      <section className="memo-section" aria-labelledby="rules-title">
        <div className="section-heading">
          <p className="section-index">04</p>
          <h3 id="rules-title">判断失效条件</h3>
        </div>
        <p className="disclosure">条件摘要未随记录提供；此处仅显示规则 ID、严重度、状态与证据引用，不重建私有判断条件。</p>
        {rules.length ? (
          <ul className="rule-list">
            {rules.map(rule => (
              <li key={rule.id}>
                <code>{rule.id}</code>
                <div>
                  <Badge tone={rule.state === 'TRIGGERED' ? 'blocked' : 'neutral'}>{statusLabel(rule.state)}</Badge>
                  <Badge tone={rule.severity === 'EXIT_REVIEW' ? 'risk' : 'neutral'}>{statusLabel(rule.severity)}</Badge>
                </div>
                <CodeList values={rule.evidenceIds} empty="无证据引用" />
              </li>
            ))}
          </ul>
        ) : <p className="unavailable">—</p>}
      </section>

      <section className="memo-section codes-section" aria-labelledby="codes-title">
        <div className="section-heading">
          <p className="section-index">05</p>
          <h3 id="codes-title">理由、阻断与证据</h3>
        </div>
        <div className="code-columns">
          <div><h4>决策理由</h4><CodeList values={record.reasonCodes} describe /></div>
          <div><h4>阻断原因</h4><CodeList values={record.blockerCodes} describe /></div>
          <div><h4>时机原因</h4><CodeList values={record.timingAssessment?.reasonCodes} describe /></div>
          <div><h4>证据引用</h4><CodeList values={provenance.evidence.refs} /></div>
        </div>
      </section>

      <details className="memo-section provenance">
        <summary>内容寻址与来源引用</summary>
        <p className="disclosure">以下仅是不透明引用和摘要；界面不解析、回填或发送对应的私有输入。</p>
        <dl className="provenance-list">
          {Object.entries(PROVENANCE_LABELS).map(([key, label]) => (
            <SnapshotRef key={key} label={label} value={provenance[key]} />
          ))}
          <div className="provenance-item">
            <dt>当前价来源</dt>
            <dd><code>{display(record.evaluatedPrice?.source)}</code></dd>
          </div>
          <div className="provenance-item">
            <dt>当前仓位引用</dt>
            <dd><code>{display(capacity?.currentPosition?.positionRef)}</code></dd>
          </div>
          <div className="provenance-item">
            <dt>证据摘要</dt>
            <dd><code>{display(provenance.evidence.digest)}</code></dd>
          </div>
          <div className="provenance-item">
            <dt>容量摘要</dt>
            <dd className="digest-stack">
              <span><b>Capacity</b><code>{display(provenance.capacityDigests?.capacity)}</code></span>
              <span><b>Portfolio</b><code>{display(provenance.capacityDigests?.portfolio)}</code></span>
              <span><b>Policy</b><code>{display(provenance.capacityDigests?.capacityPolicy)}</code></span>
            </dd>
          </div>
        </dl>
      </details>
    </aside>
  )
}

function CandidateTable({ records, selectedSymbol, onSelect }) {
  return (
    <div className="table-shell">
      <table className="candidate-table">
        <caption>候选股决策队列，按复核优先级与代码稳定排序</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="other">代码 / 优先级</th>
            <th scope="col">动作</th>
            <th scope="col">当前价</th>
            <th scope="col">入场区间</th>
            <th scope="col">当前 → 目标</th>
            <th scope="col">时机</th>
            <th scope="col">首要原因</th>
            <th scope="col"><span className="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {records.map(record => (
            <tr key={record.symbol} className={record.blocked ? 'is-blocked' : ''} aria-current={selectedSymbol === record.symbol ? 'true' : undefined}>
              <td>
                <strong className="symbol">{record.symbol}</strong>
                {record.blocked ? <span className="blocked-line">评估阻断</span> : null}
                {record.holdingRisk !== 'NONE' ? <span className="risk-line">{STATUS_LABELS[record.holdingRisk]}</span> : null}
              </td>
              <td><CandidateStatus record={record} /></td>
              <td className="numeric">{formatMoney(record.evaluatedPrice?.value, record.evaluatedPrice?.currency)}</td>
              <td className="numeric">{formatRange(record.underwriting?.entryRange, ['lower', 'upper'])}</td>
              <td className="numeric">{formatWeight(record.capacitySummary?.currentPosition?.weight)} → {formatWeight(record.positionSizing?.targetPosition)}</td>
              <td>{statusLabel(record.timingAssessment?.status)}</td>
              <td className="reason-cell">{codeLabel(record.reasonCodes[0] ?? record.blockerCodes[0])}</td>
              <td>
                <button
                  type="button"
                  className="detail-button"
                  aria-expanded={selectedSymbol === record.symbol}
                  aria-controls="case-memo"
                  onClick={event => onSelect(record.symbol, event.currentTarget)}
                >
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CandidateCards({ records, selectedSymbol, onSelect }) {
  return (
    <ul className="candidate-cards" aria-label="候选股决策队列">
      {records.map(record => (
        <li key={record.symbol} className={record.blocked ? 'is-blocked' : ''}>
          <div className="card-head">
            <strong className="symbol">{record.symbol}</strong>
            <CandidateStatus record={record} />
          </div>
          <dl className="card-metrics">
            <Metric label="当前价" value={formatMoney(record.evaluatedPrice?.value, record.evaluatedPrice?.currency)} />
            <Metric label="入场区间" value={formatRange(record.underwriting?.entryRange, ['lower', 'upper'])} />
            <Metric label="当前 → 目标" value={`${formatWeight(record.capacitySummary?.currentPosition?.weight)} → ${formatWeight(record.positionSizing?.targetPosition)}`} />
            <Metric label="时机" value={statusLabel(record.timingAssessment?.status)} />
            <Metric label="首要原因" value={codeLabel(record.reasonCodes[0] ?? record.blockerCodes[0])} />
          </dl>
          <button
            type="button"
            className="detail-button detail-button--full"
            aria-expanded={selectedSymbol === record.symbol}
            aria-controls="case-memo"
            onClick={event => onSelect(record.symbol, event.currentTarget)}
          >
            查看 {record.symbol} 详情
          </button>
        </li>
      ))}
    </ul>
  )
}

function App() {
  const [session, setSession] = useState(null)
  const [query, setQuery] = useState('')
  const [actionFilters, setActionFilters] = useState([])
  const [dataStatus, setDataStatus] = useState('')
  const [timingStatus, setTimingStatus] = useState('')
  const [holdingRisk, setHoldingRisk] = useState('')
  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [importState, setImportState] = useState('idle')
  const [importError, setImportError] = useState('')
  const [announcement, setAnnouncement] = useState('尚未导入决策记录。')
  const panelRef = useRef(null)
  const returnFocusRef = useRef(null)
  const focusDetailRef = useRef(false)
  const importGenerationRef = useRef(0)

  const filteredRecords = useMemo(() => {
    if (!session) return []
    return filterDecisionRecords(session.records, {
      query,
      actions: actionFilters.length ? actionFilters : undefined,
      dataStatuses: dataStatus ? [dataStatus] : undefined,
      timingStatuses: timingStatus ? [timingStatus] : undefined,
      holdingRisks: holdingRisk ? [holdingRisk] : undefined,
    })
  }, [session, query, actionFilters, dataStatus, timingStatus, holdingRisk])

  const selectedRecord = filteredRecords.find(record => record.symbol === selectedSymbol) ?? null

  useEffect(() => {
    if (selectedRecord && focusDetailRef.current) {
      focusDetailRef.current = false
      panelRef.current?.focus()
    }
  }, [selectedRecord])

  useEffect(() => {
    if (!selectedRecord) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        setSelectedSymbol(null)
        const target = returnFocusRef.current
        returnFocusRef.current = null
        requestAnimationFrame(() => {
          if (target?.isConnected) target.focus()
        })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedRecord])

  useEffect(() => {
    if (!selectedSymbol || !session || selectedRecord) return
    setSelectedSymbol(null)
    focusDetailRef.current = false
    const target = returnFocusRef.current
    returnFocusRef.current = null
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus()
    })
  }, [selectedRecord, selectedSymbol, session])

  useEffect(() => {
    if (!session) return
    setAnnouncement(`当前筛选显示 ${filteredRecords.length} 条，共 ${session.summary.total} 条。`)
  }, [filteredRecords.length, session])

  const resetFilters = () => {
    setQuery('')
    setActionFilters([])
    setDataStatus('')
    setTimingStatus('')
    setHoldingRisk('')
  }

  const importFile = async event => {
    const file = event.target.files?.[0]
    if (!file) return
    const input = event.currentTarget
    const generation = importGenerationRef.current + 1
    importGenerationRef.current = generation
    setImportState('reading')
    setImportError('')
    setAnnouncement(`正在本机内存中读取 ${file.name}。`)
    try {
      const text = await file.text()
      if (generation !== importGenerationRef.current) return
      const next = parseDecisionRecordBatch(text, { fileName: file.name })
      if (generation !== importGenerationRef.current) return
      setSession(next)
      resetFilters()
      setSelectedSymbol(next.records[0]?.symbol ?? null)
      returnFocusRef.current = null
      setImportState('ready')
      setAnnouncement(`已导入 ${next.summary.total} 条决策记录。`)
    } catch {
      if (generation !== importGenerationRef.current) return
      setImportState(session ? 'ready' : 'idle')
      setImportError(session
        ? '新文件未通过 DecisionRecordV2 批次校验；已保留当前内存会话。'
        : '文件未通过 DecisionRecordV2 批次校验；未建立内存会话。')
      setAnnouncement(session
        ? '导入失败；当前会话未替换。'
        : '导入失败；未建立会话。')
    } finally {
      input.value = ''
    }
  }

  const clearSession = () => {
    importGenerationRef.current += 1
    setSession(null)
    setSelectedSymbol(null)
    setImportState('idle')
    setImportError('')
    resetFilters()
    setAnnouncement('已清除内存中的决策会话。')
  }

  const toggleAction = code => {
    setActionFilters(current => current.includes(code)
      ? current.filter(value => value !== code)
      : [...current, code])
  }

  const openDetails = (symbol, button) => {
    setSelectedSymbol(symbol)
    returnFocusRef.current = button
    focusDetailRef.current = true
  }

  const closeDetails = () => {
    setSelectedSymbol(null)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus()
    })
  }

  return (
    <div className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">FactorPicks · Decision Workbench</p>
          <h1>开仓与增持决策台</h1>
          <p className="lede">在五分钟内审阅已生成的结论、价格边界、仓位上限与判断失效状态。</p>
        </div>
        <ul className="trust-list" aria-label="工作台边界">
          <li>只在本机内存</li>
          <li>只读审阅</li>
          <li>无下单能力</li>
        </ul>
      </header>

      <main>
        <section className="import-panel" aria-labelledby="import-title">
          <div className="import-copy">
            <p className="section-index">LOCAL / 01</p>
            <h2 id="import-title">导入决策批次</h2>
            <p id="import-help">仅接受工作台生成的非空 <code>DecisionRecordV2[]</code> JSON。文件在本机读取一次，通过原子校验后只保留允许字段的内存投影；刷新页面即清空。</p>
          </div>
          <div className="import-actions">
            <label className={`file-control${importState === 'reading' ? ' is-reading' : ''}`}>
              <span>{session ? '替换 JSON 批次' : '选择 JSON 批次'}</span>
              <input
                type="file"
                accept=".json,application/json"
                aria-describedby="import-help"
                disabled={importState === 'reading'}
                onChange={importFile}
              />
            </label>
            {session ? (
              <button className="text-button" type="button" disabled={importState === 'reading'} onClick={clearSession}>
                清除会话
              </button>
            ) : null}
          </div>
          {importError ? <p className="import-error" role="alert">{importError}</p> : null}
        </section>

        {session ? (
          <>
            <section className="session-strip" aria-labelledby="session-title">
              <div>
                <p className="eyebrow" id="session-title">当前内存会话</p>
                <strong>{session.fileName ?? '未命名 JSON'}</strong>
              </div>
              <dl>
                <Metric label="记录数" value={session.summary.total} />
                <Metric label="最早决策" value={formatDate(session.summary.decidedAt.earliest)} />
                <Metric label="最晚决策" value={formatDate(session.summary.decidedAt.latest)} />
              </dl>
            </section>

            <section className="triage-panel" aria-labelledby="triage-title">
              <div className="section-heading section-heading--major">
                <p className="section-index">REVIEW / 02</p>
                <h2 id="triage-title">候选分流</h2>
              </div>
              <div className="counter-grid" aria-label="按动作与阻断状态筛选">
                {ACTIONS.map(action => (
                  <button
                    key={action.code}
                    type="button"
                    className={`counter counter--${action.code.toLowerCase().replace('_', '-')}`}
                    aria-pressed={actionFilters.includes(action.code)}
                    onClick={() => toggleAction(action.code)}
                  >
                    <span>{action.label}</span>
                    <strong>{session.summary.byAction[action.code]}</strong>
                    <code>{action.code}</code>
                  </button>
                ))}
                <button
                  type="button"
                  className="counter counter--blocked"
                  aria-pressed={dataStatus === 'EVALUATION_BLOCKED'}
                  onClick={() => setDataStatus(current => current === 'EVALUATION_BLOCKED' ? '' : 'EVALUATION_BLOCKED')}
                >
                  <span>评估阻断</span>
                  <strong>{session.summary.byStatus.EVALUATION_BLOCKED}</strong>
                  <code>EVALUATION_BLOCKED</code>
                </button>
              </div>

              <div className="filter-bar">
                <label className="search-field">
                  <span>搜索股票代码</span>
                  <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 AAPL" autoComplete="off" />
                </label>
                <label>
                  <span>数据状态</span>
                  <select value={dataStatus} onChange={event => setDataStatus(event.target.value)}>
                    <option value="">全部</option>
                    <option value="VALID">数据有效 · VALID</option>
                    <option value="EVALUATION_BLOCKED">评估阻断 · EVALUATION_BLOCKED</option>
                  </select>
                </label>
                <label>
                  <span>时机状态</span>
                  <select value={timingStatus} onChange={event => setTimingStatus(event.target.value)}>
                    <option value="">全部</option>
                    <option value="PASS">通过 · PASS</option>
                    <option value="EVENT_RISK">事件风险 · EVENT_RISK</option>
                    <option value="FAIL">未通过 · FAIL</option>
                  </select>
                </label>
                <label>
                  <span>持仓风险</span>
                  <select value={holdingRisk} onChange={event => setHoldingRisk(event.target.value)}>
                    <option value="">全部</option>
                    <option value="NONE">无 · NONE</option>
                    <option value="REVIEW">复核 · REVIEW</option>
                    <option value="EXIT_REVIEW">退出复核 · EXIT_REVIEW</option>
                    <option value="REDUCE_REVIEW">减仓复核 · REDUCE_REVIEW</option>
                  </select>
                </label>
                <button className="text-button filter-reset" type="button" onClick={resetFilters}>清除筛选</button>
              </div>
            </section>

            <div className={`workbench-grid${selectedRecord ? '' : ' workbench-grid--queue-only'}`}>
              <section className="candidate-queue" aria-labelledby="queue-title">
                <div className="queue-heading">
                  <div>
                    <p className="section-index">QUEUE / 03</p>
                    <h2 id="queue-title">决策队列</h2>
                  </div>
                  <p><strong>{filteredRecords.length}</strong> / {session.summary.total} 条</p>
                </div>
                {filteredRecords.length ? (
                  <>
                    <CandidateTable records={filteredRecords} selectedSymbol={selectedSymbol} onSelect={openDetails} />
                    <CandidateCards records={filteredRecords} selectedSymbol={selectedSymbol} onSelect={openDetails} />
                  </>
                ) : (
                  <div className="filter-empty">
                    <h3>当前筛选无记录</h3>
                    <p>调整状态、动作或股票代码；原始内存会话仍保留。</p>
                  </div>
                )}
              </section>
              {selectedRecord ? <DetailMemo record={selectedRecord} onClose={closeDetails} panelRef={panelRef} /> : (
                <aside className="memo-placeholder" aria-label="决策详情未打开">
                  <p className="section-index">MEMO / 04</p>
                  <h2>投委会工作纸</h2>
                  <p>从队列中选择“详情”，检查结论、价格边界、仓位容量、决策主干和判断失效状态。</p>
                </aside>
              )}
            </div>
          </>
        ) : (
          <section className="empty-state" aria-labelledby="empty-title">
            <p className="section-index">EMPTY / 02</p>
            <h2 id="empty-title">等待一份可审阅的决策批次</h2>
            <p>请先在本地无头工作台生成批量决策记录，再导入本页。本页不读取私有 case、Robinhood 原始响应或公开排名数据，也不重新计算动作。</p>
            <div className="empty-contract">
              <span>输入</span><code>DecisionRecordV2[]</code>
              <span>会话</span><code>React memory only</code>
              <span>输出</span><code>Read-only review</code>
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <p>人工决策支持，不构成投资建议，不代表委托或成交。</p>
        <a href="https://github.com/BrickerP/FactorPicks" target="_blank" rel="noreferrer noopener">源码</a>
      </footer>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  )
}

export default App
