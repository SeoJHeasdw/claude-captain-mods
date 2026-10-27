import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'board',
  props: {
    title: '대장님 대시보드',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-13T07:41:00.000Z')
const MONEY = '11111111-1111-4111-8111-111111111111'
const HARBOR = '22222222-2222-4222-8222-222222222222'
const SELF = '33333333-3333-4333-8333-333333333333'
const AUDIT = '44444444-4444-4444-8444-444444444444'
const OLD = '55555555-5555-4555-8555-555555555555'
const OLDER = '66666666-6666-4666-8666-666666666666'
const OLDEST = '77777777-7777-4777-8777-777777777777'
const ROOT = '/home/me/.claude/projects'
const NOTIFIER = '/home/me/.claude/session-board/notifier'

const transcript = (...entries: object[]): string =>
  entries.map(entry => JSON.stringify(entry)).join('\n')

const answer = (stamp: string, meta: object, title: object) =>
  transcript(title, {
    type: 'assistant',
    timestamp: stamp,
    ...meta,
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  })

const SHELL = `python3 -m tracker refresh 123456 --run 2>&1 | grep -E '"task"'`
const MONEY_PATH = `${ROOT}/-work-money/${MONEY}.jsonl`

const TRANSCRIPTS: Record<string, string> = {
  [`${ROOT}/-work-money/${MONEY}.jsonl`]: transcript(
    { type: 'ai-title', aiTitle: 'personal-tracker review' },
    {
      type: 'assistant',
      timestamp: '2026-10-13T07:40:00.000Z',
      cwd: '/work/money',
      gitBranch: 'main',
      entrypoint: 'claude-vscode',
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: SHELL } }],
      },
    },
  ),
  [`${ROOT}/-work-harbor/${HARBOR}.jsonl`]: answer(
    '2026-10-13T07:30:00.000Z',
    { cwd: '/work/harbor', gitBranch: 'dev', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: 'report' },
  ),
  [`${ROOT}/-work-money/${AUDIT}.jsonl`]: answer(
    '2026-10-13T07:10:00.000Z',
    { cwd: '/work/money', gitBranch: 'main', entrypoint: 'claude-vscode' },
    { type: 'ai-title', aiTitle: 'audit' },
  ),
  // Last spoken to days ago, though the app touched their files just now: ranked by the talk.
  [`${ROOT}/-work-harbor/${OLD}.jsonl`]: answer(
    '2026-10-09T09:12:00.000Z',
    { cwd: '/work/harbor', gitBranch: 'main', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: 'old one' },
  ),
  [`${ROOT}/-work-harbor/${OLDER}.jsonl`]: answer(
    '2026-10-08T09:12:00.000Z',
    { cwd: '/work/harbor', gitBranch: 'main', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: 'older one' },
  ),
  [`${ROOT}/-work-harbor/${OLDEST}.jsonl`]: answer(
    '2026-10-01T09:12:00.000Z',
    { cwd: '/work/harbor', gitBranch: 'main', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: 'the oldest' },
  ),
  [`${ROOT}/-work-edu/${SELF}.jsonl`]: answer(
    '2026-10-13T07:20:00.000Z',
    { cwd: '/work/edu', gitBranch: 'main', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: 'mods' },
  ),
}

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Four more spoken to between `older one` and `the oldest`: ten sessions above the oldest.
const FILLERS = ['88888888', '99999999', 'aaaaaaaa', 'bbbbbbbb'].map((hex, index) => [
  `${ROOT}/-work-harbor/${hex}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex}${hex.slice(0, 4)}.jsonl`,
  answer(
    `2026-10-0${7 - index}T09:12:00.000Z`,
    { cwd: '/work/harbor', gitBranch: 'main', entrypoint: 'claude-desktop' },
    { type: 'agent-name', agentName: `filler ${index + 1}` },
  ),
])

test('the pane lists the ten sessions last spoken to, opens or hands over the pressed one, and announces one that finishes', async ($, on) => {
  const commands: string[][] = []
  const transcripts = { ...TRANSCRIPTS, ...Object.fromEntries(FILLERS) }
  let touched = 0
  let processes = ''
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(
          e.argv.includes('*.jsonl')
            ? Object.keys(transcripts)
                .map(
                  (path, index) =>
                    `${1_791_877_000 + index + (path === MONEY_PATH ? touched : 0)} ${(transcripts[path] ?? '').length} ${path}`,
                )
                .join('\n')
            : '',
        )
      case 'tail':
        return ran(transcripts[String(e.argv[3])] ?? '')
      case 'ps':
        return ran(processes)
      case 'grep':
        return ran(`/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_9.json\n`)
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    const waiting = texts.findIndex(text => /⏸ Bash 허가 요청/.test(text))
    const done = texts.findIndex(text => /^(── )?복귀 완료/.test(text))

    expect(waiting).toBeGreaterThan(-1)
    expect(done).toBeGreaterThan(waiting)
    // The terminal rules each section off; a surface with a face of its own draws the name alone.
    expect(texts[done]).toMatch(surface === 'terminal' ? /^── 복귀 완료 ─+$/ : /^복귀 완료$/)
    expect(texts.some(text => /대장님, 결재 1건$/.test(text))).toBe(true)
    expect(texts.some(text => /⏸ 결재 1/.test(text))).toBe(true)
    expect(texts.some(text => /✓ 복귀 9/.test(text))).toBe(true)
    expect(texts.some(text => /filler 4/.test(text))).toBe(true)
    // How long the call has waited: a minute fills no ten-minute segment of the gauge yet.
    expect(texts).toContain('1m째')
    expect(texts).toContain('──────')
    expect(texts.some(text => /personal-tracker review/.test(text))).toBe(true)
    expect(texts.some(text => /older one/.test(text))).toBe(true)
    expect(texts.some(text => /the oldest/.test(text))).toBe(false)
    expect(texts.some(text => /지금 이 세션/.test(text))).toBe(true)
    expect(await ui.find({ key: `open:${SELF}` })).toBeUndefined()

    commands.length = 0
    await ui.press({ key: `open:${MONEY}` })
    await ui.press({ key: `open:${HARBOR}` })
    await ui.press({ key: `desktop:${AUDIT}` })
    expect(commands).toEqual([
      ['open', '-a', 'Visual Studio Code', '/work/money'],
      ['open', 'claude://claude.ai/epitaxy/local_9'],
      ['open', `claude://resume?session=${AUDIT}`],
    ])
    // A session still running elsewhere is not offered: two clients would write one transcript.
    expect(await ui.find({ key: `desktop:${MONEY}` })).toBeUndefined()
    expect(await ui.find({ key: `desktop:${HARBOR}` })).toBeUndefined()
    await ui.unmount()
  }

  // The same call, with its process found among the running ones, is busy and no call at all.
  processes = `/bin/zsh -c -l source snap.sh && eval 'python3 -m tracker refresh 123456 --run 2>&1 | grep -E '"'"'"task"'"'"''\n`
  await clock.advance(5000)
  const busy = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const busyTexts = (await busy.findAll({ type: 'Text' })).map(found => found.text)
  expect(busyTexts.some(text => /^[◐◓◑◒] 열일 중 · Bash/.test(text))).toBe(true)
  expect(busyTexts.some(text => /허가 요청/.test(text))).toBe(false)
  expect(busyTexts.some(text => /⏸ 결재 0/.test(text))).toBe(true)
  expect(busyTexts.some(text => /대장님, 대원 1명 출동 중/.test(text))).toBe(true)
  await busy.unmount()

  // Nothing is announced for what the first scans found; then the busy session answers.
  expect(commands.some(command => command[0] === 'osascript' || command[0]?.startsWith(NOTIFIER))).toBe(false)
  transcripts[MONEY_PATH] = answer(
    '2026-10-13T07:41:02.000Z',
    { cwd: '/work/money', gitBranch: 'main', entrypoint: 'claude-vscode' },
    { type: 'ai-title', aiTitle: 'personal-tracker review' },
  )
  touched = 1
  commands.length = 0
  await clock.advance(5000)
  await clock.advance(5000)
  // A finish is announced once it has held: a session woken again at once is not finished.
  expect(commands.some(command => command[0]?.startsWith(NOTIFIER))).toBe(false)
  await clock.advance(5000)

  // Raised through the board's own app, which opens the session's folder in VS Code on a click.
  const banners = commands.filter(command => command[0]?.startsWith(NOTIFIER))
  expect(banners).toEqual([
    [
      `${NOTIFIER}/Done.app/Contents/MacOS/Notifier`,
      '--title',
      '✓ money 임무 완료',
      '--body',
      'personal-tracker review · VS Code',
      '--open',
      'vscode://file/work/money',
    ],
  ])
  expect(commands.some(command => command[0] === 'osascript')).toBe(false)
  expect(commands).toContainEqual(['mkdir', `/home/me/.claude/session-board/announced/${MONEY}-${Date.parse('2026-10-13T07:41:02.000Z')}`])
})

