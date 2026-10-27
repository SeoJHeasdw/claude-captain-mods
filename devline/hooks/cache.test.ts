import { expect, test } from 'claude-code/testing'

import { cacheOf, leftOf } from './cache'

const request = (stamp: string, usage: object, more: object = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: stamp, message: { usage }, ...more })

test('the last request gives the time, and a one-hour write the one-hour life', () => {
  const seen = cacheOf(
    [
      request('2026-10-13T07:00:00.000Z', {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 990,
        cache_creation: { ephemeral_1h_input_tokens: 990, ephemeral_5m_input_tokens: 0 },
      }),
      '{"type":"assistant","timestamp":"2026-10-13T07:30', // a line cut by the tail
      request('2026-10-13T08:00:00.000Z', {
        input_tokens: 4,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 96,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
    ].join('\n'),
  )

  expect(seen).toEqual({ at: Date.parse('2026-10-13T08:00:00.000Z'), ttlMinutes: 60, hitPercent: 90 })
})

test('a five-minute write gives the five-minute life, and a subagent request is not the session\'s', () => {
  const seen = cacheOf(
    [
      request('2026-10-13T08:00:00.000Z', {
        input_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 50 },
      }),
      request(
        '2026-10-13T08:05:00.000Z',
        { input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 9 } },
        { isSidechain: true },
      ),
    ].join('\n'),
  )

  expect(seen).toEqual({ at: Date.parse('2026-10-13T08:00:00.000Z'), ttlMinutes: 5, hitPercent: 0 })
})

test('a transcript with no request yet says nothing', () => {
  expect(cacheOf('{"type":"user","timestamp":"2026-10-13T08:00:00.000Z"}')).toBeNull()
})

test('time left is spelled in whole minutes, rounded up', () => {
  expect(leftOf(60 * 60_000)).toBe('60m')
  expect(leftOf(59 * 60_000 + 1)).toBe('60m')
  expect(leftOf(3 * 60_000)).toBe('3m')
  expect(leftOf(40_000)).toBe('<1m')
})
