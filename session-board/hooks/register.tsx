import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Pending, Row, RowState } from '../types'
import {
  LEDGER_LINES,
  ago,
  findHome,
  folderIn,
  homeAmong,
  homeOf,
  isAsking,
  ledgerOf,
  linkRows,
  order,
  pendingOf,
  pendingShell,
  readTail,
  rowOf,
  stateOf,
  tailAt,
} from './parse'
import type { Home, Ledger, Tail } from './parse'

const PANE = 'board'
const TITLE = '대장님 대시보드'
const SCAN_MS = 5000
// The board lists the sessions last spoken to most recently, this many of them, and beyond
// them any other still at work or with a finish not yet seen.
const MAX_ROWS = 10
// Transcripts untouched for longer than this are not looked at, nor more than this many: the
// app touches a transcript whenever its session is opened, so a file's date ranks it poorly.
const WINDOW_MINUTES = 7 * 24 * 60
const MAX_FILES = 24
// Where a copy of this mod claims a finished session before announcing it, so that several
// sessions running the mod raise one banner between them.
const CLAIMS = '.claude/session-board/announced'
// Where a finish the person has seen is marked, by a press of 열기 or 확인 on its card: an empty
// folder named as its claim. An announced finish without one keeps its card, in every copy.
const SEEN = '.claude/session-board/seen'
// Where `notifier/build.sh` puts the board's own banner apps, one per kind, each with its icon.
const NOTIFIER = '.claude/session-board/notifier'
const TAIL_BYTES = 400_000
// Where that tail is all one cut line (a tool's result holding an image runs to a megabyte and
// more), the end is read this far back instead, still within what one run returns.
const WIDE_BYTES = 4_000_000
// A call guessed from timing alone (a tool still without its result) is announced only once a
// scan this much later still reads it so: a long command's process ends a moment before its
// result is written, and one of the board's copies, each scanning, often reads in between.
const CONFIRM_MS = 4000
// A finish is announced once it has held this long: a session the app wakes again at once (a
// background task's notice, a session it started coming back) is not finished.
const DONE_HOLD_MS = 10_000
// Where the desktop app keeps one JSON per session, naming the transcript it drives.
const APP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions'
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
// In each of those: the session's own ids, and the session that started it, where one did.
const LINK_FIELDS = '"sessionId":"local_[^"]+","cliSessionId":"[^"]+"|"spawnedFrom":\\{"sessionId":"[^"]+"'
// How often those are read again while a listed session is missing from them.
const LINKS_MS = 30_000
// A transcript's ledger lines run long only where a result quotes them; cut, they are skipped.
const LEDGER_LINE_CHARS = 200_000

// Color marks only the sessions that want a look; the rest stays in the theme's own ink.
const AMBER = '#D97706'
const BLUE = '#3B82F6'
const GREEN = '#16A34A'

const LOOK: Record<RowState, { mark: string; color: string | undefined }> = {
  waiting: { mark: '⏸', color: AMBER },
  tool: { mark: '●', color: BLUE },
  working: { mark: '●', color: BLUE },
  background: { mark: '◌', color: BLUE },
  done: { mark: '✓', color: undefined },
  stale: { mark: '○', color: undefined },
}

const isLive = (row: Row): boolean => row.state !== 'done' && row.state !== 'stale'
// A session at work turns its mark a quarter each scan: the board's only motion.
const SPIN = ['◐', '◓', '◑', '◒'] as const
// The elapsed gauge, a line that fills a segment for each ten minutes gone, full at an hour.
const GAUGE_CELLS = 6
const GAUGE_CELL_MS = 10 * 60_000

// A row's buttons stand beside its text only where the text keeps this much of the pane's
// cells beside them (a card's label, `✓ 임무 완료` nearly whole; a row's title); short of it,
// they go beneath, flush right, rather than crowd the text out or over it.
const LABEL_CELLS = 10
const TEXT_CELLS = 16

/**
 * How a surface spends the pane's cells. The terminal draws a wide character in two and a
 * button as `[ label ]`; a desktop draws its own face in fewer of its code font's cells (a
 * Hangul syllable in about one and a half) and spaces its buttons and gaps wider.
 */
type Fit = { scale: number; button: number; gap: number; frame: number }
const GRID: Fit = { scale: 1, button: 4, gap: 1, frame: 4 }
const FACE: Fit = { scale: 0.75, button: 3, gap: 1.5, frame: 2.5 }
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** The terminal's cells a text takes: two for a wide character, one for any other. */
const cellsOf = (text: string): number =>
  [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0)
const isBusy = (row: Row): boolean =>
  row.state === 'working' || row.state === 'tool' || row.state === 'background'
/**
 * A session in the background that does nothing itself: it waits on the sessions it started, or
 * on a wakeup it set, with no command, monitor or subagent of its own running. It is no one out
 * at work, as the sessions it started are counted for themselves: one dim line beneath them.
 */
const isStandingBy = (row: Row): boolean => {
  const { pending } = row

  return (
    row.state === 'background' &&
    pending !== null &&
    pending.shells === 0 &&
    pending.monitors === 0 &&
    pending.agents === 0 &&
    (pending.sessions > 0 || pending.wake !== null)
  )
}

/**
 * The busy sessions by family, each family where its first member stands among `rows`: a session
 * started by another of them goes with its starter, below one at work itself (its card) and above
 * one that only waits on it (its dim line), so that line is never left under other sessions' cards.
 */
const familiesOf = (rows: readonly Row[]): { lead: Row; members: Row[] }[] => {
  // A board kept from before rows named their starter's id has none until its next scan.
  const starterOf = (row: Row) => rows.find(other => other.id === (row.parentId ?? null))
  const placed = new Set<string>()
  const familyOf = (row: Row): Row[] => {
    placed.add(row.id)
    const started = rows
      .filter(other => other.parentId === row.id && !placed.has(other.id))
      .flatMap(familyOf)

    return isStandingBy(row) ? [...started, row] : [row, ...started]
  }

  return rows.flatMap(row => {
    let lead = row
    const seen = new Set([row.id])
    for (let up = starterOf(lead); up !== undefined && !seen.has(up.id); up = starterOf(lead)) {
      seen.add(up.id)
      lead = up
    }

    return placed.has(lead.id) ? [] : [{ lead, members: familyOf(lead) }]
  })
}

