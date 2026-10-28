import type { Pending, Row, RowState } from '../types'

export type Last = {
  kind: 'end' | 'tool' | 'model'
  tool: string | null
  /** A pending shell call's command, by which its process is looked for. */
  command: string | null
  /**
   * Every shell command of the turn still without its result, the latest last: the calls of one
   * reply run one after another, so the latest may not have begun while an earlier one runs.
   */
  commands?: readonly string[]
  at: number
  /** An end's: the decision the turn's wrap-up put to the person. */
  ask?: string | null
  /** An end the person made by interrupting the turn. */
  isInterrupt?: boolean
}

export type Tail = {
  title: string | null
  lastPrompt: string | null
  /** The decision the current turn's wrap-up put to the person, if it has put one. */
  ask: string | null
  /** That wrap-up's call: its result ends the turn, as the box showing a question does. */
  askCall: string | null
  /** Each directory the session's shell stood in, the latest last, with the branch read there. */
  places: Map<string, string | null>
  entrypoint: string | null
  last: Last | null
  /** When the work under way began; null where the tail starts after that, or none is under way. */
  since: number | null
  /** The prompt the latest entries answer, by which a start beyond the tail is looked for. */
  promptId: string | null
  /**
   * Where the latest prompt has not been sent to the model: what the tail read before it. A
   * session writes down each request it sends, so a prompt with none after it begins no work
   * yet. Null where it was sent, or where the tail holds no request to tell by.
   */
  unsent: { last: Last | null; since: number | null } | null
}

export type Home = { cwd: string | null; branch: string | null }

// A call still without a result after this long is looked at: is it waiting on the person?
const TOOL_WAIT_MS = 20_000
// Tools of unknown pace (a connector, the web) are given longer before they read as waiting.
const OTHER_WAIT_MS = 90_000
const STALE_MS = 15 * 60_000
// These run long by design and are not approval prompts.
const SLOW_TOOLS = new Set(['Agent', 'Task', 'Workflow'])
// These finish at once when allowed, so one that sits is waiting to be allowed.
const INSTANT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'Skill'])
// These are the session asking the person something.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const TURN_END_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration'])
// The desktop app's end-of-turn box: its `ask` is a decision the session leaves to the person.
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
// A decision left unanswered this long has been passed over, and the session reads as done.
const ASK_HOLD_MS = 2 * 3600_000
// Background work whose end the transcript never records (the app quit under it) counts
// this long at most.
const TASK_MAX_MS = 4 * 3600_000
// A monitor's own expiry is announced; this much later it is taken as gone without the notice.
const EXPIRY_GRACE_MS = 2 * 60_000
// A scheduled wakeup that has not begun a turn this long after it was due is taken as gone.
const WAKE_GRACE_MS = 2 * 60_000
// A prompt the session has not sent the model this long after it came is taken as never sent.
const UNSENT_MS = 60_000

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const blocksOf = (entry: Record<string, unknown>): Record<string, unknown>[] => {
  const message = entry.message
  if (typeof message !== 'object' || message === null) {
    return []
  }
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }

  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
      )
    : []
}

const lastOf = (entry: Record<string, unknown>, at: number): Last | null => {
  if (entry.type === 'system') {
    return TURN_END_SUBTYPES.has(String(entry.subtype))
      ? { kind: 'end', tool: null, command: null, at }
      : null
  }
  if (entry.isSidechain === true) {
    return null
  }
  const blocks = blocksOf(entry)
  if (entry.type === 'assistant') {
    const call = blocks.find(block => block.type === 'tool_use')
    if (call !== undefined) {
      const input = call.input
      const command =
        call.name === 'Bash' && typeof input === 'object' && input !== null
          ? text((input as Record<string, unknown>).command)
          : null

      return { kind: 'tool', tool: text(call.name), command, at }
    }
    const stop = (entry.message as Record<string, unknown>).stop_reason
    const hasText = blocks.some(block => block.type === 'text')

    return { kind: hasText && stop === 'end_turn' ? 'end' : 'model', tool: null, command: null, at }
  }
  if (entry.type === 'user') {
    const isInterrupt = blocks.some(
      block => block.type === 'text' && String(block.text).startsWith('[Request interrupted'),
    )

    return isInterrupt
      ? { kind: 'end', tool: null, command: null, at, isInterrupt }
      : { kind: 'model', tool: null, command: null, at }
  }

  return null
}