test('a finish keeps its card under 완료 보고 until 열기 or 확인 is pressed here or in another copy, and old finishes stay down', async ($, on) => {
  const meta = { cwd: '/work/harbor', gitBranch: 'dev', entrypoint: 'claude-desktop' }
  const CLAIMS = '/home/me/.claude/session-board/announced'
  const SEEN = '/home/me/.claude/session-board/seen'
  const pathOf = (id: string) => `${ROOT}/-work-harbor/${id}.jsonl`
  const working = [HARBOR, AUDIT, OLD, OLDER, MONEY]
  const titleOf = (id: string) => `mission ${working.indexOf(id) + 1}`
  const endAt = (id: string) => Date.parse(`2026-10-13T07:41:0${working.indexOf(id) + 1}.000Z`)
  const oldestAt = Date.parse('2026-10-12T09:00:00.000Z')
  const entries: Record<string, object[]> = {
    // Finished and announced before the board kept its cards.
    [pathOf(OLDEST)]: [
      { type: 'ai-title', aiTitle: 'the oldest' },
      { type: 'assistant', timestamp: new Date(oldestAt).toISOString(), ...meta, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    ],
    ...Object.fromEntries(
      working.map(id => [
        pathOf(id),
        [
          { type: 'ai-title', aiTitle: titleOf(id) },
          { type: 'user', timestamp: '2026-10-13T07:40:50.000Z', message: { content: 'go' }, ...meta },
        ],
      ]),
    ),
  }
  // The claim folders as a tiny disk: `mkdir` without `-p` fails where the folder is there.
  const folders = new Map<string, Set<string>>([[CLAIMS, new Set([`${OLDEST}-${oldestAt}`])]])
  const mkdir = (argv: readonly string[]): number => {
    const isDeep = argv[1] === '-p'
    for (const path of argv.slice(isDeep ? 2 : 1)) {
      const cut = path.lastIndexOf('/')
      const names = folders.get(path.slice(0, cut)) ?? new Set<string>()
      if (names.has(path.slice(cut + 1)) && !isDeep) {
        return 1
      }
      names.add(path.slice(cut + 1))
      folders.set(path.slice(0, cut), names)
      folders.set(path, folders.get(path) ?? new Set())
    }

    return 0
  }
  const commands: string[][] = []
  let mtime = 1_791_877_000
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('fs.list', (_$, e) => ({
    value: [...(folders.get(e.path) ?? [])].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(
          e.argv.includes('*.jsonl')
            ? Object.entries(entries)
                .map(([path, list]) => `${mtime} ${transcript(...list).length} ${path}`)
                .join('\n')
            : '',
        )
      case 'tail':
        return ran(transcript(...(entries[String(e.argv[3])] ?? [])))
      case 'grep':
        return ran(`/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_9.json\n`)
      case 'sh':
        return ran('')
      case 'mkdir':
        commands.push([...e.argv])

        return ran('', mkdir(e.argv))
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })
  const look = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    const reports = texts.findIndex(text => /^(── )?완료 보고/.test(text))
    const back = texts.findIndex(text => /^(── )?복귀 완료/.test(text))
    // Whether a session is up among the reports: below their heading, above the rest.
    const isReported = (id: string) => {
      const at = texts.indexOf(titleOf(id))

      return reports > -1 && at > reports && (back === -1 || at < back)
    }

    return { ui, texts, isReported }
  }

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  // The first run marks every finish announced before as seen: no day of old cards at once.
  expect(commands).toContainEqual(['mkdir', SEEN])
  expect(commands).toContainEqual(['mkdir', '-p', `${SEEN}/${OLDEST}-${oldestAt}`])
  const before = await look()
  expect(before.texts.some(text => /^(── )?완료 보고/.test(text))).toBe(false)
  expect(before.texts.some(text => /대장님, 대원 5명 출동 중$/.test(text))).toBe(true)
  await before.ui.unmount()

  // All five answer. Each card is up at once, while its finish holds before the banner.
  for (const id of working) {
    entries[pathOf(id)]?.push({
      type: 'assistant',
      timestamp: new Date(endAt(id)).toISOString(),
      ...meta,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    })
  }
  mtime += 1
  await clock.advance(5000)
  const held = await look()
  expect(working.every(held.isReported)).toBe(true)
  expect(held.texts.some(text => /대장님, 완료 보고 5건$/.test(text))).toBe(true)
  expect(held.texts.some(text => /✓ 보고 5/.test(text))).toBe(true)
  expect(held.texts.some(text => /✓ 복귀 1/.test(text))).toBe(true)
  expect(held.isReported(OLDEST)).toBe(false)
  expect(await held.ui.find({ key: `seen:${OLDEST}` })).toBeUndefined()
  await held.ui.unmount()
  expect(commands.some(command => command[0]?.startsWith(NOTIFIER))).toBe(false)

  // Announced, the cards stay up: a finish leaves only at a press.
  await clock.advance(5000)
  await clock.advance(5000)
  expect(commands.filter(command => command[0]?.startsWith(NOTIFIER)).length).toBe(5)
  await clock.advance(5000)
  const announced = await look()
  expect(working.every(announced.isReported)).toBe(true)

  // 열기 opens the session and takes the finish as seen; 확인 only takes it as seen.
  commands.length = 0
  await announced.ui.press({ key: `open:${HARBOR}` })
  await announced.ui.press({ key: `seen:${AUDIT}` })
  await announced.ui.unmount()
  expect(commands).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_9'])
  expect(commands).toContainEqual(['mkdir', '-p', `${SEEN}/${HARBOR}-${endAt(HARBOR)}`])
  expect(commands).toContainEqual(['mkdir', '-p', `${SEEN}/${AUDIT}-${endAt(AUDIT)}`])
  const pressed = await look()
  expect(pressed.isReported(HARBOR)).toBe(false)
  expect(pressed.isReported(AUDIT)).toBe(false)
  expect(pressed.texts.some(text => /✓ 보고 3/.test(text))).toBe(true)
  expect(pressed.texts.some(text => /✓ 복귀 3/.test(text))).toBe(true)
  await pressed.ui.unmount()

  // Another copy of the board, in another session, marks one seen: it goes down here too, and
  // the marks laid here hold on the next scan.
  folders.get(SEEN)?.add(`${OLD}-${endAt(OLD)}`)
  await clock.advance(5000)
  const elsewhere = await look()
  expect(elsewhere.isReported(OLD)).toBe(false)
  expect(elsewhere.isReported(HARBOR)).toBe(false)
  expect([OLDER, MONEY].every(elsewhere.isReported)).toBe(true)

  // 모두 확인 takes the rest at once, and leaves with them.
  expect(await elsewhere.ui.find({ key: 'seen:all' })).toBeDefined()
  await elsewhere.ui.press({ key: 'seen:all' })
  await elsewhere.ui.unmount()
  await clock.advance(5000)
  const after = await look()
  expect(after.texts.some(text => /^(── )?완료 보고/.test(text))).toBe(false)
  expect(after.texts.some(text => /대장님, 전원 복귀했습니다$/.test(text))).toBe(true)
  expect(after.texts.some(text => /✓ 복귀 6/.test(text))).toBe(true)
  expect(await after.ui.find({ key: 'seen:all' })).toBeUndefined()
  await after.ui.unmount()
})

test('a session that turns to ask the person raises a call banner, and where the app cannot post, osascript stands in', async ($, on) => {
  const path = `${ROOT}/-work-harbor/${HARBOR}.jsonl`
  const meta = { cwd: '/work/harbor', gitBranch: 'dev', entrypoint: 'claude-desktop' }
  const entries: object[] = [
    { type: 'ai-title', aiTitle: 'report' },
    { type: 'user', timestamp: '2026-10-13T07:40:50.000Z', message: { content: 'go' }, ...meta },
  ]
  const commands: string[][] = []
  let mtime = 1_791_877_000
  let notifierExit = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(e.argv.includes('*.jsonl') ? `${mtime} ${transcript(...entries).length} ${path}` : '')
      case 'tail':
        return ran(transcript(...entries))
      case 'grep':
        return ran(`/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_9.json\n`)
      default:
        commands.push([...e.argv])

        return ran('', e.argv[0]?.startsWith(NOTIFIER) ? notifierExit : 0)
    }
  })

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })
  expect(commands.some(command => command[0]?.startsWith(NOTIFIER))).toBe(false)

  // The model stops to ask: a banner from the call app, which opens the desktop session.
  entries.push({
    type: 'assistant',
    timestamp: '2026-10-13T07:40:58.000Z',
    ...meta,
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] },
  })
  mtime += 1
  await clock.advance(5000)
  expect(commands.filter(command => command[0]?.startsWith(NOTIFIER))).toEqual([
    [
      `${NOTIFIER}/Call.app/Contents/MacOS/Notifier`,
      '--title',
      '⏸ harbor 대장님 호출 · 질문 있습니다',
      '--body',
      'report',
      '--open',
      'claude://claude.ai/epitaxy/local_9',
    ],
  ])
  expect(commands).toContainEqual(['mkdir', `/home/me/.claude/session-board/announced/${HARBOR}-${Date.parse('2026-10-13T07:40:58.000Z')}-call`])

  // Still waiting on the next scan: no second banner.
  await clock.advance(5000)
  expect(commands.filter(command => command[0]?.startsWith(NOTIFIER)).length).toBe(1)

  // Answered and finished, while the done app fails: the plain banner stands in.
  notifierExit = 1
  entries.push(
    { type: 'user', timestamp: '2026-10-13T07:41:06.000Z', message: { content: [{ type: 'tool_result', content: 'ok' }] }, ...meta },
    { type: 'assistant', timestamp: '2026-10-13T07:41:08.000Z', ...meta, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  )
  mtime += 1
  commands.length = 0
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(commands.filter(command => command[0]?.startsWith(NOTIFIER)).map(command => command[0])).toEqual([
    `${NOTIFIER}/Done.app/Contents/MacOS/Notifier`,
  ])
  expect(commands.filter(command => command[0] === 'osascript').map(command => command.slice(-2))).toEqual([
    ['✓ harbor 임무 완료', 'report'],
  ])
})