// A session that finished, or one that now waits on the person: each raised by its own app.
type Banner = 'done' | 'call'
const APPS: Record<Banner, string> = { done: 'Done', call: 'Call' }

// What a waiting session wants of the person, where the tool's own name would not say.
const ASKS: Record<string, string> = { AskUserQuestion: '질문 있습니다', ExitPlanMode: '작전 계획 결재' }
// The app's own tools, by what they do rather than their wire names.
const TOOL_NAMES: Record<string, string> = {
  mcp__ccd_turn__wrap_up: '마무리',
  mcp__ccd_turn__update_plan: '계획',
  mcp__ccd_session__start_session: '세션 시작',
}

const toolOf = (tool: string | null): string =>
  tool === null ? '도구' : (TOOL_NAMES[tool] ?? tool.replace(/^mcp__.+__/, ''))

/**
 * What a session in the background is up to, by the work it waits on most: the sessions it
 * started, a monitor's watch, a subagent, a command, or a wakeup it set; then the rest counted.
 */
const backgroundOf = (pending: Pending | null): string => {
  if (pending === null) {
    return '뒤에서 작업 중'
  }
  const { shells, monitors, agents, sessions, wake } = pending
  const verb =
    sessions > 0
      ? `대원 ${sessions}명 기다리는 중`
      : monitors > 0
        ? '보초 서는 중'
        : agents > 0
          ? '정찰대 기다리는 중'
          : shells > 0
            ? '뒤에서 작업 중'
            : wake !== null
              ? '알람 맞추고 쉬는 중'
              : '뒤에서 작업 중'
  const counts = [
    shells > 0 ? `명령 ${shells}` : null,
    monitors > 0 ? `모니터 ${monitors}` : null,
    agents > 0 ? `에이전트 ${agents}` : null,
  ].filter(part => part !== null)

  return counts.length === 0 ? verb : `${verb} · ${counts.join(', ')}`
}

const labelOf = (row: Row): string => {
  switch (row.state) {
    case 'waiting':
      return row.ask !== null
        ? '결재 바랍니다'
        : (ASKS[row.tool ?? ''] ?? `${toolOf(row.tool)} 허가 요청`)
    case 'tool':
      return `열일 중 · ${toolOf(row.tool)}`
    case 'working':
      return '열일 중'
    case 'background':
      return backgroundOf(row.pending)
    case 'done':
      return row.isInterrupted ? '작전 중지' : '임무 완료'
    case 'stale':
      return '잠수 중'
  }
}

/**
 * Where a session stands, after its project: the session that started it, else the branch it
 * is on, else that it is a worktree; and the client it runs in, where that is not this app.
 */
const whereOf = (row: Row): string =>
  [
    row.project,
    row.parent !== null
      ? `↳ ${row.parent}`
      : row.branch !== null
        ? `⎇ ${row.branch}`
        : row.worktree !== null
          ? '워크트리'
          : null,
    row.source === 'desktop' ? null : row.source,
  ]
    .filter(part => part !== null)
    .join(' · ')

/**
 * What a row's elapsed time counts from: a busy session's from when its work began, not its
 * latest step; one in the background from when that work began; a waiting one's from the call
 * it waits on; a finished one's from its last word.
 */
/** A row's mark: a turning one while its turn is under way, a stop for one the person halted. */
const markOf = (row: Row, now: number): string => {
  if (row.state === 'working' || row.state === 'tool') {
    return SPIN[Math.floor(now / SCAN_MS) % SPIN.length] ?? LOOK[row.state].mark
  }

  return row.state === 'done' && row.isInterrupted ? '■' : LOOK[row.state].mark
}

/** The gauge's filled and empty runs: box-drawing lines, which every font draws alike. */
const gaugeOf = (ms: number): { full: string; rest: string } => {
  const cells = Math.min(GAUGE_CELLS, Math.floor(Math.max(0, ms) / GAUGE_CELL_MS))

  return { full: '━'.repeat(cells), rest: '─'.repeat(GAUGE_CELLS - cells) }
}

const startOf = (row: Row): number => {
  if ((row.state === 'tool' || row.state === 'working') && row.since !== null) {
    return row.since
  }

  return row.state === 'background' && row.pending !== null ? row.pending.since : row.at
}

const board = atom({ plugin: 'session-board', key: 'board' } as const, {
  rows: [],
  now: 0,
  unseen: [],
})

// Module state: a hot reload starts all of it over, and the next scan refills it. A session
// first seen is given its state without a banner, so a reload announces nothing old.
const tails = new Map<
  string,
  { mtime: number; size: number; tail: Tail; home: Home; ledger: Ledger | null }
>()
// Each session's state at the last scan, with the time of the entry it was read from.
const states = new Map<string, { state: RowState; at: number }>()
// Each finish read and not yet announced: the end it was read at, and when it was first read.
const finishes = new Map<string, { at: number; since: number }>()
// Each desktop session's own id in the app, and that of the session that started it.
const links = new Map<string, { local: string; parent: string | null }>()
let linksAt = Number.NEGATIVE_INFINITY
// The directory each transcript folder was found on disk to be named after, looked for once.
const homes = new Map<string, string | null>()
// When each prompt the tails had lost was written, looked for once a prompt.
const starts = new Map<string, number | null>()
// Each session read as waiting: the call it waits on, when that was first read, and whether
// its banner went up (or was never due, as for a wait found on the first look).
const calls = new Map<string, { at: number; since: number; isAnnounced: boolean }>()
// The finishes marked seen by a press here, by their claim's name, before the mark is on disk.
const marked = new Set<string>()
let isScanning = false
// The pane's buttons as last drawn, by key, each with what its press runs; whether the pane held
// the keyboard then; and the button a focusing click was last taken as pressing, and when.
let pressable = new Map<string, Press>()
let isPaneFocused = false
let tookFocus: { element: string; at: number } | null = null
// A press this soon after a focusing click on the same button is that click, and is dropped.
const TWIN_MS = 1500

