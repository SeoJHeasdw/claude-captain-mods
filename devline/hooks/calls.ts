export type Call = { project: string; isWaiting: boolean }

// A session that just finished is called out for this long, then left to the dashboard.
const FRESH_DONE_MS = 5 * 60_000

/**
 * Picks, from the session board's value, the other sessions that want a look: one waiting on
 * the person, or one that finished a moment ago. The value is another plugin's, so its shape
 * is checked, not assumed; anything else reads as no calls.
 */
export const callsOf = (value: unknown): Call[] => {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const { rows, now } = value as { rows?: unknown; now?: unknown }
  if (!Array.isArray(rows) || typeof now !== 'number') {
    return []
  }
  const calls: Call[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue
    }
    const { project, state, at, isSelf } = row as Record<string, unknown>
    if (isSelf === true || typeof project !== 'string') {
      continue
    }
    if (state === 'waiting') {
      calls.push({ project, isWaiting: true })
    } else if (state === 'done' && typeof at === 'number' && now - at <= FRESH_DONE_MS) {
      calls.push({ project, isWaiting: false })
    }
  }

  return calls
}