test('a result written within the second its call was read in is read, and a quick shell call followed by long thought raises no call', async ($, on) => {
  const path = `${ROOT}/-work-maxmax/${HARBOR}.jsonl`
  const meta = { cwd: '/work/maxmax', gitBranch: 'main', entrypoint: 'claude-vscode' }
  const entries: object[] = [
    { type: 'ai-title', aiTitle: 'netcode' },
    { type: 'user', timestamp: '2026-10-13T07:40:50.000Z', turnOrigin: 'human', message: { content: 'go' }, ...meta },
    {
      type: 'assistant',
      timestamp: '2026-10-13T07:40:59.000Z',
      ...meta,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sed -n 1080,1110p Core/NetworkManager.cs' } }],
      },
    },
  ]
  const commands: string[][] = []
  let tails = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        // The same second throughout: only the size moves.
        return ran(e.argv.includes('*.jsonl') ? `1791877000 ${transcript(...entries).length} ${path}` : '')
      case 'tail':
        tails += 1

        return ran(transcript(...entries))
      case 'ps':
      case 'grep':
        return ran('')
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })
  expect(tails).toBe(1)

  // The command ends at once and its result lands in the same second; the model then thinks.
  entries.push({
    type: 'user',
    timestamp: '2026-10-13T07:40:59.800Z',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
    ...meta,
  })
  await clock.advance(5000)
  expect(tails).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => /열일 중$/.test(text))).toBe(true)
  expect(texts.some(text => /열일 중 · Bash|대장님 호출/.test(text))).toBe(false)
  await ui.unmount()

  // A minute of thought writes nothing, and calls nobody.
  for (let step = 0; step < 12; step += 1) {
    await clock.advance(5000)
  }
  expect(tails).toBe(2)
  expect(commands.some(command => command[0] === 'osascript' || command[0]?.startsWith(NOTIFIER))).toBe(false)
})