/** Reads the end of a session transcript (JSON lines; a cut first line is skipped). */
export const readTail = (source: string): Tail => {
  const tail: Tail = {
    title: null,
    lastPrompt: null,
    ask: null,
    askCall: null,
    places: new Map(),
    entrypoint: null,
    last: null,
    since: null,
    promptId: null,
    unsent: null,
  }
  let isRecorded = false
  // The title the app shows is the one set for the session; failing that the generated one,
  // and only then a side session's short name, which the app writes beside its title.
  const titles: Record<'custom' | 'ai' | 'agent', string | null> = {
    custom: null,
    ai: null,
    agent: null,
  }
  // The shell calls still without their result, by the call's id.
  const open = new Map<string, string>()
  for (const line of source.split('\n')) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    titles.custom = text(entry.customTitle) ?? titles.custom
    titles.ai = text(entry.aiTitle) ?? titles.ai
    titles.agent = text(entry.agentName) ?? titles.agent
    tail.lastPrompt = text(entry.lastPrompt) ?? tail.lastPrompt
    const cwd = text(entry.cwd)
    if (cwd !== null) {
      const branch = text(entry.gitBranch) ?? tail.places.get(cwd) ?? null
      tail.places.delete(cwd)
      tail.places.set(cwd, branch)
    }
    tail.entrypoint = text(entry.entrypoint) ?? tail.entrypoint
    if (entry.type === 'api-request') {
      isRecorded = true
      tail.unsent = null
    }
    const isMain = entry.isSidechain !== true
    if (entry.type === 'user' && isMain) {
      tail.promptId = text(entry.promptId) ?? tail.promptId
    }
    const at = Date.parse(String(entry.timestamp))
    if (!Number.isNaN(at)) {
      // A prompt, no tool's result nor an interrupt, keeps what stood before it until a request
      // follows: a resumed session writes a background task's notice as one and may leave.
      const isPrompt =
        entry.type === 'user' &&
        isMain &&
        !blocksOf(entry).some(block => block.type === 'tool_result') &&
        lastOf(entry, at)?.kind === 'model'
      if (isPrompt && tail.unsent === null) {
        tail.unsent = { last: tail.last, since: tail.since }
      }
      // A turn starts with the person's prompt or one the session raised itself (a background
      // task's notice, a schedule). It begins the work only after a finished turn, or after one
      // left so long that it has ended unrecorded: a prompt sent mid-work joins that work.
      const isTurnStart = entry.type === 'user' && isMain && text(entry.turnOrigin) !== null
      const isAfterGap = tail.last !== null && at - tail.last.at > STALE_MS
      if (isTurnStart && (tail.since === null || isAfterGap)) {
        tail.since = at
      }
      // Each turn answers for itself: a decision asked before it is no longer the one pending.
      tail.ask = isTurnStart ? null : tail.ask
      tail.askCall = isTurnStart ? null : tail.askCall
      if (entry.type === 'assistant' && isMain) {
        const wrapUp = blocksOf(entry).find(block => block.type === 'tool_use' && block.name === WRAP_UP)
        const input = wrapUp?.input
        if (typeof input === 'object' && input !== null) {
          tail.ask = text((input as Record<string, unknown>).ask)
          tail.askCall = tail.ask === null ? null : text(wrapUp?.id)
        }
      }
      // A wrap-up that asks ends the turn at its result: nothing after it is written for the end.
      const isAskShown =
        entry.type === 'user' &&
        isMain &&
        tail.askCall !== null &&
        blocksOf(entry).some(block => block.type === 'tool_result' && block.tool_use_id === tail.askCall)
      if (isMain) {
        for (const block of blocksOf(entry)) {
          if (entry.type === 'user' && block.type === 'tool_result') {
            open.delete(String(block.tool_use_id))
          }
          const input = block.input
          const isShell = entry.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash'
          const command =
            isShell && typeof input === 'object' && input !== null
              ? text((input as Record<string, unknown>).command)
              : null
          if (command !== null) {
            open.set(text(block.id) ?? `${at}#${open.size}`, command)
          }
        }
      }
      const read: Last | null = isAskShown
        ? { kind: 'end', tool: null, command: null, at }
        : lastOf(entry, at)
      const last = read?.kind === 'tool' ? { ...read, commands: [...open.values()] } : read
      if (last?.kind === 'end') {
        open.clear()
      }
      if (last !== null) {
        // A turn's end is written twice, the answer and then its stop-hook summary: the answer's
        // time stands for both, so every reader names the end alike, whichever of the two it saw.
        const isSameEnd = last.kind === 'end' && tail.last?.kind === 'end'
        tail.last = isSameEnd ? tail.last : last.kind === 'end' ? { ...last, ask: tail.ask } : last
        tail.since = last.kind === 'end' ? null : tail.since
      }
    }
  }
  tail.title = titles.custom ?? titles.ai ?? titles.agent
  tail.unsent = isRecorded ? tail.unsent : null

  return tail
}

