import type { Cache } from '../types'

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

const part = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

/**
 * Reads the end of a session transcript (JSON lines) for its last model request: when it was
 * made, which lifetime its cache writes were given, and how much of its input the cache served.
 */
export const cacheOf = (source: string): Cache | null => {
  let at: number | null = null
  let ttlMinutes: number | null = null
  let hitPercent: number | null = null
  for (const line of source.split('\n')) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (part(entry, 'type') !== 'assistant' || part(entry, 'isSidechain') === true) {
      continue
    }
    const usage = part(part(entry, 'message'), 'usage')
    const stamp = Date.parse(String(part(entry, 'timestamp')))
    if (usage === undefined || Number.isNaN(stamp)) {
      continue
    }
    at = stamp
    const written = part(usage, 'cache_creation')
    if (count(part(written, 'ephemeral_1h_input_tokens')) > 0) {
      ttlMinutes = 60
    } else if (count(part(written, 'ephemeral_5m_input_tokens')) > 0) {
      ttlMinutes = 5
    }
    const served = count(part(usage, 'cache_read_input_tokens'))
    const total =
      served + count(part(usage, 'cache_creation_input_tokens')) + count(part(usage, 'input_tokens'))
    hitPercent = total === 0 ? null : Math.round((served / total) * 100)
  }

  return at === null || ttlMinutes === null ? null : { at, ttlMinutes, hitPercent }
}

/** Minutes left, rounded up, as the band spells them. */
export const leftOf = (ms: number): string => (ms < 60_000 ? '<1m' : `${Math.ceil(ms / 60_000)}m`)