test('a call is announced only where the transcript read afresh still shows it', async ($, on) => {
  const path = `${ROOT}/-work-harbor/${HARBOR}.jsonl`
  const meta = { cwd: '/work/harbor', gitBranch: 'dev', entrypoint: 'claude-desktop' }
  const call = (timestamp: string, command: string) => ({
    type: 'assistant',
    timestamp,
    ...meta,
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  })
  const entries: object[] = [
    { type: 'ai-title', aiTitle: 'report' },
    { type: 'user', timestamp: '2026-10-13T07:40:50.000Z', turnOrigin: 'human', message: { content: 'go' }, ...meta },
    call('2026-10-13T07:40:59.000Z', 'python3 -m report --long-run'),
  ]
  // What the listing says of the file, held still to stand for a write the listing missed.
  let listed = { mtime: 1_791_877_000, size: 100 }
  const commands: string[][] = []
  let tails = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(e.argv.includes('*.jsonl') ? `${listed.mtime} ${listed.size} ${path}` : '')
      case 'tail':
        tails += 1

        return ran(transcript(...entries))
      case 'ps':
        return ran('')
      case 'grep':
        return ran(`/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_9.json\n`)
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })
  const banners = () =>
    commands.filter(command => command[0] === 'osascript' || command[0]?.startsWith(NOTIFIER))

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  // The long command ends and writes its result, which the listing does not show: the scan's
  // tail still holds the bare call, its process gone, and reads it as waiting at 21 seconds.
  entries.push({
    type: 'user',
    timestamp: '2026-10-13T07:41:01.000Z',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
    ...meta,
  })
  for (let step = 0; step < 4; step += 1) {
    await clock.advance(5000)
  }
  // A wait guessed from timing is held for the next scan: nothing is read afresh yet.
  expect(tails).toBe(1)
  expect(banners()).toEqual([])
  // Still read so, it is read afresh: the transcript has the result, no banner, and the next
  // scan reads it again.
  await clock.advance(5000)
  expect(tails).toBe(2)
  expect(banners()).toEqual([])
  await clock.advance(5000)
  expect(tails).toBe(3)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => /열일 중$/.test(text))).toBe(true)
  expect(texts.some(text => /대장님 호출/.test(text))).toBe(false)
  await ui.unmount()

  // Then a call that does wait on the person: first read as waiting at 25 seconds, it still
  // waits on the next scan and read afresh, and is announced then.
  entries.push(call('2026-10-13T07:41:25.000Z', 'git push origin feature/report'))
  listed = { mtime: listed.mtime + 25, size: listed.size + 1 }
  for (let step = 0; step < 4; step += 1) {
    await clock.advance(5000)
  }
  expect(banners()).toEqual([])
  await clock.advance(5000)
  expect(banners()).toEqual([
    [
      `${NOTIFIER}/Call.app/Contents/MacOS/Notifier`,
      '--title',
      '⏸ harbor 대장님 호출 · Bash 허가 요청',
      '--body',
      'report',
      '--open',
      'claude://claude.ai/epitaxy/local_9',
    ],
  ])
})

test('in a session another client hosts, the board opens no pane and runs nothing', async ($, on) => {
  let touched = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: 'claude-vscode' }))
  on('ui.open', () => {
    touched += 1

    return { value: { isPlaced: true } }
  })
  on('process.run', () => {
    touched += 1

    return ran('')
  })

  await $.session.start({ cwd: '/work/money', surface: 'vscode', isInteractive: true })

  expect(touched).toBe(0)
})

test('a session whose shell left for another project is listed and opened under its own directory, found on disk, with the branch git names', async ($, on) => {
  const commands: string[][] = []
  const listed: string[] = []
  let touched = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  const DISK: Record<string, string[]> = { '/': ['work'], '/work': ['foo', 'foo_agent', 'assets'] }
  on('fs.list', (_$, e) => {
    // The board's own claim folders are read every scan; only the search for a home is counted.
    if (!e.path.startsWith('/home/me/.claude/session-board/')) {
      listed.push(e.path)
    }

    return { value: (DISK[e.path] ?? []).map(dir) }
  })
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(
          e.argv.includes('*.jsonl') ? `${1_791_877_000 + touched} 900 ${ROOT}/-work-foo-agent/${MONEY}.jsonl` : '',
        )
      case 'tail':
        // Every entry the tail still holds was written from the other project.
        return ran(
          answer(
            '2026-10-13T07:40:00.000Z',
            { cwd: '/work/assets', gitBranch: 'contract', entrypoint: 'claude-vscode' },
            { type: 'ai-title', aiTitle: 'handoff' },
          ),
        )
      case 'git':
        return ran(e.argv.join(' ') === 'git -C /work/foo_agent branch --show-current' ? 'main\n' : '')
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => / 전 · foo_agent · ⎇ main · VS Code$/.test(text))).toBe(true)
  expect(texts.some(text => /assets|contract/.test(text))).toBe(false)

  await ui.press({ key: `open:${MONEY}` })
  expect(commands).toContainEqual(['open', '-a', 'Visual Studio Code', '/work/foo_agent'])
  await ui.unmount()

  // The transcript grows; its folder's directory is not looked for on disk again.
  const looks = listed.length
  touched = 1
  await clock.advance(5000)
  expect(listed.length).toBe(looks)
})