/**
 * The tail as it stands at `now`: a prompt the session has not sent the model a minute after it
 * came begins no work (a resume that wrote a notice and left, a window closed on a prompt), and
 * the session reads as it did before it.
 */
export const tailAt = (tail: Tail, now: number): Tail =>
  tail.unsent !== null && tail.last !== null && now - tail.last.at > UNSENT_MS
    ? { ...tail, last: tail.unsent.last, since: tail.unsent.since, unsent: null }
    : tail

export type Task = { kind: 'shell' | 'monitor' | 'agent'; at: number; until: number }

/** The background work a session started and has not heard the end of. */
export type Ledger = {
  tasks: ReadonlyMap<string, Task>
  /** A wakeup the session scheduled: when it is due, and when it was set. */
  wake: { due: number; at: number } | null
}

/**
 * The lines of a transcript a ledger is read from: a background start, a task's notice, a stop.
 * A pattern for `grep -E`, so the whole transcript need not be read.
 */
export const LEDGER_LINES =
  '"backgroundTaskId":"|"taskId":"|"isAsync":true|"scheduledFor":|task-notification|"task_id":"'

// A notice that a task has ended: a status other than running, or a monitor's expiry.
const ENDED = new RegExp(
  '<task-id>([^<]+)</task-id>' +
    '(?:\\s*<(?:tool-use-id|output-file)>[^<]*</(?:tool-use-id|output-file)>)*' +
    '\\s*(?:<status>(?!running)[a-z_]+</status>|<summary>[^<]*</summary>\\s*<event>\\[Monitor expired)',
  'g',
)

/** The text of a task notification an entry carries: queued, delivered as a prompt, or absorbed. */
const noticeOf = (entry: Record<string, unknown>): string | null => {
  const isNotice = (value: string | null): value is string =>
    value !== null && value.trimStart().startsWith('<task-notification>')
  if (entry.type === 'queue-operation') {
    const content = text(entry.content)

    return isNotice(content) ? content : null
  }
  if (entry.type === 'attachment') {
    const attachment = entry.attachment
    const prompt =
      typeof attachment === 'object' && attachment !== null
        ? text((attachment as Record<string, unknown>).prompt)
        : null

    return isNotice(prompt) ? prompt : null
  }
  if (entry.type === 'user') {
    const notices = blocksOf(entry)
      .map(block => (block.type === 'text' ? text(block.text) : null))
      .filter(isNotice)

    return notices.length === 0 ? null : notices.join('\n')
  }

  return null
}

/**
 * Reads, from a transcript's ledger lines, each background task it started (a shell command, a
 * monitor, an async subagent) and has not been notified the end of, and a wakeup not yet due.
 */
