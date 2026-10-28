import { expect, test } from 'claude-code/testing'

import type { Row, RowState } from '../types'
import {
  LEDGER_LINES,
  ago,
  findHome,
  ledgerOf,
  linkRows,
  order,
  pendingOf,
  pendingShell,
  probeOf,
  readTail,
  rowOf,
  stateOf,
  tailAt,
} from './parse'

const AT = Date.parse('2026-10-13T07:40:00.000Z')
const STAMP = '2026-10-13T07:40:00.000Z'

const lines = (...entries: object[]): string => entries.map(entry => JSON.stringify(entry)).join('\n')

const META = { cwd: '/Users/me/work/money', gitBranch: 'main', entrypoint: 'claude-vscode' }

test('a transcript ending in a final answer reads as done, with its title and project', () => {
  const tail = readTail(
    lines(
      { type: 'user', timestamp: STAMP, message: { content: 'fix it' }, ...META },
      { type: 'ai-title', aiTitle: 'Fix  the\nparser' },
      {
        type: 'assistant',
        timestamp: STAMP,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
        ...META,
      },
      { type: 'cost-state', totalCostUSD: 1 },
    ),
  )
  const row = rowOf('/h/.claude/projects/-Users-me-work-money/abc.jsonl', tail, 0, AT + 5000, 'abc')

  expect(row.state).toBe('done')
  expect(row.project).toBe('money')
  expect(row.cwd).toBe('/Users/me/work/money')
  expect(row.branch).toBe('main')
  expect(row.title).toBe('Fix the parser')
  expect(row.source).toBe('VS Code')
  expect(row.isSelf).toBe(true)
})

const entry = (cwd: string, gitBranch: string) => ({
  type: 'user',
  timestamp: STAMP,
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
  cwd,
  gitBranch,
  entrypoint: 'claude-vscode',
})

const rowIn = (folder: string, ...entries: object[]): Row =>
  rowOf(`/h/.claude/projects/${folder}/abc.jsonl`, readTail(lines(...entries)), 0, AT, '')

test('a session whose shell moved into another project is still listed under its own', () => {
  const row = rowIn(
    '-Users-me-javis-fooAgent',
    entry('/Users/me/javis/fooAgent', 'main'),
    entry('/Users/me/javis/local-assets-engine', 'contract'),
    entry('/Users/me/javis/local-assets-engine', 'contract'),
  )

  expect(row.project).toBe('fooAgent')
  expect(row.cwd).toBe('/Users/me/javis/fooAgent')
  expect(row.branch).toBe('main')
})

test('a place beneath the session directory names that directory, with the branch read there', () => {
  const row = rowIn(
    '-Users-me-javis-rice',
    entry('/Users/me/javis/rice', 'main'),
    entry('/Users/me/javis/rice/.claude/worktrees/fix', 'fix'),
  )

  expect(row.project).toBe('rice')
  expect(row.cwd).toBe('/Users/me/javis/rice')
  expect(row.branch).toBe('fix')
})

const disk =
  (tree: Record<string, string[]>) =>
  async (dir: string): Promise<string[]> =>
    tree[dir] ?? []

test('a transcript folder is found on disk with the underscores, dots and slashes its name lost', async () => {
  const list = disk({
    '/': ['Users', 'tmp'],
    '/Users': ['me'],
    '/Users/me': ['edu', 'edu-old', 'javis'],
    '/Users/me/edu': ['acme', 'acme_co'],
    '/Users/me/javis': ['rice', 'local-tts-engine'],
    '/Users/me/javis/rice': ['.claude'],
    '/Users/me/javis/rice/.claude': ['worktrees'],
    '/Users/me/javis/rice/.claude/worktrees': ['fix_1'],
  })

  expect(await findHome('-Users-me-edu-acme-co', list)).toBe('/Users/me/edu/acme_co')
  expect(await findHome('-Users-me-javis-local-tts-engine', list)).toBe('/Users/me/javis/local-tts-engine')
  expect(await findHome('-Users-me-javis-rice--claude-worktrees-fix-1', list)).toBe(
    '/Users/me/javis/rice/.claude/worktrees/fix_1',
  )
  expect(await findHome('-Users-me-javis-fooAgent', list)).toBeNull()
})

test('a name that begins the folder but leads nowhere gives way to a shorter one', async () => {
  const list = disk({ '/': ['w'], '/w': ['a', 'a.b'], '/w/a.b': [], '/w/a': ['b_c'] })

  expect(await findHome('-w-a-b-c', list)).toBe('/w/a/b_c')
})