test('a busy session counts its time from the prompt that began the work, looked for beyond the tail once', async ($, on) => {
  const looks: string[][] = []
  let touched = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  const step = (timestamp: string, promptId: string, meta: object): object[] => [
    {
      type: 'user',
      timestamp,
      promptId,
      ...meta,
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    },
    {
      type: 'assistant',
      timestamp,
      ...meta,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Agent', input: {} }] },
    },
  ]
  const BUSY: Record<string, string> = {
    // The prompt and every step since are in the tail: ten seconds ago is only the latest step.
    [`${ROOT}/-work-money/${MONEY}.jsonl`]: transcript(
      {
        type: 'user',
        timestamp: '2026-10-13T07:30:00.000Z',
        promptId: 'p1',
        turnOrigin: 'human',
        cwd: '/work/money',
        message: { content: 'refresh' },
      },
      ...step('2026-10-13T07:35:00.000Z', 'p1', { cwd: '/work/money', entrypoint: 'claude-vscode' }),
      ...step('2026-10-13T07:40:50.000Z', 'p1', { cwd: '/work/money', entrypoint: 'claude-vscode' }),
    ),
    // The prompt has left the tail, which begins mid-work.
    [`${ROOT}/-work-harbor/${HARBOR}.jsonl`]: transcript(
      ...step('2026-10-13T07:40:55.000Z', 'p9', { cwd: '/work/harbor', entrypoint: 'claude-desktop' }),
    ),
  }
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(
          e.argv.includes('*.jsonl')
            ? Object.keys(BUSY)
                .map(path => `${1_791_877_000 + touched} ${(BUSY[path] ?? '').length} ${path}`)
                .join('\n')
            : '',
        )
      case 'tail':
        return ran(BUSY[String(e.argv[3])] ?? '')
      case 'grep':
        looks.push([...e.argv])

        return ran(
          e.argv.includes('"promptId":"p9"') && e.argv.at(-1) === `${ROOT}/-work-harbor/${HARBOR}.jsonl`
            ? `{"type":"user","promptId":"p9","turnOrigin":"human","timestamp":"2026-10-13T07:21:00.000Z"}\n`
            : '',
        )
      default:
        return ran('')
    }
  })

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.filter(text => /째$/.test(text)).sort()).toEqual(['11m째', '20m째'])
  // A segment of the gauge for each ten minutes gone.
  expect(texts.filter(text => /^━+$/.test(text)).sort()).toEqual(['━', '━━'])
  expect(texts.filter(text => /열일 중 · Agent/.test(text)).length).toBe(2)
  await ui.unmount()

  // Both transcripts grow; the prompt beyond the tail is not looked for again.
  touched = 1
  await clock.advance(5000)
  expect(looks.length).toBe(1)
})

/**
 * A board over one transcript the test writes entry by entry: the listing gives its size,
 * `tail` returns as many of its last bytes as asked (and records how many), `ps` shows the
 * world's processes.
 */
const boardOver = async (
  [$, on]: Parameters<TestBody>,
  path: string,
  now: number,
  world: { entries: object[]; processes: string },
) => {
  const commands: string[][] = []
  const tails: number[] = []
  const clock = mock.clock(on)
  await clock.set(now)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    const text = transcript(...world.entries)
    switch (e.argv[0]) {
      case 'find':
        return ran(e.argv.includes('*.jsonl') ? `1791877000 ${text.length} ${path}` : '')
      case 'tail': {
        const bytes = Number(e.argv[2])
        tails.push(bytes)

        return ran(text.slice(-bytes))
      }
      case 'ps':
        return ran(world.processes)
      case 'grep':
        return ran(`/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_9.json\n`)
      case 'sh':
        // The ledger's grep: every line of the transcript, the ones it does not want ignored.
        return ran(text)
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })
  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })

  return {
    clock,
    commands,
    tails,
    banners: () => commands.filter(command => command[0] === 'osascript' || command[0]?.startsWith(NOTIFIER)),
    texts: async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      await ui.unmount()

      return texts
    },
  }
}

const DESK = { cwd: '/work/demo_app', gitBranch: 'main', entrypoint: 'claude-desktop' }
const EDU_PATH = `${ROOT}/-work-demo-app/${HARBOR}.jsonl`

test('a screenshot read into the transcript, one line longer than the tail, reads as work under way and not as a finish', async (...harness) => {
  // The Read of shot-2.png wrote a 444 KB line, the
  // tail held a cut piece of it and nothing else, and the board announced a finish mid-turn.
  const world = {
    processes: '',
    entries: [
      { type: 'ai-title', aiTitle: '문서 초안 피드백 검토' },
      { type: 'user', timestamp: '2026-10-13T07:40:30.000Z', turnOrigin: 'human', message: { content: '알아서 해줘' }, ...DESK },
      {
        type: 'assistant',
        timestamp: '2026-10-13T07:40:58.000Z',
        ...DESK,
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/scratchpad/shot-2.png' } }],
        },
      },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  world.entries.push({
    type: 'user',
    timestamp: '2026-10-13T07:40:59.000Z',
    ...DESK,
    message: {
      content: [
        {
          type: 'tool_result',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(444_000) } }],
        },
      ],
    },
  })
  await board.clock.advance(5000)

  // The usual tail is all one cut line: the end is read further back, and the work goes on.
  expect(board.tails).toContain(4_000_000)
  const texts = await board.texts()
  expect(texts.some(text => /열일 중$/.test(text))).toBe(true)
  expect(texts.some(text => /임무 완료/.test(text))).toBe(false)
  expect(board.banners()).toEqual([])

  // The answer that does end the turn is announced, once.
  world.entries.push({
    type: 'assistant',
    timestamp: '2026-10-13T07:41:04.000Z',
    ...DESK,
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '바뀐 두 장은 확인했습니다' }] },
  })
  await board.clock.advance(5000)
  await board.clock.advance(5000)
  await board.clock.advance(5000)
  await board.clock.advance(5000)
  expect(board.banners().map(command => command[0])).toEqual([`${NOTIFIER}/Done.app/Contents/MacOS/Notifier`])
})

