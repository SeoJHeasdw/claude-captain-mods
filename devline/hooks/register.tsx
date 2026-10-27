import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Info } from '../types'
import { cacheOf, leftOf } from './cache'
import { callsOf } from './calls'
import { placeOf } from './place'
import type { Call } from './calls'

// Mid-tone hues that hold their contrast on a light and a dark theme alike.
const C = {
  cyan: '#0EA5B7',
  purple: '#A855F7',
  amber: '#D97706',
  green: '#16A34A',
  red: '#DC2626',
  blue: '#3B82F6',
  pink: '#DB2777',
  teal: '#0D9488',
  slate: '#64748B',
} as const

const info = atom({ plugin: 'devline', key: 'info' } as const, null)
const cache = atom({ plugin: 'devline', key: 'cache' } as const, null)
const nowAt = atom({ plugin: 'devline', key: 'nowAt' } as const, 0)
// session-board's own value, read here and never written.
const fleet = { plugin: 'session-board', key: 'board' } as const
const isBandOn = atom({ plugin: 'devline', key: 'isBandOn' } as const, true)
const isRowsOn = atom({ plugin: 'devline', key: 'isRowsOn' } as const, true)

const TICK_MS = 20_000
// Below this share of the last request served from the cache, the band says so.
const MISS_BELOW = 80
const MAX_CALLS = 2
const TAIL_BYTES = 400_000
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

const field = (input: unknown, key: string): string => {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const value = (input as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : ''
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

const tail = (path: string): string => path.split('/').slice(-2).join('/')

const badgeOf = (
  tool: string,
  input: unknown,
): { label: string; color: string; summary: string } => {
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')

    return { label: 'MCP', color: C.teal, summary: `${server} · ${name}` }
  }
  switch (tool) {
    case 'Bash':
      return {
        label: 'SH',
        color: C.green,
        summary: field(input, 'description') || firstLine(field(input, 'command')),
      }
    case 'Read':
      return { label: 'READ', color: C.blue, summary: tail(field(input, 'file_path')) }
    case 'Edit':
    case 'NotebookEdit':
      return { label: 'EDIT', color: C.amber, summary: tail(field(input, 'file_path')) }
    case 'Write':
      return { label: 'WRITE', color: C.amber, summary: tail(field(input, 'file_path')) }
    case 'Grep':
    case 'Glob':
      return { label: 'FIND', color: C.cyan, summary: field(input, 'pattern') }
    case 'Agent':
    case 'Task':
      return { label: 'AGENT', color: C.purple, summary: field(input, 'description') }
    case 'Skill':
      return { label: 'SKILL', color: C.purple, summary: field(input, 'skill') }
    case 'WebFetch':
      return { label: 'WEB', color: C.pink, summary: field(input, 'url') }
    case 'WebSearch':
      return { label: 'WEB', color: C.pink, summary: field(input, 'query') }
    default:
      return { label: tool.toUpperCase().slice(0, 12), color: C.slate, summary: '' }
  }
}

const branchOf = async ($: EngineInterface, cwd: string): Promise<string | null> => {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: 2000,
    })

    return ran.exitCode === 0 ? ran.stdout.trim() || null : null
  } catch {
    return null
  }
}

const dirtyOf = async ($: EngineInterface, cwd: string): Promise<number> => {
  try {
    // Without the optional locks, so a status here never holds up a git command of the person's.
    const ran = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain'], {
      cwd,
      timeoutMs: 3000,
    })

    return ran.exitCode === 0 ? ran.stdout.split('\n').filter(line => line !== '').length : 0
  } catch {
    return 0
  }
}

const refresh = async ($: EngineInterface): Promise<void> => {
  try {
    const cwd = await $.session.cwd()
    const next: Info = {
      ...placeOf(cwd, await branchOf($, cwd)),
      dirty: await dirtyOf($, cwd),
    }
    await update($, info, () => next)
  } catch {
    // The band keeps what it last showed.
  }
}

const tick = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
}

/** The board is another mod's: absent or unreadable, the band draws without its call-outs. */
const readCalls = async ($: EngineInterface): Promise<Call[]> => {
  try {
    return callsOf((await $.state.get(fleet)).value)
  } catch {
    return []
  }
}

/** The band's own beat: the working copy may change between turns, and the cache runs down. */
const beat = async ($: EngineInterface): Promise<void> => {
  await refresh($)
  await tick($)
}

// Module state: where this session's transcript is, found once per load.
let transcript: string | null = null

/**
 * Takes the cache's state from the session's own transcript, where each model request is
 * recorded with its usage. `floor` is a time the last request cannot be older than.
 */
const readCache = async ($: EngineInterface, floor: number): Promise<void> => {
  try {
    const home = await $.env.get('HOME')
    const id = await $.session.id()
    if (home === undefined || !SESSION_ID.test(id)) {
      return
    }
    if (transcript === null) {
      const found = await $.process.run(
        ['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`],
        { timeoutMs: 10_000 },
      )
      transcript = found.stdout.split('\n').find(line => line !== '') ?? null
    }
    if (transcript === null) {
      return
    }
    const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), transcript], {
      timeoutMs: 10_000,
    })
    const seen = cacheOf(ran.stdout)
    if (seen !== null) {
      const next: Cache = { ...seen, at: Math.max(seen.at, floor) }
      await update($, cache, () => next)
    }
  } catch {
    // The band keeps what it last showed.
  }
}