test('a transcript folder no place accounts for leaves the row where the shell last stood', () => {
  const row = rowIn('-somewhere-else', entry('/Users/me/money', 'main'), entry('/tmp/scratch', 'HEAD'))

  expect(row.project).toBe('scratch')
  expect(row.cwd).toBe('/tmp/scratch')
  expect(row.branch).toBeNull()
})

const at = (seconds: number): string => new Date(AT + seconds * 1000).toISOString()

const prompt = (seconds: number, promptId: string, turnOrigin = 'human') => ({
  type: 'user',
  timestamp: at(seconds),
  promptId,
  turnOrigin,
  message: { content: 'go' },
})

const call = (seconds: number) => ({
  type: 'assistant',
  timestamp: at(seconds),
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
})

const result = (seconds: number, promptId: string) => ({
  type: 'user',
  timestamp: at(seconds),
  promptId,
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
})

const turnEnd = (seconds: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: at(seconds) })

test('a busy session counts from the prompt that began its work, not from its latest step', () => {
  const tail = readTail(lines(prompt(0, 'p1'), call(10), result(20, 'p1'), call(200)))

  expect(tail.since).toBe(AT)
  expect(rowOf('/p/-x/a.jsonl', tail, 0, AT + 205_000, '').since).toBe(AT)
})

test('a prompt sent mid-work joins that work; one after a finished turn or a long silence begins new work', () => {
  const midWork = readTail(lines(prompt(0, 'p1'), call(10), prompt(30, 'p2'), call(40)))
  const afterEnd = readTail(
    lines(prompt(0, 'p1'), call(10), turnEnd(20), prompt(60, 'p2', 'task_notification'), call(70)),
  )
  const afterSilence = readTail(lines(prompt(0, 'p1'), call(10), prompt(3600, 'p2'), call(3610)))

  expect(midWork.since).toBe(AT)
  expect(afterEnd.since).toBe(AT + 60_000)
  expect(afterSilence.since).toBe(AT + 3_600_000)
})

const request = (seconds: number) => ({ type: 'api-request', timestamp: at(seconds), querySource: 'sdk' })

// What a resumed session writes for a background command the process before it left running.
const resumeNotice = (seconds: number) => ({
  type: 'user',
  timestamp: at(seconds),
  promptId: 'p2',
  origin: { kind: 'task-notification' },
  message: { content: '<task-notification>\n<status>stopped</status>\n</task-notification>' },
})

test('a prompt the session never sends, as a resume writes a notice and leaves, is no work a minute on', () => {
  const resumed = readTail(
    lines(prompt(0, 'p1'), request(1), call(10), request(11), turnEnd(20), resumeNotice(600)),
  )
  const sent = readTail(
    lines(prompt(0, 'p1'), request(1), call(10), request(11), turnEnd(20), resumeNotice(600), request(601)),
  )

  // A request takes a moment to go out: within the minute the prompt reads as work begun.
  expect(stateOf(tailAt(resumed, AT + 630_000).last, AT + 630_000)).toBe('working')
  const later = tailAt(resumed, AT + 700_000)
  expect(stateOf(later.last, AT + 700_000)).toBe('done')
  expect(later.since).toBeNull()
  expect(rowOf('/p/-x/a.jsonl', later, 0, AT + 700_000, '').at).toBe(AT + 20_000)
  // A prompt sent is work under way however quiet it goes, until the transcript is stale.
  expect(stateOf(tailAt(sent, AT + 700_000).last, AT + 700_000)).toBe('working')
})

test('a transcript that records no requests cannot tell an unsent prompt, and reads as before', () => {
  const tail = readTail(lines(prompt(0, 'p1'), call(10), turnEnd(20), resumeNotice(600)))

  expect(tail.unsent).toBeNull()
  expect(stateOf(tailAt(tail, AT + 700_000).last, AT + 700_000)).toBe('working')
})

test('a tail that begins mid-work knows no start but names the prompt to look for; a finished turn has none', () => {
  const tail = readTail(lines(result(0, 'p7'), call(10)))

  expect(tail.since).toBeNull()
  expect(tail.promptId).toBe('p7')
  expect(readTail(lines(prompt(0, 'p1'), call(10), turnEnd(20))).since).toBeNull()
})

const pending = (name: string, input: object = {}) =>
  readTail(
    lines({
      type: 'assistant',
      timestamp: STAMP,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] },
    }),
  ).last