test('a long command whose process just ended, its result not yet written, calls nobody', async (...harness) => {
  // A 27-second screenshot run. Its process ended a moment
  // before its result was written, a scan read in between, and the board called the person.
  const command = 'S=/private/tmp/scratchpad; node $S/shots.mjs $S'
  const world = {
    processes: `/bin/zsh -c source snap.sh && eval '${command}' && pwd -P >| /tmp/claude-cwd\n`,
    entries: [
      { type: 'ai-title', aiTitle: '문서 초안 피드백 검토' },
      { type: 'user', timestamp: '2026-10-13T07:40:30.000Z', turnOrigin: 'human', message: { content: '알아서 해줘' }, ...DESK },
      {
        type: 'assistant',
        timestamp: '2026-10-13T07:40:35.000Z',
        ...DESK,
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
      },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  // Past twenty seconds its process is found running: busy.
  await board.clock.advance(5000)
  expect((await board.texts()).some(text => /열일 중 · Bash/.test(text))).toBe(true)

  // The process ends, and a scan reads before the result is written: held, not announced.
  world.processes = ''
  await board.clock.advance(5000)
  expect(board.banners()).toEqual([])

  // The result lands before the next scan: the work goes on, and nobody was called.
  world.entries.push({
    type: 'user',
    timestamp: '2026-10-13T07:41:10.300Z',
    ...DESK,
    message: { content: [{ type: 'tool_result', content: 'shot-edge 41 2\nshot-body 42 3' }] },
  })
  await board.clock.advance(5000)
  await board.clock.advance(5000)
  expect(board.banners()).toEqual([])
  const texts = await board.texts()
  expect(texts.some(text => /열일 중$/.test(text))).toBe(true)
  expect(texts.some(text => /허가 요청/.test(text))).toBe(false)
})

const CODE = { cwd: '/work/studio-agent', gitBranch: 'main', entrypoint: 'claude-vscode' }
const STUDIO_PATH = `${ROOT}/-work-studio-agent/${HARBOR}.jsonl`
// How the app runs a command, as ps lists it where no locale is set: each byte beyond ASCII escaped.
const shellOf = (command: string): string =>
  `/bin/zsh -c source snap.sh && eval '${command.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-cwd\n`.replace(
    /[^\x00-\x7f]/g,
    'M-^?',
  )

test('a shell call queued behind another of its reply, or with Korean in it, calls nobody while the work runs', async (...harness) => {
  // `npx vite build` and the tool tests asked for in one reply; the
  // tests waited their turn, and the board, finding no process of theirs, called the person.
  const build = 'npx vite build 2>&1 | tail -4'
  const tests = 'node --test --test-concurrency=2 tools/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖" | head -20'
  const call = (stamp: string, id: string, command: string) => ({
    type: 'assistant',
    timestamp: stamp,
    ...CODE,
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  })
  const result = (stamp: string, id: string) => ({
    type: 'user',
    timestamp: stamp,
    ...CODE,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  })
  const world = {
    processes: shellOf(build),
    entries: [
      { type: 'ai-title', aiTitle: '원고 초안 리뷰' },
      { type: 'user', timestamp: '2026-10-13T07:40:30.000Z', turnOrigin: 'human', message: { content: '리뷰해줘' }, ...CODE },
      call('2026-10-13T07:40:48.259Z', 'build', build),
      call('2026-10-13T07:40:49.452Z', 'tests', tests),
    ] as object[],
  }
  const board = await boardOver(harness, STUDIO_PATH, NOW, world)

  // Past twenty seconds the build runs and the tests wait their turn: busy, and nobody called.
  for (let scan = 0; scan < 6; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners()).toEqual([])
  expect((await board.texts()).some(text => /열일 중 · Bash/.test(text))).toBe(true)

  // The build ends and the tests run, their Korean pattern escaped in ps as no locale is set.
  world.entries.push(result('2026-10-13T07:41:30.000Z', 'build'))
  world.processes = shellOf(tests)
  await board.clock.advance(5000)
  const heredoc = [
    `python3 - <<'EOF'`,
    `p='src/projects/sections/ch02/03-s03.1-intro-scene.ts'`,
    `# 장면 하나를 아래로 이어 붙이고 그 대사에서 화면이 내려간다: 80%(0~3) → 이유(4~7) → 정리`,
    `open(p,'w').write(open(p).read().replace('steps: 11','steps: 9'))`,
    'EOF',
  ].join('\n')
  world.entries.push(result('2026-10-13T07:41:40.000Z', 'tests'), call('2026-10-13T07:41:41.000Z', 'edit', heredoc))
  world.processes = shellOf(heredoc)
  for (let scan = 0; scan < 6; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners()).toEqual([])
  expect((await board.texts()).some(text => /열일 중 · Bash/.test(text))).toBe(true)

  // A command found nowhere, the others done, is still a call.
  world.entries.push(result('2026-10-13T07:42:20.000Z', 'edit'), call('2026-10-13T07:42:21.000Z', 'push', 'git push origin main'))
  world.processes = ''
  for (let scan = 0; scan < 10; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners().map(command => command[0])).toEqual([`${NOTIFIER}/Call.app/Contents/MacOS/Notifier`])
})

test('a finish first read after its stop-hook summary is claimed under the answer time, as one read before it', async (...harness) => {
  // One copy of the board read the answer, another the summary
  // written 0.2 s after it; their claims differed by that time, and both raised a banner.
  const world = {
    processes: '',
    entries: [
      { type: 'ai-title', aiTitle: '문서 초안 피드백 검토' },
      { type: 'user', timestamp: '2026-10-15T05:30:00.000Z', turnOrigin: 'human', message: { content: '봐줘' }, ...DESK },
      { type: 'user', timestamp: '2026-10-15T05:35:53.000Z', ...DESK, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, Date.parse('2026-10-15T05:36:05.000Z'), world)

  world.entries.push(
    {
      type: 'assistant',
      timestamp: '2026-10-15T05:36:10.915Z',
      ...DESK,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '세 가지 중 하나는 그대로 두시고' }] },
    },
    { type: 'last-prompt', lastPrompt: '봐줘' },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-15T05:36:11.122Z', ...DESK },
  )
  await board.clock.advance(5000)
  await board.clock.advance(5000)
  await board.clock.advance(5000)

  expect(board.commands).toContainEqual([
    'mkdir',
    `/home/me/.claude/session-board/announced/${HARBOR}-${Date.parse('2026-10-15T05:36:10.915Z')}`,
  ])
  expect(board.banners().length).toBe(1)
})

const ended = (stamp: string, said = '확인했습니다') => ({
  type: 'assistant',
  timestamp: stamp,
  ...DESK,
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text: said }] },
})

