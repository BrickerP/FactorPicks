import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createServer } from 'vite'

import { evaluateDecision } from '../src/domain/evaluateDecision.js'
import { decisionInput } from './fixtures/decision-v2-fixture.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let App
let vite
let keydownListeners

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
  const renderer = createApp()
  t.after(() => act(() => renderer.unmount()))
  await importRecords(renderer, [record('AAA')])

  act(() => button(renderer.root, '清除会话').props.onClick())

  const output = rendered(renderer)
  assert.match(output, /等待一份可审阅的决策批次/)
  assert.doesNotMatch(output, /"id":"case-memo"/)
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
