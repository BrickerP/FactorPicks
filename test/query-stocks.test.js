import test from 'node:test'
import assert from 'node:assert/strict'

import { queryStocks } from '../src/lib/queryStocks.js'

const ACTIVE_WEIGHTS = {
  'FCFF/EV_w': 1,
  PEG_w: 1,
  ROE_w: 1,
}

const runQuery = (stat, weights = ACTIVE_WEIGHTS) => queryStocks(stat, {
  data: {
    baseArg: [],
    advArg: [],
    sector_industries: {},
    Factor_Intersectional_v1: { args: weights },
  },
})

function makeStat(count = 10) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const step = index + 1
    return [`S${step}`, {
      'FCFF/EV': 0.05 + step / 100,
      PEG: 1 + step / 10,
      ROE: 0.1 + step / 100,
    }]
  }))
}

function assertFiniteScores(output) {
  assert.ok(output.every(stock => Number.isFinite(stock.multiFactor)))
}

test('excludes stocks missing any positively weighted factor', () => {
  const stat = makeStat()
  stat.BA = { 'FCFF/EV': 0.2, PEG: null, ROE: 0.2 }
  stat.MAS = { 'FCFF/EV': null, PEG: 2, ROE: 0.2 }
  stat.GDDY = { 'FCFF/EV': 0.2, PEG: 2, ROE: 'NaN' }

  const output = runQuery(stat)

  assert.deepEqual(output.map(stock => stock.symbol), Object.keys(makeStat()))
  assertFiniteScores(output)
})

test('does not require a missing factor whose weight is zero', () => {
  const stat = makeStat()
  stat.BA = { 'FCFF/EV': 0.2, PEG: null, ROE: 0.2 }

  const output = runQuery(stat, {
    'FCFF/EV_w': 0,
    PEG_w: 0,
    ROE_w: 1,
  })

  assert.deepEqual(output.map(stock => stock.symbol), [...Object.keys(makeStat()), 'BA'])
  assertFiniteScores(output)
})

test('keeps stocks when every positively weighted factor has finite scores', () => {
  const stat = makeStat()
  const output = runQuery(stat)

  assert.deepEqual(output.map(stock => stock.symbol), Object.keys(stat))
  assertFiniteScores(output)
})

test('excludes every stock when an active factor is constant', () => {
  const stat = makeStat()
  Object.values(stat).forEach(row => { row['FCFF/EV'] = 0.1 })

  assert.deepEqual(runQuery(stat), [])
})

test('excludes every stock when an active factor has fewer than ten samples', () => {
  const stat = makeStat(9)

  assert.deepEqual(runQuery(stat), [])
})
