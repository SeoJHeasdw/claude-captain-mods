export type Info = {
  project: string
  branch: string | null
  dirty: number
}

/** What the session's last model request says of the prompt cache. */
export type Cache = {
  at: number
  ttlMinutes: number
  hitPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    devline: {
      info: Info | null
      cache: Cache | null
      nowAt: number
      isBandOn: boolean
      isRowsOn: boolean
    }
  }
}
