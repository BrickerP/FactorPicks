import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createServer } from 'vite'

import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import { decisionInput } from './fixtures/decision-v2-fixture.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let App
let vite
let keydownListeners
let fetchRequests

const PUBLIC_TIME = '2026-08-13T08:00:00.000Z'

function publicArtifacts(rows = {
  AAA: {
    name: 'Alpha', sector: '0', industry: '10', Close: 100, currency: 'USD',
    asOf: '2026-08-13T07:59:00.123456789Z', observedAt: PUBLIC_TIME,
    'Market Cap': 1_000_000, 'P/E': 20, PEG: 1.5, ROE: 0.2,
    'Debt/Eq': 0.1, 'FCFF/EV': 0.05,
  },
  BBB: {
    name: 'Beta', sector: '2', industry: '20', Close: 25, currency: 'USD',
    asOf: '2026-08-13T07:59:00.123456789Z', observedAt: PUBLIC_TIME,
    'Market Cap': '-', 'P/E': 12, PEG: '-', ROE: 0.1,
    'Debt/Eq': 0.4, 'FCFF/EV': 0.03,
  },
}) {
  const raw = JSON.stringify(rows)
  const fields = ['Close', 'name', 'sector', 'industry', 'Market Cap', 'P/E', 'PEG', 'ROE', 'Debt/Eq', 'FCFF/EV']
  const succeeded = Object.keys(rows).length
  const coverage = Object.fromEntries(fields.map(field => {
    const available = Object.values(rows).filter(row => row[field] !== '-').length
    return [field, { available, total: succeeded, rate: available / succeeded }]
  }))
  return {
    raw,
    quality: {
      schemaVersion: 1, generatedAt: PUBLIC_TIME, source: 'yfinance',
      requested: succeeded, succeeded, failed: 0, successRate: 1,
      coverage, failedSymbols: [],
      statArtifact: {
        sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(raw, 'utf8'), symbols: succeeded,
      },
    },
  }
}

function installPublicFetch(artifacts = publicArtifacts()) {
  fetchRequests = []
  globalThis.fetch = async url => {
    fetchRequests.push(String(url))
    if (String(url).endsWith('stat.json')) {
      return { ok: true, text: async () => artifacts.raw }
    }
    if (String(url).endsWith('data-quality.json')) {
      return { ok: true, json: async () => artifacts.quality }
    }
    return { ok: false, status: 404 }
  }
}

before(async () => {
  vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  ;({ default: App } = await vite.ssrLoadModule('/src/App.jsx'))
})

after(async () => {
  await vite?.close()
})

beforeEach(() => {
  installPublicFetch()
  keydownListeners = new Set()
  globalThis.document = {
    addEventListener(type, listener) {
      if (type === 'keydown') keydownListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'keydown') keydownListeners.delete(listener)
    },
  }
  globalThis.requestAnimationFrame = callback => {
    callback()
    return 1
  }
})

function record(symbol = 'AAA', overrides = {}) {
  return { ...evaluateDecision(decisionInput(overrides)), symbol }
}

function blockedRecord(symbol = 'BLOCK') {
  return record(symbol, {
    portfolioCapacity: { currentPosition: { weight: undefined } },
  })
}

function input(root, type) {
  return root.findAllByType('input').find(node => node.props.type === type)
}

function button(root, label) {
  return root.findAllByType('button').find(node =>
    node.props['aria-label'] === label || node.children.join('') === label)
}

function rendered(renderer) {
  return JSON.stringify(renderer.toJSON())
}

function fileEvent(name, text) {
  const target = { files: [{ name, text: async () => text }], value: 'selected' }
  return { target, currentTarget: target }
}

async function importRecords(renderer, records, name = 'decisions.json') {
  const event = fileEvent(name, JSON.stringify(records))
  await act(async () => {
    await input(renderer.root, 'file').props.onChange(event)
  })
  assert.equal(event.currentTarget.value, '')
}

function createApp() {
  let renderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(App), {
      createNodeMock: element => ({
        isConnected: true,
        focusCalls: 0,
        focus() { this.focusCalls += 1 },
        element,
      }),
    })
  })
  return renderer
}