test('a shell call that sits waits on the person only when its process is not running', () => {
  const last = pending('Bash', { command: 'python3 -m tracker refresh 123456 --run' })

  expect(last?.tool).toBe('Bash')
  expect(stateOf(last, AT + 3000, false)).toBe('tool')
  expect(stateOf(last, AT + 120_000, true)).toBe('tool')
  expect(stateOf(last, AT + 120_000)).toBe('tool')
  expect(stateOf(last, AT + 120_000, false)).toBe('waiting')
  expect(stateOf(last, AT + 3_600_000, false)).toBe('stale')
})

test('an edit that sits is waiting to be allowed, a connector call is given longer, a question waits at once', () => {
  expect(stateOf(pending('Edit'), AT + 5000)).toBe('tool')
  expect(stateOf(pending('Edit'), AT + 30_000)).toBe('waiting')
  expect(stateOf(pending('mcp__sheets__get_values'), AT + 60_000)).toBe('tool')
  expect(stateOf(pending('mcp__sheets__get_values'), AT + 100_000)).toBe('waiting')
  expect(stateOf(pending('AskUserQuestion'), AT + 1000)).toBe('waiting')
  expect(stateOf(pending('AskUserQuestion'), AT + 3_600_000)).toBe('waiting')
})

test('a long subagent call is never reported as waiting', () => {
  expect(stateOf(pending('Agent'), AT + 120_000)).toBe('tool')
})

test('the probe is a stretch of the command no shell quoting touches, looked for only once the call has sat', () => {
  const command = `S=/tmp/x\npython3 -m tracker refresh 123456 --run 2>&1 | grep -E '"task"|"st"'`
  const last = pending('Bash', { command })

  expect(probeOf(command)).toBe('python3 -m tracker refresh 123456 --run 2>&1 | grep -E')
  expect(probeOf(`ls 'a'`)).toBeNull()
  expect(pendingShell(last, AT + 5000)).toBeNull()
  expect(pendingShell(last, AT + 30_000)).toEqual(['python3 -m tracker refresh 123456 --run 2>&1 | grep -E'])
  expect(pendingShell(pending('Edit'), AT + 30_000)).toBeNull()
})

test('the probe is printable ASCII, as ps escapes the rest where no locale is set: a Korean comment is passed over', () => {
  // The longest stretch was this comment, ps wrote it as `M-…`,
  // and the board called the person over a heredoc still running.
  const command = [
    `python3 - <<'EOF'`,
    `p='src/projects/sections/ch02/03-s03.1-intro-scene.ts'`,
    `# 장면 하나를 아래로 이어 붙이고 그 대사에서 화면이 내려간다: 80%(0~3) → 이유(4~7) → 정리`,
    `open(p,'w').write(open(p).read().replace('steps: 11','steps: 9'))`,
    'EOF',
  ].join('\n')

  expect(probeOf(command)).toBe('src/projects/sections/ch02/03-s03.1-intro-scene.ts')
  expect(probeOf('echo "ℹ tests"\tfail')).toBeNull()
})

const shellCall = (seconds: number, id: string, name: string, input: object) => ({
  type: 'assistant',
  timestamp: at(seconds),
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
})

const shellResult = (seconds: number, id: string) => ({
  type: 'user',
  timestamp: at(seconds),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

test('a call queued behind a shell command of the same reply is looked for by that command too', () => {
  // Two shell calls in one reply run one after another;
  // the board looked only for the second, not yet begun, and called the person.
  const build = 'npx vite build 2>&1 | tail -4'
  const tests = 'node --test --test-concurrency=2 tools/*.test.mjs 2>&1 | grep -E'
  const both = readTail(
    lines(prompt(0, 'p1'), shellCall(1, 'b', 'Bash', { command: build }), shellCall(2, 't', 'Bash', { command: tests })),
  ).last

  expect(both?.commands).toEqual([build, tests])
  expect(pendingShell(both, AT + 30_000)).toEqual([build, tests])
  expect(stateOf(both, AT + 30_000, true)).toBe('tool')
  expect(stateOf(both, AT + 30_000, false)).toBe('waiting')

  // An edit queued behind a running command waits its turn too, not the person.
  const edit = readTail(
    lines(prompt(0, 'p1'), shellCall(1, 'b', 'Bash', { command: build }), shellCall(2, 'e', 'Edit', {})),
  ).last
  expect(pendingShell(edit, AT + 30_000)).toEqual([build])
  expect(stateOf(edit, AT + 30_000, true)).toBe('tool')
  expect(stateOf(edit, AT + 30_000)).toBe('waiting')

  // Each result takes its command off; a turn's end takes off any left without one.
  const second = readTail(
    lines(
      prompt(0, 'p1'),
      shellCall(1, 'b', 'Bash', { command: build }),
      shellCall(2, 't', 'Bash', { command: tests }),
      shellResult(40, 'b'),
      shellCall(45, 'x', 'Read', {}),
    ),
  ).last
  expect(second?.commands).toEqual([tests])
  const after = readTail(
    lines(
      prompt(0, 'p1'),
      shellCall(1, 'b', 'Bash', { command: build }),
      { type: 'user', timestamp: at(5), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      prompt(10, 'p2'),
      shellCall(11, 't', 'Bash', { command: tests }),
    ),
  ).last
  expect(after?.commands).toEqual([tests])
})

test('a tool result or a prompt means the model is working; subagent rows and a cut line are ignored', () => {
  const tail = readTail(
    `{"type":"assistant","timestamp":"${STAMP}","mess\n` +
      lines(
        {
          type: 'user',
          timestamp: STAMP,
          message: { content: [{ type: 'tool_result', content: 'ok' }] },
        },
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: STAMP,
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'sub' }] },
        },
      ),
  )

  expect(stateOf(tail.last, AT + 1000)).toBe('working')
})