test('a turn that ends with a monitor still watching is in the background, and only the end of that work is announced', async (...harness) => {
  // A video job watched by a monitor woke its session on each
  // event, each turn ended at once, and every one of those ends raised a finish banner.
  const world = {
    processes: '',
    entries: [
      { type: 'custom-title', customTitle: '영상: 업스케일 테스트' },
      { type: 'user', timestamp: '2026-10-13T07:40:00.000Z', turnOrigin: 'human', message: { content: '돌려줘' }, ...DESK },
      {
        type: 'assistant',
        timestamp: '2026-10-13T07:40:05.000Z',
        ...DESK,
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Monitor', input: {} }] },
      },
      {
        type: 'user',
        timestamp: '2026-10-13T07:40:06.000Z',
        ...DESK,
        message: { content: [{ type: 'tool_result', content: 'Monitor started (task bmon1)' }] },
        toolUseResult: { taskId: 'bmon1', timeoutMs: 1_800_000, persistent: false },
      },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  world.entries.push(ended('2026-10-13T07:41:01.000Z', '작업이 줄에 들어갔습니다'))
  for (let scan = 0; scan < 4; scan += 1) {
    await board.clock.advance(5000)
  }
  const texts = await board.texts()
  expect(texts.some(text => /◌ 보초 서는 중 · 모니터 1/.test(text))).toBe(true)
  expect(texts.some(text => /임무 완료/.test(text))).toBe(false)
  expect(board.banners()).toEqual([])

  // An event wakes the session; it looks and stops again, the monitor still on.
  world.entries.push(
    {
      type: 'user',
      timestamp: '2026-10-13T07:41:30.000Z',
      turnOrigin: 'task_notification',
      ...DESK,
      message: { content: '<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "job"</summary>\n<event>running 11%</event>\n</task-notification>' },
    },
    ended('2026-10-13T07:41:33.000Z', '아직 도는 중입니다'),
  )
  for (let scan = 0; scan < 4; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners()).toEqual([])

  // The stream ends: the session wakes, reports, and stops with nothing left running.
  world.entries.push(
    {
      type: 'user',
      timestamp: '2026-10-13T07:42:00.000Z',
      turnOrigin: 'task_notification',
      ...DESK,
      message: { content: '<task-notification>\n<task-id>bmon1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Monitor "job" stream ended</summary>\n</task-notification>' },
    },
    ended('2026-10-13T07:42:04.000Z', '영상이 나왔습니다'),
  )
  for (let scan = 0; scan < 4; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners().map(command => command[2])).toEqual(['✓ demo_app 임무 완료'])
})

test('a turn that ends on a decision calls the person with it, and raises no finish', async (...harness) => {
  const world = {
    processes: '',
    entries: [
      { type: 'custom-title', customTitle: '엔진 개선 사항' },
      { type: 'user', timestamp: '2026-10-13T07:40:00.000Z', turnOrigin: 'human', message: { content: '정리해줘' }, ...DESK },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  world.entries.push(
    {
      type: 'assistant',
      timestamp: '2026-10-13T07:41:00.000Z',
      ...DESK,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_w', name: 'mcp__ccd_turn__wrap_up', input: { recap: '정리했습니다', ask: '지금 push할까요?' } }],
      },
    },
    // The box shows the question and the turn ends there: nothing more is written for it.
    {
      type: 'user',
      timestamp: '2026-10-13T07:41:01.000Z',
      ...DESK,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'shown' }] },
    },
  )
  await board.clock.advance(5000)
  expect(board.banners()).toEqual([
    [
      `${NOTIFIER}/Call.app/Contents/MacOS/Notifier`,
      '--title',
      '⏸ demo_app 대장님 호출 · 결재 바랍니다',
      '--body',
      '“지금 push할까요?” · 엔진 개선 사항',
      '--open',
      'claude://claude.ai/epitaxy/local_9',
    ],
  ])
  for (let scan = 0; scan < 4; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners().length).toBe(1)
  const texts = await board.texts()
  expect(texts.some(text => /“지금 push할까요\?”/.test(text))).toBe(true)

  // Passed over for hours, the decision no longer calls, and its fading is no finish either.
  await board.clock.advance(3 * 3600_000)
  await board.clock.advance(5000)
  expect(board.banners().length).toBe(1)
  expect((await board.texts()).some(text => /결재 바랍니다/.test(text))).toBe(false)
})

test('a turn the person interrupted is no finish to announce', async (...harness) => {
  const world = {
    processes: '',
    entries: [
      { type: 'custom-title', customTitle: '엔진 개선 사항' },
      { type: 'user', timestamp: '2026-10-13T07:40:00.000Z', turnOrigin: 'human', message: { content: '해줘' }, ...DESK },
      { type: 'assistant', timestamp: '2026-10-13T07:40:40.000Z', ...DESK, message: { stop_reason: null, content: [{ type: 'text', text: '보는 중' }] } },
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  world.entries.push({
    type: 'user',
    timestamp: '2026-10-13T07:41:01.000Z',
    ...DESK,
    message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })
  for (let scan = 0; scan < 4; scan += 1) {
    await board.clock.advance(5000)
  }
  expect(board.banners()).toEqual([])
  expect((await board.texts()).some(text => /작전 중지/.test(text))).toBe(true)
})

test('a session waiting on the sessions it started is in the background, and one started in a worktree is listed under its project and starter', async ($, on) => {
  const PARENT = HARBOR
  const CHILD = MONEY
  const parentPath = `${ROOT}/-work-assets/${PARENT}.jsonl`
  const childPath = `${ROOT}/-work-assets--claude-worktrees-happy-davinci-5c2ed9/${CHILD}.jsonl`
  const ASSETS = { cwd: '/work/assets', gitBranch: 'main', entrypoint: 'claude-desktop' }
  const WORKTREE = {
    cwd: '/work/assets/.claude/worktrees/happy-davinci-5c2ed9',
    gitBranch: 'claude/happy-davinci-5c2ed9',
    entrypoint: 'claude-desktop',
  }
  const files: Record<string, object[]> = {
    [parentPath]: [
      { type: 'custom-title', customTitle: '엔진 개선 사항' },
      { type: 'user', timestamp: '2026-10-13T07:30:00.000Z', turnOrigin: 'human', message: { content: '나눠서 해줘' }, ...ASSETS },
      { type: 'assistant', timestamp: '2026-10-13T07:31:00.000Z', ...ASSETS, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '세션 둘에 맡겼습니다' }] } },
    ],
    [childPath]: [
      { type: 'custom-title', customTitle: '정렬·필터 버그 수정' },
      { type: 'agent-name', agentName: 'sort-fix' },
      { type: 'user', timestamp: '2026-10-13T07:31:05.000Z', turnOrigin: 'sdk', message: { content: '시작' }, ...WORKTREE },
      { type: 'assistant', timestamp: '2026-10-13T07:40:50.000Z', ...WORKTREE, message: { stop_reason: null, content: [{ type: 'text', text: '고치는 중' }] } },
    ],
  }
  const RECORDS = '/home/me/Library/Application Support/Claude/claude-code-sessions/a/b'
  const commands: string[][] = []
  let touched = 0
  const clock = mock.clock(on)
  await clock.set(NOW)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('session.id', () => ({ value: SELF }))
  on('process.run', (_$, e) => {
    const text = (path: string) => transcript(...(files[path] ?? []))
    switch (e.argv[0]) {
      case 'find':
        return ran(
          e.argv.includes('*.jsonl')
            ? Object.keys(files)
                .map((path, index) => `${1_791_877_000 + index + touched} ${text(path).length} ${path}`)
                .join('\n')
            : [
                `${RECORDS}/local_p.json:"sessionId":"local_p","cliSessionId":"${PARENT}"`,
                `${RECORDS}/local_c.json:"sessionId":"local_c","cliSessionId":"${CHILD}"`,
                `${RECORDS}/local_c.json:"spawnedFrom":{"sessionId":"local_p"`,
              ].join('\n'),
        )
      case 'tail':
        return ran(text(String(e.argv[3])))
      case 'sh':
        return ran(text(String(e.argv[4])))
      default:
        commands.push([...e.argv])

        return ran('')
    }
  })
  const banners = () => commands.filter(command => command[0]?.startsWith(NOTIFIER))
  const texts = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    await ui.unmount()

    return found
  }

  await $.session.start({ cwd: '/work/edu', surface: 'terminal', isInteractive: true })
  const first = await texts()
  // The worktree's own name and the branch named after it are no name for the session.
  expect(first.some(text => /happy-davinci/.test(text))).toBe(false)
  expect(first.some(text => /sort-fix/.test(text))).toBe(false)
  expect(first.some(text => text === '정렬·필터 버그 수정')).toBe(true)
  expect(first.some(text => text === 'assets · ↳ 엔진 개선 사항')).toBe(true)
  // The starter only waits: one dim line under the session it started, and not counted out.
  expect(first).toContain('엔진 개선 사항 · 대원 1명 기다리는 중 · 10m째')
  expect(first.some(text => /^◌ 대원 1명 기다리는 중/.test(text))).toBe(false)
  expect(first.some(text => /대장님, 대원 1명 출동 중 · 대기 1명$/.test(text))).toBe(true)
  expect(first.some(text => /● 출동 1/.test(text))).toBe(true)
  expect(first.indexOf('엔진 개선 사항 · 대원 1명 기다리는 중 · 10m째')).toBeGreaterThan(
    first.indexOf('정렬·필터 버그 수정'),
  )

  // The started session finishes: its own finish is announced; its starter's wait ending,
  // with no word from it since, is not.
  files[childPath]?.push({
    type: 'assistant',
    timestamp: '2026-10-13T07:41:02.000Z',
    ...WORKTREE,
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '고쳤습니다' }] },
  })
  touched = 1
  for (let scan = 0; scan < 4; scan += 1) {
    await clock.advance(5000)
  }
  expect(banners().map(command => [command[2], command[4]])).toEqual([
    ['✓ assets 임무 완료', '정렬·필터 버그 수정'],
  ])

  // The app wakes the starter with the report, and it finishes: that is announced.
  files[parentPath]?.push(
    { type: 'user', timestamp: '2026-10-13T07:41:25.000Z', turnOrigin: 'sdk', message: { content: '세션이 끝났습니다' }, ...ASSETS },
    { type: 'assistant', timestamp: '2026-10-13T07:41:30.000Z', ...ASSETS, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '둘 다 끝났습니다' }] } },
  )
  touched = 2
  for (let scan = 0; scan < 4; scan += 1) {
    await clock.advance(5000)
  }
  expect(banners().map(command => command[2])).toEqual(['✓ assets 임무 완료', '✓ assets 임무 완료'])
  expect(banners().map(command => command[command.indexOf('--open') + 1])).toEqual([
    'claude://claude.ai/epitaxy/local_c',
    'claude://claude.ai/epitaxy/local_p',
  ])
})