async function createLoadedApp() {
  const renderer = createApp()
  for (let attempt = 0; attempt < 10 && rendered(renderer).includes('正在加载公开研究'); attempt += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
  }
  return renderer
}

test('loads both same-origin public artifacts and shows candidates without private actions', async t => {
  const renderer = await createLoadedApp()
  t.after(() => act(() => renderer.unmount()))

  assert.deepEqual(fetchRequests, ['./stat.json', './data-quality.json'])
  const output = rendered(renderer)
  assert.match(output, /AAA/)
  assert.match(output, /BBB/)
  assert.match(output, /尚未形成私人决策/)
  assert.doesNotMatch(output, /开仓 · OPEN/)
})

test('overlays matching decisions and keeps private-only symbols in stable ASCII order', async t => {
  const renderer = await createLoadedApp()
  t.after(() => act(() => renderer.unmount()))

  await importRecords(renderer, [record('BBB'), record('CCC')])

  const output = rendered(renderer)
  assert.match(output, /CCC/)
  assert.match(output, /BBB/)
  assert.match(output, /开仓[^}]*OPEN/)
  assert.match(output, /AAA/)
  const symbols = renderer.root.findAll(node => node.props.className === 'symbol')
    .map(node => node.children.join(''))
  assert.deepEqual([...new Set(symbols)], ['AAA', 'BBB', 'CCC'])
})

test('keeps private import usable when public artifact integrity fails', async t => {
  const artifacts = publicArtifacts()
  artifacts.quality.statArtifact.sha256 = '0'.repeat(64)
  installPublicFetch(artifacts)
  const renderer = await createLoadedApp()
  t.after(() => act(() => renderer.unmount()))

  assert.match(rendered(renderer), /公开研究加载失败/)
  assert.equal(input(renderer.root, 'file').props.disabled, false)
  await importRecords(renderer, [record('PRIVATE')])
  assert.match(rendered(renderer), /PRIVATE/)
})

test('imports a File API batch and opens the first projected decision', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))

  await importRecords(renderer, [record('AAA')], 'committee.json')

  const output = rendered(renderer)
  assert.match(output, /committee\.json/)
  assert.match(output, /"id":"case-memo"/)
  assert.match(output, /AAA/)
})

test('keeps the current session when a replacement file is invalid', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('AAA')], 'current.json')

  const event = fileEvent('broken.json', '{')
  await act(async () => {
    await input(renderer.root, 'file').props.onChange(event)
  })

  const output = rendered(renderer)
  assert.match(output, /current\.json/)
  assert.match(output, /已保留当前内存会话/)
  assert.doesNotMatch(output, /broken\.json/)
})

test('clears the imported session and its selected detail', async t => {
  const renderer = await createLoadedApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('BBB'), record('CCC')], 'private.json')

  const importedSymbols = renderer.root.findAll(node => node.props.className === 'symbol')
    .map(node => node.children.join(''))
  assert.deepEqual([...new Set(importedSymbols)], ['AAA', 'BBB', 'CCC'])
  assert.match(rendered(renderer), /开仓[^}]*OPEN/)

  act(() => button(renderer.root, '清除会话').props.onClick())

  const output = rendered(renderer)
  const clearedSymbols = renderer.root.findAll(node => node.props.className === 'symbol')
    .map(node => node.children.join(''))
  assert.match(output, /公开研究候选/)
  assert.deepEqual([...new Set(clearedSymbols)], ['AAA', 'BBB'])
  assert.match(output, /尚未形成私人决策/)
  assert.doesNotMatch(output, /CCC/)
  assert.doesNotMatch(output, /private\.json/)
  assert.doesNotMatch(output, /"id":"case-memo"/)
})