export const register: Register = on => {
  let startedAt = 0
  // The mod is for the desktop app's sessions: in one another client hosts (VS Code, a
  // terminal, a headless run) it registers nothing and draws nothing.
  let isHere = false

  on('session.start', async ($, e, next) => {
    isHere = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    if (!isHere) {
      return next(e)
    }
    await $.command.register({
      name: 'devline',
      description: 'Toggle the status band or the colored tool rows',
      argumentHint: 'band | rows',
    })
    const savedBand = await $.store.get('isBandOn')
    const savedRows = await $.store.get('isRowsOn')
    if (typeof savedBand === 'boolean') {
      await update($, isBandOn, () => savedBand)
    }
    if (typeof savedRows === 'boolean') {
      await update($, isRowsOn, () => savedRows)
    }
    await refresh($)
    await readCache($, 0)
    await tick($)
    $.clock.every(TICK_MS, () => {
      void beat($)
    })

    return next(e)
  })

  on('command.run', { command: 'devline' }, async ($, e) => {
    const what = e.args.trim()
    if (what !== 'band' && what !== 'rows') {
      return { text: 'Usage: /devline band | rows' }
    }
    let isOn = true
    const flip = (was: boolean): boolean => {
      isOn = !was

      return isOn
    }
    if (what === 'band') {
      await update($, isBandOn, flip)
    } else {
      await update($, isRowsOn, flip)
    }
    await $.store.set(what === 'band' ? 'isBandOn' : 'isRowsOn', isOn)

    return { text: `devline ${what}: ${isOn ? 'on' : 'off'}` }
  })

  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!isHere) {
      return next(e)
    }
    await refresh($)
    await readCache($, startedAt)
    await tick($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, info)
    if (!isHere || e.props.hasSurvey || now === null || !(await read($, isBandOn))) {
      return next(e)
    }
    const seen = await read($, cache)
    const at = await read($, nowAt)
    const calls = await readCalls($)
    const { Box, Text } = $.ui.resolve(e)
    // A running turn's requests keep the cache fresh; idle, it runs down from the last one.
    const lifeMs = (seen?.ttlMinutes ?? 0) * 60_000
    const leftMs = seen === null || e.props.isWorking ? lifeMs : lifeMs - Math.max(0, at - seen.at)
    const hit = seen?.hitPercent ?? null

    return (
      <Box columnGap="md" flexWrap="wrap">
        {/* The bar is a block glyph: only a monospaced face draws it a cell tall. */}
        <Box>
          <Text color={C.cyan} mono>
            ▍
          </Text>
          <Text color={C.cyan} weight="semibold">
            {now.project}
          </Text>
        </Box>
        {now.branch !== null && (
          <Box columnGap="sm">
            <Text color={C.purple}>⎇ {now.branch}</Text>
            {now.dirty > 0 && (
              <Text color={C.amber} tabular>
                ±{now.dirty}
              </Text>
            )}
          </Box>
        )}
        {/* Digits of one width: the time left runs down without moving what follows it. */}
        {seen !== null &&
          (leftMs > 0 ? (
            <Text color={leftMs <= lifeMs / 12 ? C.amber : C.green} tabular>
              cache {leftOf(leftMs)}
            </Text>
          ) : (
            <Text color={C.red}>cache 만료</Text>
          ))}
        {hit !== null && hit < MISS_BELOW && (
          <Text color={C.amber} tabular>
            cache miss (hit {hit}%)
          </Text>
        )}
        {calls.slice(0, MAX_CALLS).map(call =>
          call.isWaiting ? (
            <Text color={C.amber} weight="semibold">
              ⏸ {call.project} 호출
            </Text>
          ) : (
            <Text dimColor>✓ {call.project} 완료</Text>
          ),
        )}
        {calls.length > MAX_CALLS && <Text dimColor>+{calls.length - MAX_CALLS}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isHere || !(await read($, isRowsOn))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const { tool, input, isRunning, isErrored, isInterrupted } = e.props
    const badge = badgeOf(tool, input)
    const mark = isRunning
      ? { text: '…', color: C.amber }
      : isInterrupted
        ? { text: '⊘', color: C.slate }
        : isErrored
          ? { text: '✗', color: C.red }
          : { text: '✓', color: C.green }

    return (
      <Box>
        {/* The mark holds a column of its own, so the badges of stacked rows line up whatever
            width a face gives each glyph. */}
        <Box width={2} flexShrink={0}>
          <Text color={mark.color} weight="semibold" mono>
            {mark.text}
          </Text>
        </Box>
        <Box columnGap="sm" flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <Text color={badge.color} weight="semibold">
              {badge.label}
            </Text>
          </Box>
          {/* Without a floor of 0 a flex row keeps the summary whole and runs past its edge. */}
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">{badge.summary}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
