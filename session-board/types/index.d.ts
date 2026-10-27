export type RowState = 'working' | 'tool' | 'waiting' | 'background' | 'done' | 'stale'

/** What a finished turn left running, by which the session is not done yet. */
export type Pending = {
  shells: number
  monitors: number
  agents: number
  /** Sessions this one started that are still at work; it resumes when they end. */
  sessions: number
  /** When a wakeup the session scheduled is due, if one is. */
  wake: number | null
  /** When the oldest of that work began. */
  since: number
}

export type Row = {
  id: string
  project: string
  cwd: string | null
  branch: string | null
  /** The worktree's own name, where the session runs in one. */
  worktree: string | null
  /** The title of the session that started this one, where that one is listed. */
  parent: string | null
  title: string
  source: string
  state: RowState
  tool: string | null
  at: number
  /** When the work under way began, where it is known. */
  since: number | null
  /** The decision the last turn's wrap-up put to the person. */
  ask: string | null
  pending: Pending | null
  /** The last turn ended because the person interrupted it. */
  isInterrupted: boolean
  isSelf: boolean
}

export type Board = {
  rows: Row[]
  now: number
  /** The ids of the finished rows whose cards stay up until the person opens or dismisses them. */
  unseen: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { board: Board }
  }
}