test('a session that only waits on its wakeup is one dim line, not out at work; with a monitor of its own it is a card again', async (...harness) => {
  const set = {
    type: 'user',
    timestamp: '2026-10-13T07:40:36.000Z',
    message: { content: [{ type: 'tool_result', content: 'scheduled' }] },
    toolUseResult: { scheduledFor: Date.parse('2026-10-13T07:50:00.000Z'), clampedDelaySeconds: 564, wasClamped: false },
    ...DESK,
  }
  const world = {
    processes: '',
    entries: [
      { type: 'ai-title', aiTitle: 'nightly check' },
      { type: 'user', timestamp: '2026-10-13T07:40:30.000Z', turnOrigin: 'human', message: { content: '10분 뒤에 다시 봐줘' }, ...DESK },
      set,
      ended('2026-10-13T07:40:40.000Z', '10분 뒤에 다시 보겠습니다'),
    ] as object[],
  }
  const board = await boardOver(harness, EDU_PATH, NOW, world)

  const resting = await board.texts()
  expect(resting.some(text => /^nightly check · 알람 맞추고 쉬는 중 · .+째$/.test(text))).toBe(true)
  expect(resting.some(text => /대장님, 대기 1명$/.test(text))).toBe(true)
  expect(resting.some(text => /● 출동 0/.test(text))).toBe(true)

  // A monitor it started still runs: it is at work itself, and has its card.
  world.entries.splice(3, 0, {
    type: 'user',
    timestamp: '2026-10-13T07:40:38.000Z',
    message: { content: [{ type: 'tool_result', content: 'started' }] },
    toolUseResult: { taskId: 'bmon1', timeoutMs: 900_000, persistent: false },
    ...DESK,
  })
  await board.clock.advance(5000)
  const watching = await board.texts()
  expect(watching.some(text => /^◌ 보초 서는 중 · 모니터 1$/.test(text))).toBe(true)
  expect(watching.some(text => /^nightly check · /.test(text))).toBe(false)
  expect(watching.some(text => /대장님, 대원 1명 출동 중$/.test(text))).toBe(true)
})

test('a click the desktop app turns into a focus move on an unfocused pane opens the session, once; Tab in a focused pane opens nothing', async (...harness) => {
  const [$, on] = harness
  const world = {
    processes: '',
    entries: [
      { type: 'ai-title', aiTitle: 'review' },
      { type: 'user', timestamp: '2026-10-13T07:40:30.000Z', turnOrigin: 'human', message: { content: '봐줘' }, ...DESK },
      ended('2026-10-13T07:40:40.000Z'),
    ] as object[],
  }
  // The engine beneath: the ring moves.
  on('ui.focus', () => ({}))
  const board = await boardOver(harness, EDU_PATH, NOW, world)
  const opens = () => board.commands.filter(command => command[0] === 'open').length
  // A move of the ring onto 열기, as the engine raises it, and the work it set off settled.
  const focus = async (origin: { kind: 'person' } | { kind: 'plugin'; name: string }) => {
    await $.ui.focus({
      component: 'Pane',
      requestId: 'board',
      element: `open:${HARBOR}`,
      origin,
    } as unknown as Parameters<typeof $.ui.focus>[0])
    await board.clock.advance(1)
  }

  // The pane does not hold the keyboard: the click only moves the ring onto 열기. It opens.
  const unfocused = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await focus({ kind: 'person' })
  expect(board.commands).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_9'])
  expect(opens()).toBe(1)
  // Where the surface raises the press as well, that is the same click: no second open.
  await unfocused.press({ key: `open:${HARBOR}` })
  expect(opens()).toBe(1)
  // A press of its own later opens again; so does a focus a plugin moved, never.
  await board.clock.advance(2000)
  await unfocused.press({ key: `open:${HARBOR}` })
  expect(opens()).toBe(2)
  await focus({ kind: 'plugin', name: 'other' })
  expect(opens()).toBe(2)
  await unfocused.unmount()

  // The pane holds the keyboard: Tab or the arrows move the ring, and open nothing.
  const focused = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, isFocused: true } })
  await focus({ kind: 'person' })
  expect(opens()).toBe(2)
  await focused.press({ key: `open:${HARBOR}` })
  expect(opens()).toBe(3)
  await focused.unmount()
})