test('an interrupt and a stop-hook summary both end the turn', () => {
  const interrupted = readTail(
    lines({
      type: 'user',
      timestamp: STAMP,
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }),
  )
  const summarized = readTail(
    lines(
      { type: 'user', timestamp: STAMP, message: { content: 'go' } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: STAMP },
    ),
  )

  expect(stateOf(interrupted.last, AT)).toBe('done')
  expect(stateOf(summarized.last, AT)).toBe('done')
})

test('a turn end written twice, the answer then its stop-hook summary, is named by the answer either way', () => {
  // Two copies of the board read the end on either side of the
  // summary, written 0.2 s after the answer, and raised two banners under two names.
  const answer = {
    type: 'assistant',
    timestamp: at(10.915),
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '세 가지 중 하나는 그대로 두시고' }] },
  }
  const summary = { type: 'system', subtype: 'stop_hook_summary', timestamp: at(11.122) }
  const before = readTail(lines(prompt(0, 'p1'), answer))
  const after = readTail(lines(prompt(0, 'p1'), answer, { type: 'last-prompt', lastPrompt: 'go' }, summary))

  expect(after.last?.at).toBe(AT + 10_915)
  expect(after.last?.at).toBe(before.last?.at)
  // The next turn's end is its own.
  expect(readTail(lines(prompt(0, 'p1'), answer, summary, prompt(60, 'p2'), turnEnd(90))).last?.at).toBe(
    AT + 90_000,
  )
})

test('waiting sessions sort first, then busy ones, then finished, newest first', () => {
  const row = (id: string, state: RowState, at: number): Row => ({
    ...rowOf(`/p/x/${id}.jsonl`, readTail(''), 0, 0, ''),
    state,
    at,
  })
  const sorted = order([
    row('d1', 'done', 5),
    row('w', 'working', 1),
    row('d2', 'done', 9),
    row('a', 'waiting', 0),
  ])

  expect(sorted.map(one => one.id)).toEqual(['a', 'w', 'd2', 'd1'])
})

test('elapsed time is spelled in the largest whole unit', () => {
  expect(ago(12_000)).toBe('12s')
  expect(ago(3 * 60_000 + 5000)).toBe('3m')
  expect(ago(2 * 3_600_000)).toBe('2h')
  expect(ago(4 * 86_400_000)).toBe('4d')
})

const stampAt = (seconds: number) => new Date(AT + seconds * 1000).toISOString()