test('drops private memory on remount and refetches the exact public pair once per mount', async () => {
  const first = await createLoadedApp()
  await importRecords(first, [record('PRIVATE')], 'ephemeral.json')
  assert.match(rendered(first), /PRIVATE/)
  act(() => first.unmount())

  const second = await createLoadedApp()
  assert.doesNotMatch(rendered(second), /ephemeral\.json|查看 PRIVATE 详情/)
  assert.match(rendered(second), /AAA/)
  assert.match(rendered(second), /BBB/)
  assert.deepEqual(fetchRequests, [
    './stat.json', './data-quality.json',
    './stat.json', './data-quality.json',
  ])
  act(() => second.unmount())
})

test('keeps private input out of storage, network, and execution affordances', async t => {
  const renderer = await createLoadedApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('PRIVATE')], 'private-payload.json')

  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/)
  assert.equal((source.match(/\bfetch\s*\(/g) ?? []).length, 2)
  assert.deepEqual(fetchRequests, ['./stat.json', './data-quality.json'])
  assert.ok(fetchRequests.every(url => !url.includes('PRIVATE') && !url.includes('private-payload')))
  const affordances = renderer.root.findAllByType('button')
    .map(node => node.children.join(''))
    .join(' ')
  assert.doesNotMatch(affordances, /(?:下单|买入|卖出|提交订单|place order|broker)/i)
})

test('ignores an older File promise after a newer import starts', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))
  let resolveOld
  const oldText = new Promise(resolve => { resolveOld = resolve })
  const oldTarget = {
    files: [{ name: 'old.json', text: () => oldText }],
    value: 'old',
  }
  let oldImport
  act(() => {
    oldImport = input(renderer.root, 'file').props.onChange({
      target: oldTarget,
      currentTarget: oldTarget,
    })
  })

  const currentEvent = fileEvent('current.json', JSON.stringify([record('CURRENT')]))
  await act(async () => {
    await input(renderer.root, 'file').props.onChange(currentEvent)
  })
  await act(async () => {
    resolveOld(JSON.stringify([record('OLD')]))
    await oldImport
  })

  const output = rendered(renderer)
  assert.match(output, /current\.json/)
  assert.match(output, /CURRENT/)
  assert.doesNotMatch(output, /old\.json/)
})

test('does not reopen a selected detail after filtering it out and clearing filters', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('AAA'), record('BBB')])

  const bbbDetail = renderer.root.findAllByType('button')
    .find(node => node.children.join('') === '查看 BBB 详情')
  act(() => bbbDetail.props.onClick({ currentTarget: { isConnected: true, focus() {} } }))
  const memo = renderer.root.findByProps({ id: 'case-memo' })
  assert.ok(memo.findAllByProps({ id: 'case-title' })
    .some(node => node.children.join('') === 'BBB'))

  act(() => input(renderer.root, 'search').props.onChange({ target: { value: 'AAA' } }))
  assert.doesNotMatch(rendered(renderer), /"id":"case-memo"/)
  act(() => button(renderer.root, '清除筛选').props.onClick())

  assert.doesNotMatch(rendered(renderer), /"id":"case-memo"/)
})

test('returns focus to the detail trigger after close and Escape', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('AAA')])
  const trigger = { isConnected: true, focusCalls: 0, focus() { this.focusCalls += 1 } }
  const detailButton = renderer.root.findAllByType('button')
    .find(node => node.children.join('') === '查看 AAA 详情')

  act(() => detailButton.props.onClick({ currentTarget: trigger }))
  act(() => button(renderer.root, '关闭 AAA 详情').props.onClick())
  assert.equal(trigger.focusCalls, 1)

  act(() => detailButton.props.onClick({ currentTarget: trigger }))
  act(() => {
    for (const listener of keydownListeners) listener({ key: 'Escape' })
  })
  assert.equal(trigger.focusCalls, 2)
  assert.doesNotMatch(rendered(renderer), /"id":"case-memo"/)
})

test('renders evaluation blocked as a distinct status from no action', async t => {
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))

  await importRecords(renderer, [blockedRecord()])

  const output = rendered(renderer)
  assert.match(output, /评估阻断/)
  assert.match(output, /EVALUATION_BLOCKED/)
  assert.match(output, /不操作/)
})