/** The name a finish is claimed and marked seen under. */
const finishName = (row: Row): string => `${row.id}-${row.at}`

/** The names in one of the board's folders of claims; none where it cannot be listed. */
const namesIn = async ($: EngineInterface, dir: string): Promise<Set<string>> => {
  try {
    const entries = await $.fs.list(dir)

    return new Set(entries.map(entry => entry.name))
  } catch {
    return new Set()
  }
}

/**
 * The finished sessions whose cards stay up until the person opens or dismisses them: each
 * finish announced, or holding before its banner, and not yet marked seen. A turn the person
 * halted is no finish, and this session's own is in front of them.
 */
const unseenOf = async ($: EngineInterface, home: string, rows: readonly Row[]): Promise<string[]> => {
  const announced = await namesIn($, `${home}/${CLAIMS}`)
  const seen = await namesIn($, `${home}/${SEEN}`)

  return rows
    .filter(row => {
      const name = finishName(row)

      return (
        row.state === 'done' &&
        !row.isInterrupted &&
        !row.isSelf &&
        !seen.has(name) &&
        !marked.has(name) &&
        (announced.has(name) || finishes.get(row.id)?.at === row.at)
      )
    })
    .map(row => row.id)
}

/**
 * Marks finishes seen, at a press on their cards: each goes down among the rest at once here,
 * and in every other copy of the board at its next scan, by the mark it finds on disk.
 */
const markSeen = async ($: EngineInterface, rows: readonly Row[]): Promise<void> => {
  const names = rows.map(finishName)
  const ids = new Set(rows.map(row => row.id))
  for (const name of names) {
    marked.add(name)
  }
  await update($, board, last => ({
    ...last,
    unseen: (last.unseen ?? []).filter(id => !ids.has(id)),
  }))
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined && names.length > 0) {
      await $.process.run(['mkdir', '-p', ...names.map(name => `${home}/${SEEN}/${name}`)])
    }
  } catch {
    // The card stays down in this copy; another shows it again until a press there.
  }
}

/**
 * The first time the board keeps its cards, marks seen every finish announced before: the cards
 * are for the finishes from now on, not a day of old ones at once.
 */
const seed = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined) {
      return
    }
    await $.process.run(['mkdir', '-p', `${home}/${CLAIMS}`])
    // `mkdir` without `-p` fails where the folder is there: the seed is laid once.
    const made = await $.process.run(['mkdir', `${home}/${SEEN}`])
    if (made.exitCode !== 0) {
      return
    }
    const names = [...(await namesIn($, `${home}/${CLAIMS}`))].filter(name => !name.endsWith('-call'))
    if (names.length > 0) {
      await $.process.run(['mkdir', '-p', ...names.map(name => `${home}/${SEEN}/${name}`)])
    }
  } catch {
    // Without the seed the old finishes show as cards, each dismissed with one press.
  }
}

/**
 * The end of a transcript, read further back where the usual tail holds no entry of the talk:
 * one line can outgrow it, and a tail that is all one cut line says nothing of the session.
 * Where even the wide read holds none, the latest write is taken for work under way, since
 * such a line is a tool's result. Null where the transcript could not be read.
 */
const tailOf = async (
  $: EngineInterface,
  path: string,
  size: number,
  mtimeMs: number,
): Promise<Tail | null> => {
  let tail = readTail('')
  for (const bytes of [TAIL_BYTES, WIDE_BYTES]) {
    const ran = await $.process.run(['tail', '-c', String(bytes), path], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) {
      return null
    }
    tail = readTail(ran.stdout)
    if (tail.last !== null || size <= bytes) {
      return tail
    }
  }

  return { ...tail, last: { kind: 'model', tool: null, command: null, at: mtimeMs } }
}

/**
 * The tail, with when its work began where the tail starts after that (a long turn's entries
 * soon fill it): the transcript's first entry answering the same prompt, which is the prompt.
 */
const withStart = async ($: EngineInterface, path: string, tail: Tail): Promise<Tail> => {
  const { promptId } = tail
  if (tail.since !== null || promptId === null || tail.last === null || tail.last.kind === 'end') {
    return tail
  }
  let since = starts.get(promptId)
  if (since === undefined) {
    try {
      const ran = await $.process.run(['grep', '-a', '-m', '1', '-F', `"promptId":"${promptId}"`, path], {
        timeoutMs: 10_000,
      })
      const at = Date.parse(/"timestamp":"([^"]+)"/.exec(ran.stdout)?.[1] ?? '')
      since = Number.isNaN(at) ? null : at
    } catch {
      return tail
    }
    starts.set(promptId, since)
  }

  return { ...tail, since }
}

/**
 * The background work a transcript started and has not heard the end of, read from the whole
 * transcript, since a long turn soon pushes a task's start out of the tail. Null where it could
 * not be read; the session then reads as done when its turn is.
 */
const ledgerIn = async ($: EngineInterface, path: string): Promise<Ledger | null> => {
  try {
    const ran = await $.process.run(
      ['sh', '-c', `grep -a -E "$0" "$1" | cut -c 1-${LEDGER_LINE_CHARS}`, LEDGER_LINES, path],
      { timeoutMs: 10_000 },
    )

    return ran.exitCode === 0 ? ledgerOf(ran.stdout) : null
  } catch {
    return null
  }
}