export const ledgerOf = (source: string): Ledger => {
  const tasks = new Map<string, Task>()
  let wake: Ledger['wake'] = null
  for (const line of source.split('\n')) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null || entry.isSidechain === true) {
      continue
    }
    const at = Date.parse(String(entry.timestamp))
    const result = entry.toolUseResult
    if (typeof result === 'object' && result !== null && !Number.isNaN(at)) {
      const r = result as Record<string, unknown>
      const shell = text(r.backgroundTaskId)
      if (shell !== null) {
        tasks.set(shell, { kind: 'shell', at, until: at + TASK_MAX_MS })
      }
      const monitor = text(r.taskId)
      if (monitor !== null && typeof r.persistent === 'boolean') {
        const span =
          typeof r.timeoutMs === 'number' && !r.persistent ? r.timeoutMs + EXPIRY_GRACE_MS : TASK_MAX_MS
        tasks.set(monitor, { kind: 'monitor', at, until: at + span })
      }
      const agent = r.isAsync === true ? text(r.agentId) : null
      if (agent !== null) {
        tasks.set(agent, { kind: 'agent', at, until: at + TASK_MAX_MS })
      }
      if (typeof r.scheduledFor === 'number') {
        wake = { due: r.scheduledFor, at }
      }
      const stopped = text(r.task_id)
      if (stopped !== null && String(r.message).startsWith('Successfully stopped')) {
        tasks.delete(stopped)
      }
    }
    for (const match of (noticeOf(entry) ?? '').matchAll(ENDED)) {
      tasks.delete(match[1] ?? '')
    }
    // The wakeup came: the turn it began is under way, or over.
    const isTurnStart = entry.type === 'user' && text(entry.turnOrigin) !== null
    if (wake !== null && isTurnStart && at >= wake.due - WAKE_GRACE_MS) {
      wake = null
    }
  }

  return { tasks, wake }
}

/** What of a ledger is still under way now; null where nothing is. */
export const pendingOf = (ledger: Ledger | null, now: number): Pending | null => {
  if (ledger === null) {
    return null
  }
  const open = [...ledger.tasks.values()].filter(task => task.until > now)
  const wake = ledger.wake !== null && ledger.wake.due + WAKE_GRACE_MS > now ? ledger.wake : null
  if (open.length === 0 && wake === null) {
    return null
  }
  const count = (kind: Task['kind']) => open.filter(task => task.kind === kind).length

  return {
    shells: count('shell'),
    monitors: count('monitor'),
    agents: count('agent'),
    sessions: 0,
    wake: wake?.due ?? null,
    since: Math.min(...open.map(task => task.at), wake?.at ?? Number.POSITIVE_INFINITY),
  }
}

/**
 * A stretch of a shell command that survives the quoting a shell wrapper adds, long enough to
 * find the command among the running processes by; null where the command has none. Only
 * printable ASCII: `ps` writes each byte beyond it as `M-…` where no locale is set, as in the
 * desktop app, so a Korean comment would never be found.
 */
