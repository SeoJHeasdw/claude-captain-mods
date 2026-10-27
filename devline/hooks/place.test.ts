import { expect, test } from 'claude-code/testing'

import { placeOf } from './place'

test('in an app worktree the band names the repository, and the branch named after the worktree as the worktree', () => {
  expect(placeOf('/w/local-assets-engine/.claude/worktrees/happy-davinci-5c2ed9', 'claude/happy-davinci-5c2ed9')).toEqual({
    project: 'local-assets-engine',
    branch: '워크트리',
  })
  expect(placeOf('/w/local-assets-engine/.claude/worktrees/happy-davinci-5c2ed9', 'feat/vae')).toEqual({
    project: 'local-assets-engine',
    branch: 'feat/vae',
  })
  expect(placeOf('/w/money', 'main')).toEqual({ project: 'money', branch: 'main' })
})