/**
 * Reads which desktop session started which, from the app's own records, where a listed session
 * is missing from what was read: a session started from another is written there as it starts.
 */
const readLinks = async (
  $: EngineInterface,
  home: string,
  rows: readonly Row[],
  now: number,
): Promise<void> => {
  const isMissing = rows.some(row => row.source === 'desktop' && !links.has(row.id))
  if (!isMissing || now - linksAt < LINKS_MS) {
    return
  }
  linksAt = now
  try {
    const found = await $.process.run(
      [
        'find',
        `${home}/${APP_SESSIONS}`,
        '-name',
        '*.json',
        '-mmin',
        `-${WINDOW_MINUTES}`,
        '-exec',
        'grep',
        '-HoE',
        LINK_FIELDS,
        '{}',
        '+',
      ],
      { timeoutMs: 10_000 },
    )
    const records = new Map<string, { local?: string; cli?: string; parent?: string }>()
    for (const line of found.stdout.split('\n')) {
      const cut = line.indexOf('.json:')
      if (cut < 0) {
        continue
      }
      const record = records.get(line.slice(0, cut)) ?? {}
      const field = line.slice(cut + '.json:'.length)
      const own = /^"sessionId":"([^"]+)","cliSessionId":"([^"]+)"$/.exec(field)
      const from = /^"spawnedFrom":\{"sessionId":"([^"]+)"$/.exec(field)
      record.local ??= own?.[1]
      record.cli ??= own?.[2]
      record.parent ??= from?.[1]
      records.set(line.slice(0, cut), record)
    }
    for (const { local, cli, parent } of records.values()) {
      if (local !== undefined && cli !== undefined) {
        links.set(cli, { local, parent: parent ?? null })
      }
    }
  } catch {
    // Without the app's records each session stands alone; they are read again later.
  }
}

/** The id of the session that started this one, where the app's records name a listed one. */
const parentIn = (rows: readonly Row[]): ((id: string) => string | null) => {
  const ids = new Map(
    rows.flatMap(row => {
      const local = links.get(row.id)?.local

      return local === undefined ? [] : [[local, row.id] as const]
    }),
  )

  return id => {
    const parent = links.get(id)?.parent

    return parent === undefined || parent === null ? null : (ids.get(parent) ?? null)
  }
}

/** The names of a directory's subdirectories and links; none where it cannot be listed. */
const subdirsOf = async ($: EngineInterface, dir: string): Promise<string[]> => {
  try {
    const entries = await $.fs.list(dir)

    return entries.filter(entry => entry.kind === 'dir' || entry.isLink).map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * A session's own directory. Where the tail holds no entry written in or beneath it (the shell
 * has been elsewhere that long, or the project was moved since), it is found on disk by the
 * transcript folder's name, and git is asked its branch, which the tail cannot say.
 */
const homeIn = async ($: EngineInterface, path: string, tail: Tail): Promise<Home> => {
  const near = homeAmong(path, tail.places)
  if (near !== null) {
    return near
  }
  try {
    const folder = folderIn(path)
    let cwd = homes.get(folder)
    if (cwd === undefined) {
      cwd = await findHome(folder, dir => subdirsOf($, dir))
      homes.set(folder, cwd)
    }
    if (cwd === null) {
      return homeOf(path, tail.places)
    }
    const ran = await $.process.run(['git', '-C', cwd, 'branch', '--show-current'], {
      timeoutMs: 10_000,
    })

    return { cwd, branch: ran.exitCode === 0 ? ran.stdout.trim() || null : null }
  } catch {
    return homeOf(path, tail.places)
  }
}

/** The desktop app's link to one of its own sessions, where the app's record of it is found. */
const desktopLink = async ($: EngineInterface, home: string, row: Row): Promise<string | null> => {
  if (row.source !== 'desktop' || !SESSION_ID.test(row.id)) {
    return null
  }
  const known = links.get(row.id)?.local
  if (known !== undefined) {
    return `claude://claude.ai/epitaxy/${known}`
  }
  const found = await $.process.run(
    ['grep', '-rlE', `"cliSessionId": ?"${row.id}"`, `${home}/${APP_SESSIONS}`],
    { timeoutMs: 10_000 },
  )
  const local = found.stdout
    .split('\n')
    .find(line => line.endsWith('.json'))
    ?.split('/')
    .pop()
    ?.replace(/\.json$/, '')

  return local === undefined ? null : `claude://claude.ai/epitaxy/${local}`
}

/** Where a click on a session's banner takes the person: its own window, where one is known. */
const linkOf = async ($: EngineInterface, home: string, row: Row): Promise<string | null> => {
  try {
    return row.source === 'VS Code' && row.cwd !== null
      ? `vscode://file${encodeURI(row.cwd)}`
      : await desktopLink($, home, row)
  } catch {
    return null
  }
}

/**
 * Raises one macOS banner for a session that just finished or now waits on the person, through
 * the board's own app for that kind, which wears its icon, plays its sound and opens the session
 * when the banner is clicked; through a quiet `osascript` one where that app is missing or could
 * not post.
 * `mkdir` of the claim fails where another copy of the mod made it first, and that copy's
 * banner stands.
 */
const announce = async ($: EngineInterface, home: string, row: Row, kind: Banner): Promise<void> => {
  try {
    if (!SESSION_ID.test(row.id)) {
      return
    }
    await $.process.run(['mkdir', '-p', `${home}/${CLAIMS}`])
    const claim = await $.process.run([
      'mkdir',
      `${home}/${CLAIMS}/${row.id}-${row.at}${kind === 'call' ? '-call' : ''}`,
    ])
    if (claim.exitCode !== 0) {
      return
    }
    const title =
      kind === 'call'
        ? `${LOOK[row.state].mark} ${row.project} 대장님 호출 · ${labelOf(row)}`
        : `${LOOK[row.state].mark} ${row.project} ${labelOf(row)}`
    const name = [row.title, row.source === 'desktop' ? '' : row.source]
      .filter(part => part !== '')
      .join(' · ')
    // A decision is what the person acts on: it leads, and the session it is from follows.
    const body =
      kind === 'call' && row.ask !== null
        ? [`“${row.ask}”`, name].filter(part => part !== '').join(' · ')
        : name || row.source
    const link = await linkOf($, home, row)
    try {
      const posted = await $.process.run(
        [
          `${home}/${NOTIFIER}/${APPS[kind]}.app/Contents/MacOS/Notifier`,
          '--title',
          title,
          '--body',
          body,
          ...(link === null ? [] : ['--open', link]),
        ],
        { timeoutMs: 10_000 },
      )
      // 2: the person turned this app's banners off in System Settings, and that stands.
      if (posted.exitCode === 0 || posted.exitCode === 2) {
        return
      }
    } catch {
      // The app is not built on this machine: the plain banner stands in.
    }
    // The texts ride as arguments, never inside the script, so a title cannot be read as code.
    await $.process.run(
      [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        body,
      ],
      { timeoutMs: 10_000 },
    )
  } catch {
    // A banner that could not be raised is not worth failing the scan for.
  }
}

/**
 * A session's state read again past the cache, with its pending shell call looked for afresh: a
 * call banner pulls the person from their work, so it waits on the transcript as it stands now,
 * not as the scan last read it (a long command that just ended may have written its result by
 * now). Null where the transcript could not be read; the scan's own reading then stands.
 */
const stateNow = async (
  $: EngineInterface,
  path: string,
  size: number,
  now: number,
): Promise<RowState | null> => {
  try {
    const tail = await tailOf($, path, size, now)
    if (tail === null) {
      return null
    }
    const { last } = tailAt(tail, now)
    const probes = pendingShell(last, now)
    let isRunning: boolean | undefined
    if (probes !== null) {
      const listed = await $.process.run(['ps', '-axww', '-o', 'command='], { timeoutMs: 10_000 })
      isRunning = listed.exitCode === 0 ? probes.some(probe => listed.stdout.includes(probe)) : undefined
    }

    return stateOf(last, now, isRunning)
  } catch {
    return null
  }
}

/**
 * Drops the claims and the seen marks of a day ago and older; each is an empty folder. A mark is
 * laid after its claim, so it outlasts it: a day-old finish goes down among the rest.
 */
const sweep = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined) {
      await $.process.run(
        [
          'find',
          `${home}/${CLAIMS}`,
          `${home}/${SEEN}`,
          '-mindepth',
          '1',
          '-maxdepth',
          '1',
          '-mmin',
          '+1440',
          '-exec',
          'rmdir',
          '{}',
          '+',
        ],
        { timeoutMs: 10_000 },
      )
    }
  } catch {
    // Old claims are small; the next start sweeps again.
  }
}