const notice = (id: string, rest: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n${rest}\n</task-notification>`

const started = (seconds: number, toolUseResult: object) => ({
  type: 'user',
  timestamp: at(seconds),
  message: { content: [{ type: 'tool_result', content: 'started' }] },
  toolUseResult,
})

test('a ledger keeps each background task until its notice, a stop or its expiry', () => {
  const ledger = ledgerOf(
    lines(
      started(0, { backgroundTaskId: 'bsh1' }),
      started(1, { backgroundTaskId: 'bsh2', timedOutAfterMs: 120000 }),
      started(2, { taskId: 'bmon1', timeoutMs: 900_000, persistent: false }),
      started(3, { taskId: 'bmon2', timeoutMs: 1_800_000, persistent: false }),
      started(4, { isAsync: true, status: 'async_launched', agentId: 'a1' }),
      // A monitor event is no end; a status, a monitor's expiry or a stop is.
      { type: 'user', timestamp: stampAt(10), turnOrigin: 'task_notification', message: { content: notice('bmon1', '<summary>Monitor event: "job"</summary>\n<event>running</event>') } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: stampAt(20), content: notice('bsh1', '<tool-use-id>t</tool-use-id>\n<output-file>/o</output-file>\n<status>completed</status>') },
      { type: 'user', timestamp: stampAt(30), turnOrigin: 'task_notification', message: { content: notice('bmon2', '<summary>Monitor event: "job"</summary>\n<event>[Monitor expired after 30m with 2 events delivered.') } },
      { type: 'user', timestamp: stampAt(40), message: { content: [{ type: 'tool_result', content: 'stopped' }] }, toolUseResult: { message: 'Successfully stopped task: bsh2 (sleep)', task_id: 'bsh2' } },
      // A notice quoted inside a tool's output ends nothing.
      { type: 'user', timestamp: stampAt(50), message: { content: [{ type: 'tool_result', content: notice('a1', '<status>completed</status>') }] } },
    ),
  )

  expect([...ledger.tasks.keys()]).toEqual(['bmon1', 'a1'])
  expect(pendingOf(ledger, AT + 60_000)).toEqual({
    shells: 0,
    monitors: 1,
    agents: 1,
    sessions: 0,
    wake: null,
    since: AT + 2000,
  })
  // A monitor past its own time and the grace after it is gone, noticed or not.
  expect(pendingOf(ledger, AT + 2000 + 900_000 + 120_001)?.monitors).toBe(0)
  // Work never heard of again is let go after hours.
  expect(pendingOf(ledger, AT + 5 * 3600_000)).toBeNull()
})

test('a subagent sent back to work by a message is at work again until the end of that run', () => {
  const resumed = {
    type: 'user',
    timestamp: stampAt(120),
    message: { content: [{ type: 'tool_result', content: 'Resuming agent a1' }] },
    toolUseResult: { success: true, message: 'Resuming agent a1', resumedAgentId: 'a1', revivedAgentId: 'a1' },
  }
  const ended = (seconds: number) => ({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: stampAt(seconds),
    content: notice('a1', '<tool-use-id>t</tool-use-id>\n<output-file>/o</output-file>\n<status>completed</status>'),
  })
  const before = [started(0, { isAsync: true, status: 'async_launched', agentId: 'a1' }), ended(60)]
  // The grep that feeds the ledger keeps the line that resumes it.
  expect(new RegExp(LEDGER_LINES).test(JSON.stringify(resumed))).toBe(true)
  expect(ledgerOf(lines(...before)).tasks.size).toBe(0)

  // Resumed, it counts again from the message; the first run's notice, written late under its
  // own time, does not end the second.
  const again = ledgerOf(lines(...before, resumed, ended(60)))
  expect(pendingOf(again, AT + 180_000)).toEqual({
    shells: 0,
    monitors: 0,
    agents: 1,
    sessions: 0,
    wake: null,
    since: AT + 120_000,
  })
  // Read on from where the last read stopped, its own end lets it go.
  expect(ledgerOf(lines(ended(300)), again).tasks.size).toBe(0)
  // A message that could not resume it sends nothing back to work.
  const failed = { ...resumed, toolUseResult: { success: false, resumedAgentId: 'a1' } }
  expect(ledgerOf(lines(...before, failed)).tasks.size).toBe(0)
})

test('a scheduled wakeup is pending until the turn it begins', () => {
  const due = AT + 600_000
  const set = ledgerOf(lines(started(0, { scheduledFor: due, clampedDelaySeconds: 600, wasClamped: false })))

  expect(pendingOf(set, AT + 60_000)?.wake).toBe(due)
  const woke = ledgerOf(
    lines(
      started(0, { scheduledFor: due, clampedDelaySeconds: 600, wasClamped: false }),
      { type: 'user', timestamp: stampAt(600), turnOrigin: 'scheduled', message: { content: 'wake' } },
    ),
  )
  expect(pendingOf(woke, AT + 601_000)).toBeNull()
})

test('a finished turn with background work left running is in the background, not done', () => {
  const end = { kind: 'end' as const, tool: null, command: null, at: AT }
  const pending = { shells: 1, monitors: 0, agents: 0, sessions: 0, wake: null, since: AT }

  expect(stateOf(end, AT + 5000, undefined, pending)).toBe('background')
  expect(stateOf(end, AT + 5000, undefined, null)).toBe('done')
})

test('a turn whose wrap-up asks a decision waits on the person, until it is passed over', () => {
  const wrapUp = (ask?: string) => ({
    type: 'assistant',
    timestamp: STAMP,
    message: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'r', ask } }],
    },
    ...META,
  })
  const result = {
    type: 'user',
    timestamp: STAMP,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'ok' }] },
    ...META,
  }
  const end = { type: 'system', subtype: 'stop_hook_summary', timestamp: STAMP, ...META }
  // The box showing the question ends the turn at the call's result: no end is written after it.
  const asked = readTail(lines(wrapUp('지금 push할까요?'), result))

  expect(asked.last?.ask).toBe('지금 push할까요?')
  expect(stateOf(asked.last, AT + 60_000)).toBe('waiting')
  expect(stateOf(asked.last, AT + 3 * 3600_000)).toBe('done')
  expect(rowOf('/p/-w/x.jsonl', asked, 0, AT + 60_000, '').ask).toBe('지금 push할까요?')

  // The next turn answers it, whatever it says; a wrap-up with no ask leaves nothing pending.
  const next = { type: 'user', timestamp: STAMP, turnOrigin: 'human', message: { content: 'push해' }, ...META }
  const answered = readTail(lines(wrapUp('지금 push할까요?'), result, end, next, wrapUp(), result, end))
  expect(answered.last?.ask).toBeNull()
  expect(stateOf(answered.last, AT + 60_000)).toBe('done')
})

test('an interrupted turn ends, marked as the person’s', () => {
  const tail = readTail(
    lines({ type: 'user', timestamp: STAMP, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, ...META }),
  )

  expect(tail.last?.kind).toBe('end')
  expect(rowOf('/p/-w/x.jsonl', tail, 0, AT, '').isInterrupted).toBe(true)
})

test('a session in an app worktree is listed under its project, without the branch named after the worktree', () => {
  const worktree = '/Users/me/work/local-assets-engine/.claude/worktrees/happy-davinci-5c2ed9'
  const row = rowIn(
    '-Users-me-work-local-assets-engine--claude-worktrees-happy-davinci-5c2ed9',
    entry(worktree, 'claude/happy-davinci-5c2ed9'),
  )

  expect(row.project).toBe('local-assets-engine')
  expect(row.worktree).toBe('happy-davinci-5c2ed9')
  expect(row.branch).toBeNull()
  expect(row.cwd).toBe(worktree)
  // A branch of its own is kept.
  expect(rowIn('-Users-me-work-local-assets-engine--claude-worktrees-happy-davinci-5c2ed9', entry(worktree, 'feat/vae')).branch).toBe('feat/vae')
})

test('the title the app set wins over the generated one and a side session’s short name', () => {
  const tail = readTail(
    lines(
      { type: 'custom-title', customTitle: '정렬·필터 버그 수정' },
      { type: 'agent-name', agentName: 'sort-fix' },
      { type: 'ai-title', aiTitle: 'Fix sort bugs' },
    ),
  )

  expect(tail.title).toBe('정렬·필터 버그 수정')
})

test('a starter waits in the background while a session it started is at work, and each started one names it', () => {
  const row = (id: string, state: RowState, extra: Partial<Row> = {}): Row => ({
    ...rowOf(`/p/x/${id}.jsonl`, readTail(''), 0, 0, ''),
    state,
    at: AT,
    title: id,
    ...extra,
  })
  const parentOf = (id: string) => (id.startsWith('c') ? 'p' : null)
  const linked = linkRows([row('p', 'done'), row('c1', 'working'), row('c2', 'done')], parentOf)

  expect(linked[0]?.state).toBe('background')
  expect(linked[0]?.pending?.sessions).toBe(1)
  expect(linked[1]?.parent).toBe('p')
  // Work two sessions down keeps both above it waiting: each end there wakes them in turn.
  const chain = linkRows(
    [row('g', 'done'), row('p', 'done'), row('c1', 'background')],
    id => ({ p: 'g', c1: 'p' })[id] ?? null,
  )
  expect(chain.map(one => one.state)).toEqual(['background', 'background', 'background'])
  // One that ended its turn on a decision is not at work: the app wakes the starter anyway.
  const asking = linkRows([row('p', 'done'), row('c1', 'waiting', { ask: '병합할까요?' })], parentOf)
  expect(asking[0]?.state).toBe('done')
})