export const probeOf = (command: string): string | null => {
  const longest = command
    .split(/['"\\]|[^\x20-\x7e]/)
    .map(piece => piece.trim())
    .reduce((best, piece) => (piece.length > best.length ? piece : best), '')

  return longest.length >= 8 ? longest.slice(0, 80) : null
}

/**
 * The probes of the shell commands a call that has sat long enough may be waiting on, its own
 * among them; null where there are none, or one has no probe and so could not be found.
 */
export const pendingShell = (last: Last | null, now: number): string[] | null => {
  if (last === null || last.kind !== 'tool' || now - last.at <= TOOL_WAIT_MS) {
    return null
  }
  const commands = last.commands ?? (last.command === null ? [] : [last.command])
  const probes = commands.map(probeOf)

  return probes.length > 0 && probes.every((probe): probe is string => probe !== null) ? probes : null
}

/** Whether a finished turn left the person a decision, not yet passed over. */
const isDecision = (last: Last, now: number): boolean =>
  last.kind === 'end' && (last.ask ?? null) !== null && now - last.at < ASK_HOLD_MS

/**
 * Whether the session is asking the person, by a question or plan it waits on or a decision its
 * turn ended on: a wait known at once, not guessed.
 */
export const isAsking = (last: Last | null): boolean =>
  last !== null &&
  ((last.kind === 'tool' && ASKING_TOOLS.has(last.tool ?? '')) ||
    (last.kind === 'end' && (last.ask ?? null) !== null))

/**
 * `isRunning` says whether the process of a pending shell call, or of one the call waits its turn
 * behind, was found: only a shell call known not to be running reads as waiting on the person,
 * and one that could not be told reads as busy.
 * `pending` is the background work a finished turn left running: the session is not done until
 * it ends, as each end wakes the session again.
 */
export const stateOf = (
  last: Last | null,
  now: number,
  isRunning?: boolean,
  pending: Pending | null = null,
): RowState => {
  if (last === null) {
    return 'done'
  }
  if (last.kind === 'end') {
    return isDecision(last, now) ? 'waiting' : pending !== null ? 'background' : 'done'
  }
  const age = now - last.at
  const tool = last.tool ?? ''
  if (isAsking(last)) {
    return 'waiting'
  }
  if (age > STALE_MS) {
    return 'stale'
  }
  if (last.kind === 'model') {
    return 'working'
  }
  // A call of the same reply as a shell command still running waits its turn, not the person.
  if (SLOW_TOOLS.has(tool) || isRunning === true) {
    return 'tool'
  }
  if (last.command !== null) {
    return age > TOOL_WAIT_MS && isRunning === false ? 'waiting' : 'tool'
  }

  return age > (INSTANT_TOOLS.has(tool) ? TOOL_WAIT_MS : OTHER_WAIT_MS) ? 'waiting' : 'tool'
}

// The engine names a transcript's folder after the directory its session started in, with each
// character that is not a letter or a digit written as a dash.
const folderOf = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-')

export const folderIn = (path: string): string => path.split('/').slice(-2, -1)[0] ?? ''

// How many directories one search of the disk for a transcript folder's directory may list.
const MAX_LOOKS = 40

/** A directory and each one above it, the nearest first. */
const upFrom = (dir: string): string[] => {
  const parts = dir.split('/')

  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/')).filter(Boolean)
}

/**
 * The directory a session belongs to among the places its shell has been, or above them: not
 * where the shell last stood, as a `cd` into another project moves every entry after it there,
 * but the one the transcript's folder is named after. Null where the tail holds no such place.
 */
export const homeAmong = (path: string, places: ReadonlyMap<string, string | null>): Home | null => {
  const folder = folderIn(path)
  for (const place of [...places.keys()].reverse()) {
    const home = upFrom(place).find(dir => folderOf(dir) === folder)
    if (home !== undefined) {
      // A place beneath the session's own directory (a package, a worktree) lends its branch.
      return { cwd: home, branch: places.get(place) ?? null }
    }
  }

  return null
}

/** A session's directory where the tail holds it, else where its shell last stood. */
export const homeOf = (path: string, places: ReadonlyMap<string, string | null>): Home => {
  const home = homeAmong(path, places)
  if (home !== null) {
    return home
  }
  const last = [...places.keys()].pop()

  return { cwd: last ?? null, branch: last === undefined ? null : (places.get(last) ?? null) }
}

/**
 * The directory a transcript folder is named after, found on disk: the name keeps none of the
 * slashes, dots or underscores it was written from, so each step down takes a subdirectory
 * whose name, written the same way, begins what is left, the longest first. `list` gives a
 * directory's subdirectory names. Null where none fits, as for a project moved since.
 */
export const findHome = async (
  folder: string,
  list: (dir: string) => Promise<readonly string[]>,
): Promise<string | null> => {
  let looks = 0
  const walk = async (dir: string, rest: string): Promise<string | null> => {
    looks += 1
    if (looks > MAX_LOOKS) {
      return null
    }
    const fits = (await list(dir))
      .filter(name => rest === folderOf(name) || rest.startsWith(`${folderOf(name)}-`))
      .sort((a, b) => b.length - a.length)
    for (const name of fits) {
      const path = `${dir.replace(/\/$/, '')}/${name}`
      const found = rest === folderOf(name) ? path : await walk(path, rest.slice(name.length + 1))
      if (found !== null) {
        return found
      }
    }

    return null
  }

  return folder.startsWith('-') ? walk('/', folder.slice(1)) : null
}

// Where the desktop app puts a side session's or a worktree session's checkout.
const WORKTREE = /^(.+)\/\.claude\/worktrees\/([^/]+)/

/** The project a directory belongs to, and the worktree it is, where it is one. */
export const placeOf = (cwd: string | null): { root: string | null; worktree: string | null } => {
  const match = cwd === null ? null : WORKTREE.exec(cwd)

  return { root: match?.[1] ?? cwd, worktree: match?.[2] ?? null }
}

const SOURCES: Record<string, string> = {
  'claude-desktop': 'desktop',
  'claude-vscode': 'VS Code',
  cli: 'terminal',
}

export const rowOf = (
  path: string,
  tail: Tail,
  mtimeMs: number,
  now: number,
  self: string,
  isRunning?: boolean,
  home: Home = homeOf(path, tail.places),
  pending: Pending | null = null,
): Row => {
  const id = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path
  const folder = folderIn(path).replace(/--claude-worktrees-.*$/, '')
  const entrypoint = tail.entrypoint ?? ''
  const { root, worktree } = placeOf(home.cwd)
  const branch = home.branch === 'HEAD' ? null : home.branch
  const { last } = tail

  return {
    id,
    project: root?.split('/').filter(Boolean).pop() ?? folder.split('-').pop() ?? folder,
    cwd: home.cwd,
    // The branch the app names after a worktree says nothing the worktree does not.
    branch: worktree !== null && branch === `claude/${worktree}` ? null : branch,
    worktree,
    parent: null,
    parentId: null,
    title: (tail.title ?? tail.lastPrompt ?? '').replace(/\s+/g, ' ').trim(),
    source: SOURCES[entrypoint] ?? entrypoint.replace(/^claude-/, ''),
    state: stateOf(last, now, isRunning, pending),
    tool: last?.tool ?? null,
    at: last?.at ?? mtimeMs,
    since: tail.since,
    ask: last?.kind === 'end' ? (last.ask ?? null) : null,
    pending,
    isInterrupted: last?.isInterrupt === true,
    isSelf: id === self,
  }
}

/** Whether a session is at work: its turn under way, or work it left running in the background. */
const isAtWork = (row: Row): boolean =>
  row.state === 'working' ||
  row.state === 'tool' ||
  row.state === 'background' ||
  (row.state === 'waiting' && row.ask === null)

/**
 * Joins each session to the one that started it (`parentOf` names a session's starter, by id):
 * a starter whose own turn is over while a session it started is still at work, itself or
 * through the ones it started in turn, is not done but waits in the background, as the app
 * wakes it each time one of them ends a turn; a started one carries its starter's title.
 */
export const linkRows = (rows: readonly Row[], parentOf: (id: string) => string | null): Row[] => {
  const titles = new Map(rows.map(row => [row.id, row.title]))
  const started = (id: string) => rows.filter(other => parentOf(other.id) === id)
  const atWork = new Map<string, boolean>()
  const isFamilyAtWork = (row: Row, seen: ReadonlySet<string>): boolean => {
    const known = atWork.get(row.id)
    if (known !== undefined) {
      return known
    }
    const inner = new Set([...seen, row.id])
    const is =
      isAtWork(row) ||
      started(row.id).some(other => !inner.has(other.id) && isFamilyAtWork(other, inner))
    atWork.set(row.id, is)

    return is
  }

  return rows.map(row => {
    const starter = parentOf(row.id)
    const parentId = starter !== null && titles.has(starter) ? starter : null
    const parent = parentId === null ? null : titles.get(parentId) || null
    const sessions = started(row.id).filter(other => isFamilyAtWork(other, new Set([row.id]))).length
    if (sessions === 0) {
      return { ...row, parent, parentId }
    }
    const pending = {
      shells: 0,
      monitors: 0,
      agents: 0,
      wake: null,
      ...row.pending,
      sessions,
      since: Math.min(row.pending?.since ?? row.at, row.at),
    }

    return {
      ...row,
      parent,
      parentId,
      pending,
      state: row.state === 'done' ? 'background' : row.state,
    }
  })
}

const RANK: Record<RowState, number> = {
  waiting: 0,
  tool: 1,
  working: 1,
  background: 2,
  done: 3,
  stale: 4,
}

/** Sessions that may need the person first, then the busy ones, then the finished, newest first. */
export const order = (rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at)

export const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`
  }

  return `${Math.floor(seconds / 86_400)}d`
}