const scan = async ($: EngineInterface): Promise<void> => {
  if (isScanning) {
    return
  }
  isScanning = true
  try {
    const home = await $.env.get('HOME')
    if (home === undefined) {
      return
    }
    // `stat -f` is the BSD (macOS) spelling: seconds since the epoch, the size, then the path.
    // A transcript only grows, so its size tells apart two writes within one second, which the
    // seconds alone do not: a tool's result written in the second its call was read in.
    const found = await $.process.run(
      [
        'find',
        `${home}/.claude/projects`,
        '-maxdepth',
        '2',
        '-name',
        '*.jsonl',
        '-mmin',
        `-${WINDOW_MINUTES}`,
        '-exec',
        'stat',
        '-f',
        '%m %z %N',
        '{}',
        '+',
      ],
      { timeoutMs: 10_000 },
    )
    const files = found.stdout
      .split('\n')
      .filter(line => line !== '')
      .map(line => {
        const [mtime = '', size = '', ...path] = line.split(' ')

        return { mtime: Number(mtime), size: Number(size), path: path.join(' ') }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_FILES)
    const self = await $.session.id()
    const now = await $.clock.now()
    const read: {
      path: string
      mtime: number
      size: number
      tail: Tail
      home: Home
      ledger: Ledger | null
    }[] = []
    for (const file of files) {
      let hit = tails.get(file.path)
      if (hit === undefined || hit.mtime !== file.mtime || hit.size !== file.size) {
        const fresh = await tailOf($, file.path, file.size, file.mtime * 1000)
        if (fresh !== null) {
          const tail = await withStart($, file.path, fresh)
          // Only a finished turn is asked what it left running: the tail's own, or the one a
          // prompt not yet sent stands after.
          const isEnded = tail.last?.kind === 'end' || tail.unsent?.last?.kind === 'end'
          const ledger = isEnded ? await ledgerIn($, file.path) : null
          hit = {
            mtime: file.mtime,
            size: file.size,
            tail,
            home: await homeIn($, file.path, tail),
            ledger,
          }
          tails.set(file.path, hit)
        }
      }
      // A transcript that could not be read keeps its last reading, and is read again next scan.
      // A prompt never sent writes nothing more, so the reading is settled against the clock here,
      // past the cache, not when the transcript is read.
      if (hit !== undefined) {
        read.push({ path: file.path, ...hit, tail: tailAt(hit.tail, now), mtime: file.mtime, size: file.size })
      }
    }
    // A shell call that has sat is either running or waiting to be allowed, and the transcript
    // says the same for both: its process, found or not among the running ones, tells them apart.
    // A call queued behind another shell call of its reply is told by that one's process.
    const probes = read.map(one => pendingShell(one.tail.last, now))
    let processes: string | null = null
    if (probes.some(shells => shells !== null)) {
      const listed = await $.process.run(['ps', '-axww', '-o', 'command='], { timeoutMs: 10_000 })
      processes = listed.exitCode === 0 ? listed.stdout : null
    }
    const running = processes
    const alone = read.map((one, index) => {
      const shells = probes[index] ?? null
      const isRunning =
        shells === null || running === null ? undefined : shells.some(probe => running.includes(probe))
      const pending = pendingOf(one.ledger, now)

      return rowOf(one.path, one.tail, one.mtime * 1000, now, self, isRunning, one.home, pending)
    })
    await readLinks($, home, alone, now)
    const rows = linkRows(alone, parentIn(alone))
    const unseen = await unseenOf($, home, rows)
    const shown = order(
      [...rows]
        .sort((a, b) => b.at - a.at)
        .filter((row, index) => index < MAX_ROWS || isBusy(row) || unseen.includes(row.id)),
    )
    await update($, board, () => ({ rows: shown, now, unseen }))
    for (const [index, row] of rows.entries()) {
      const one = read[index]
      const was = states.get(row.id)
      states.set(row.id, { state: row.state, at: row.at })
      if (row.state !== 'waiting') {
        calls.delete(row.id)
      }
      if (row.state !== 'done') {
        finishes.delete(row.id)
      }
      if (row.isSelf || was === undefined) {
        // A wait found on the first look was there before this copy: nothing to announce.
        if (row.state === 'waiting') {
          calls.set(row.id, { at: row.at, since: now, isAnnounced: true })
        }
        continue
      }
      if (row.state === 'done') {
        // A finish is a turn the session ended itself: not one the person interrupted, nor a
        // wait passed over or background work run out with no word from the session since.
        // It must hold before its banner, as a session the app wakes again at once is not done.
        // A finish is newer than what the scan read before: an older one coming back (a prompt
        // that was never sent, given up) is no news.
        let held = finishes.get(row.id)
        if (one?.tail.last?.kind === 'end' && row.at > was.at && !row.isInterrupted) {
          held = { at: row.at, since: now }
          finishes.set(row.id, held)
        }
        if (held !== undefined && now - held.since >= DONE_HOLD_MS) {
          finishes.delete(row.id)
          await announce($, home, row, 'done')
        }
        continue
      }
      if (row.state !== 'waiting' || one === undefined) {
        continue
      }
      // Waiting on the person: worth a banner once per call. A question is known at once; a
      // wait guessed from timing must hold on a later scan, and in the transcript read again.
      let call = calls.get(row.id)
      if (call === undefined || call.at !== row.at) {
        call = { at: row.at, since: now, isAnnounced: false }
        calls.set(row.id, call)
      }
      if (call.isAnnounced || (!isAsking(one.tail.last) && now - call.since < CONFIRM_MS)) {
        continue
      }
      const fresh = await stateNow($, one.path, one.size, now)
      if (fresh === null || fresh === 'waiting') {
        call.isAnnounced = true
        await announce($, home, row, 'call')
      } else {
        // The scan's reading was behind: the fresh one stands, and the next scan reads the
        // transcript again to show it.
        states.set(row.id, { state: fresh, at: row.at })
        calls.delete(row.id)
        tails.delete(one.path)
      }
    }
    // A finish this scan read is holding now, or was just claimed: its card goes up at once,
    // not a scan later.
    const after = await unseenOf($, home, shown)
    if (after.join() !== unseen.join()) {
      await update($, board, last => ({ ...last, unseen: after }))
    }
  } catch {
    // The board keeps what it last showed.
  } finally {
    isScanning = false
  }
}

/** Brings a session's own window forward: the desktop app by its link, VS Code by its folder. */
const openRow = async ($: EngineInterface, row: Row): Promise<void> => {
  try {
    const home = await $.env.get('HOME')
    const link = home === undefined ? null : await desktopLink($, home, row)
    if (link !== null) {
      await $.process.run(['open', link])

      return
    }
    if (row.source === 'VS Code' && row.cwd !== null) {
      const ran = await $.process.run(['open', '-a', 'Visual Studio Code', row.cwd])
      if (ran.exitCode === 0) {
        return
      }
    }
    $.ui.toast(`${row.project}: 여기서는 열 수 없는 세션입니다 (${row.source})`)
  } catch {
    $.ui.toast(`${row.project}: 세션을 열지 못했습니다`)
  }
}

/** What a button of the pane does: go to a session, or not, and take finishes as seen. */
type Press =
  | { kind: 'open' | 'desktop'; row: Row; seen: readonly Row[] }
  | { kind: 'seen'; seen: readonly Row[] }

const LABELS: Record<Press['kind'], string> = { open: '열기', desktop: '데스크톱으로', seen: '확인' }
// Drawn on this session's own row in place of its buttons.
const SELF_NOTE = '지금 이 세션'

/**
 * A row's buttons, in the order drawn: its own window, where one is known; a hand-over of a
 * finished session another client ran; and 확인 on a finish not yet seen.
 */
const buttonsOf = (row: Row, isUnseen: boolean): Press['kind'][] => [
  ...(row.source !== 'terminal' ? (['open'] as const) : []),
  ...(row.source !== 'desktop' && !isLive(row) ? (['desktop'] as const) : []),
  ...(isUnseen ? (['seen'] as const) : []),
]

/** Runs a button's press, whether the press itself or a focusing click raised it. */
const act = ($: EngineInterface, press: Press): void => {
  if (press.seen.length > 0) {
    void markSeen($, press.seen)
  }
  if (press.kind === 'open') {
    void openRow($, press.row)
  } else if (press.kind === 'desktop') {
    void moveToDesktop($, press.row)
  }
}

/**
 * Hands a session another client ran over to the desktop app, by the link the engine's own
 * /desktop command opens. The app imports the transcript and resumes it as its own session.
 */
const moveToDesktop = async ($: EngineInterface, row: Row): Promise<void> => {
  try {
    if (!SESSION_ID.test(row.id)) {
      $.ui.toast(`${row.project}: 세션 ID를 읽지 못했습니다`)

      return
    }
    const ran = await $.process.run(['open', `claude://resume?session=${row.id}`])
    if (ran.exitCode !== 0) {
      $.ui.toast(`${row.project}: Claude 데스크톱을 열지 못했습니다`)
    }
  } catch {
    $.ui.toast(`${row.project}: 세션을 옮기지 못했습니다`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The board is for the desktop app's sessions: in one another client hosts (VS Code, a
    // terminal, a headless run) it opens no pane and reads nothing.
    if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-desktop') {
      return next(e)
    }
    await $.command.register({
      name: 'board',
      description: 'Open the pane that lists every recent Claude Code session and its state',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await sweep($)
    await seed($)
    await scan($)
    $.clock.every(SCAN_MS, () => {
      void scan($)
    })

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await scan($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? '세션 현황 패널을 열었습니다.'
        : `패널을 열지 못했습니다: ${opened.reason}`,
    }
  })

  // The desktop app takes a click on a pane that does not hold the keyboard as moving its focus
  // ring onto the button clicked, and raises no press: that move is taken as the press. Tab and
  // the arrows move the ring only in a pane that holds the keyboard, and are left alone.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const { element } = e
    const action = element === undefined ? undefined : pressable.get(element)
    if (element !== undefined && action !== undefined && e.origin.kind === 'person' && !isPaneFocused) {
      tookFocus = { element, at: await $.clock.now() }
      act($, action)
    }

    return next(e)
  })

  // Where a surface raises the press as well, it follows the focusing click at once: dropped.
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    const took = tookFocus
    if (took !== null && took.element === e.element && (await $.clock.now()) - took.at < TWIN_MS) {
      tookFocus = null

      return { element: e.element }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // The terminal lays the board on its grid of cells; every other surface draws Text in its own
    // face and sizes, where a rule of dashes has no column to run to and is left out.
    const isGrid = e.surface === 'terminal'
    const fit = isGrid ? GRID : FACE
    isPaneFocused = e.props.isFocused
    // Each button's press, kept by its key so that a focusing click can run it too.
    const handlers = new Map<string, Press>()
    const press = (key: string, action: Press) => {
      handlers.set(key, action)

      return () => act($, action)
    }
    // A board kept from before it held its cards has no `unseen` until its next scan.
    const { rows, now, unseen = [] } = await read($, board)
    if (rows.length === 0) {
      pressable = handlers

      return (
        <Box>
          <Text size="footnote" dimColor>
            대장님, 지금은 조용합니다.
          </Text>
        </Box>
      )
    }
    const isUnseen = (row: Row): boolean => unseen.includes(row.id)
    const calls = rows.filter(row => row.state === 'waiting')
    const reports = rows.filter(isUnseen)
    const busy = rows.filter(isBusy)
    const working = busy.filter(row => !isStandingBy(row))
    const standing = busy.filter(isStandingBy)
    const back = rows.filter(row => !isLive(row) && !isUnseen(row))
    const report = [
      calls.length > 0 ? `결재 ${calls.length}건` : null,
      reports.length > 0 ? `완료 보고 ${reports.length}건` : null,
      working.length > 0 ? `대원 ${working.length}명 출동 중` : null,
      standing.length > 0 ? `대기 ${standing.length}명` : null,
    ].filter(part => part !== null)
    const tally = (label: string, count: number, color: string | undefined) => (
      <Text
        color={count === 0 ? undefined : color}
        dimColor={count === 0 || color === undefined}
        size="footnote"
        tabular
      >
        {label} {count}
      </Text>
    )
    const section = (name: string) =>
      isGrid ? (
        <Text dimColor wrap="truncate-end">
          ── {name} ────────────────────────
        </Text>
      ) : (
        <Text size="caption" weight="semibold" dimColor wrap="truncate-end">
          {name}
        </Text>
      )
    // The way to a session: its own window, or a hand-over of one another client ran. Either
    // takes a finish as seen, as 확인 does without going there.
    const actions = (row: Row, isQuiet: boolean) => {
      if (row.isSelf) {
        return (
          <Box flexShrink={0}>
            <Text size="footnote" dimColor>
              {SELF_NOTE}
            </Text>
          </Box>
        )
      }
      const seen = isUnseen(row) ? [row] : []

      return (
        <Box columnGap="sm" flexShrink={0}>
          {buttonsOf(row, isUnseen(row)).map(kind => (
            <Button
              key={`${kind}:${row.id}`}
              label={LABELS[kind]}
              dimColor={kind === 'desktop' || (kind === 'open' && isQuiet)}
              onPress={press(`${kind}:${row.id}`, kind === 'seen' ? { kind, seen } : { kind, row, seen })}
            />
          ))}
        </Box>
      )
    }
    // The pane's cells a text takes, at most `most` of the terminal's; and a row's buttons.
    const across = (text: string, most = Number.POSITIVE_INFINITY): number =>
      Math.min(cellsOf(text), most) * fit.scale
    const actionsAcross = (row: Row): number => {
      if (row.isSelf) {
        return across(SELF_NOTE)
      }
      const labels = buttonsOf(row, isUnseen(row)).map(kind => LABELS[kind])

      return (
        labels.reduce((sum, label) => sum + across(label) + fit.button, 0) +
        fit.gap * Math.max(0, labels.length - 1)
      )
    }
    // A one-line row, its mark and text, with its buttons beside it where the text keeps its
    // room, else beneath it, flush right.
    const lineOf = (row: Row, line: RenderElement) =>
      1 + TEXT_CELLS * fit.scale + 2 * fit.gap + actionsAcross(row) <= e.props.bodyColumns ? (
        <Box key={`row:${row.id}`} justifyContent="space-between" alignItems="center" columnGap="sm">
          {line}
          {actions(row, true)}
        </Box>
      ) : (
        <Box key={`row:${row.id}`} flexDirection="column" rowGap="xs">
          {line}
          <Box justifyContent="flex-end">{actions(row, true)}</Box>
        </Box>
      )
    const card = (row: Row) => {
      const color = isUnseen(row) ? GREEN : LOOK[row.state].color
      const elapsed = now - startOf(row)
      const gauge = gaugeOf(elapsed)
      const mark = `${markOf(row, now)} ${labelOf(row)}`
      const time = `${ago(elapsed)}째`
      // The top line holds the label, the gauge, the time and the buttons where the pane is wide
      // enough for all four; narrower, the buttons take a line of their own at the card's foot.
      const isBeside =
        fit.frame + across(mark, LABEL_CELLS) + GAUGE_CELLS + across(time) + 3 * fit.gap + actionsAcross(row) <=
        e.props.bodyColumns

      return (
        <Box
          key={`row:${row.id}`}
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX="sm"
          paddingY="xs"
        >
          <Box justifyContent="space-between" alignItems="center" columnGap="sm">
            {/* Narrowed, the label gives way first and ends in an ellipsis; the time and the
                button stay whole. */}
            <Box columnGap="sm" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}>
                <Text color={color} size="footnote" weight="semibold" wrap="truncate-end">
                  {mark}
                </Text>
              </Box>
              <Box columnGap="sm" flexShrink={0}>
                {/* The gauge's lines join up only in a monospaced face. */}
                <Box>
                  {gauge.full !== '' && (
                    <Text color={color} dimColor size="footnote" mono>
                      {gauge.full}
                    </Text>
                  )}
                  {gauge.rest !== '' && (
                    <Text dimColor size="footnote" mono>
                      {gauge.rest}
                    </Text>
                  )}
                </Box>
                <Text dimColor size="footnote" tabular>
                  {time}
                </Text>
              </Box>
            </Box>
            {isBeside && actions(row, false)}
          </Box>
          <Text weight="semibold" wrap="truncate-end">
            {row.title === '' ? '(제목 없음)' : row.title}
          </Text>
          {row.state === 'waiting' && row.ask !== null && (
            <Text wrap="truncate-end">“{row.ask}”</Text>
          )}
          <Text dimColor size="footnote" wrap="truncate-end">
            {whereOf(row)}
          </Text>
          {!isBeside && (
            <Box justifyContent="flex-end" marginTop="xs">
              {actions(row, false)}
            </Box>
          )}
        </Box>
      )
    }

    // A starter that only waits on the sessions it started: one line, cut at its end, the title
    // staying longest, then what it waits on.
    const standingLine = (row: Row) =>
      lineOf(
        row,
        <Box columnGap="sm" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={BLUE} dimColor mono>
            {LOOK.background.mark}
          </Text>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor size="footnote" wrap="truncate-end">
              {`${row.title === '' ? '(제목 없음)' : row.title} · ${labelOf(row)} · ${ago(now - startOf(row))}째`}
            </Text>
          </Box>
        </Box>,
      )

    const tree = (
      <Box flexDirection="column" rowGap="md">
        <Box flexDirection="column" rowGap="xs">
          <Text size="heading" weight="semibold">
            대장님, {report.length === 0 ? '전원 복귀했습니다' : report.join(' · ')}
          </Text>
          <Box columnGap="md" flexWrap="wrap">
            {tally('⏸ 결재', calls.length, AMBER)}
            {tally('✓ 보고', reports.length, GREEN)}
            {tally('● 출동', working.length, BLUE)}
            {tally('✓ 복귀', back.length, undefined)}
          </Box>
        </Box>
        {/* Down, `xs` and `sm` are no rows on the terminal: there the cards stack as they did. */}
        {calls.length > 0 && (
          <Box flexDirection="column" rowGap="sm">
            {section('결재 대기')}
            {calls.map(card)}
          </Box>
        )}
        {reports.length > 0 && (
          <Box flexDirection="column" rowGap="sm">
            <Box justifyContent="space-between" alignItems="center" columnGap="sm">
              <Box flexShrink={1} minWidth={0}>
                {section('완료 보고')}
              </Box>
              {reports.length > 1 && (
                <Box flexShrink={0}>
                  <Button
                    key="seen:all"
                    label="모두 확인"
                    dimColor
                    onPress={press('seen:all', { kind: 'seen', seen: reports })}
                  />
                </Box>
              )}
            </Box>
            {reports.map(card)}
          </Box>
        )}
        {busy.length > 0 && (
          <Box flexDirection="column" rowGap="sm">
            {section('작전 중')}
            {familiesOf([...working, ...standing]).map(({ lead, members }) => {
              const drawn = members.map(row => (isStandingBy(row) ? standingLine(row) : card(row)))

              // A family keeps closer together than the sessions around it.
              return members.length === 1 ? (
                drawn[0]
              ) : (
                <Box key={`family:${lead.id}`} flexDirection="column" rowGap="xs">
                  {drawn}
                </Box>
              )
            })}
          </Box>
        )}
        {back.length > 0 && (
          <Box flexDirection="column" rowGap="md">
            {section('복귀 완료')}
            {back.map(row =>
              lineOf(
                row,
                // The text gives way to the pane's width, cut with an ellipsis; the buttons not.
                // The mark keeps a column of its own, so both lines start under the title in
                // any face.
                <Box columnGap="sm" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor mono>
                    {markOf(row, now)}
                  </Text>
                  <Box flexDirection="column" flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">{row.title === '' ? '(제목 없음)' : row.title}</Text>
                    <Text dimColor size="footnote" wrap="truncate-end">
                      {`${ago(now - row.at)} 전 · `}
                      {row.state === 'done' && !row.isInterrupted ? '' : `${labelOf(row)} · `}
                      {whereOf(row)}
                    </Text>
                  </Box>
                </Box>,
              ),
            )}
          </Box>
        )}
        <Text size="caption" dimColor>
          5초마다 순찰 중
        </Text>
      </Box>
    )
    // Drawn whole, the tree's buttons are the ones a focusing click may now press.
    pressable = handlers

    return tree
  })
}
