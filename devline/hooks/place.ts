// Where the desktop app puts a side session's or a worktree session's checkout.
const WORKTREE = /^(.+)\/\.claude\/worktrees\/([^/]+)/

/**
 * The project a directory belongs to, and the branch to show: in an app worktree the project
 * is the repository's, and the branch the app named after the worktree reads as the worktree.
 */
export const placeOf = (cwd: string, branch: string | null): { project: string; branch: string | null } => {
  const match = WORKTREE.exec(cwd)
  const root = match?.[1] ?? cwd
  const worktree = match?.[2] ?? null

  return {
    project: root.split('/').filter(Boolean).pop() ?? root,
    branch: worktree !== null && (branch === null || branch === `claude/${worktree}`) ? '워크트리' : branch,
  }
}
