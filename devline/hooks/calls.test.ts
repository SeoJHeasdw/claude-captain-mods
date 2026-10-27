import { expect, test } from 'claude-code/testing'

import { callsOf } from './calls'

const NOW = 1_000_000_000

test('another session waiting, or just finished, is a call; this one and old news are not', () => {
  const calls = callsOf({
    now: NOW,
    rows: [
      { project: 'money', state: 'waiting', at: NOW - 40_000, isSelf: false },
      { project: 'another', state: 'done', at: NOW - 60_000, isSelf: false },
      { project: 'harbor', state: 'done', at: NOW - 3_600_000, isSelf: false },
      { project: 'edu', state: 'waiting', at: NOW, isSelf: true },
      { project: 'docs', state: 'working', at: NOW, isSelf: false },
    ],
  })

  expect(calls).toEqual([
    { project: 'money', isWaiting: true },
    { project: 'another', isWaiting: false },
  ])
})

test('a board that is absent or of another shape reads as no calls', () => {
  expect(callsOf(undefined)).toEqual([])
  expect(callsOf({ rows: 'nope', now: NOW })).toEqual([])
  expect(callsOf({ rows: [null, 3, { state: 'waiting' }], now: NOW })).toEqual([])
})
