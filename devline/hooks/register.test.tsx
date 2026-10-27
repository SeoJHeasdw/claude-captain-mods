import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const ROW = {
  plugin: 'devline',
  component: 'ToolUse',
  props: {
    tool_use_id: 't1',
    tool: 'Bash',
    input: { command: 'git status\necho hi' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

const BAND = {
  plugin: 'devline',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

test('a tool row draws its badge and the first line of the command', async ($, on) => {
  await start($, on, 0)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...ROW, surface })
    expect(await ui.find({ type: 'Text', text: /SH/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^git status$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a shell row reads by what the call is for, and by its command when that is unsaid', async ($, on) => {
  await start($, on, 0)
  const ui = await $.ui.mount({
    ...ROW,
    surface: 'desktop',
    props: {
      ...ROW.props,
      input: { command: 'S=/private/tmp/x; ls "$S"', description: 'List the scratch folder' },
    },
  })
  expect(await ui.find({ type: 'Text', text: /^List the scratch folder$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /private/ })).toBeUndefined()
  await ui.unmount()
})

test('an errored MCP tool row names its server and tool', async ($, on) => {
  await start($, on, 0)
  const ui = await $.ui.mount({
    ...ROW,
    surface: 'desktop',
    props: { ...ROW.props, tool: 'mcp__slides__read_page', input: {}, isErrored: true },
  })
  expect(await ui.find({ type: 'Text', text: /MCP/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /slides · read_page/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBeDefined()
  await ui.unmount()
})

const AT = Date.parse('2026-10-13T08:00:00.000Z')
const ID = '12345678-1234-4123-8123-123456789abc'

const request = (stamp: string, written: object, served: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: stamp,
    message: {
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: served,
        cache_creation_input_tokens: 126,
        cache_creation: written,
      },
    },
  })

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Props = Omit<typeof BAND.props, 'isWorking'> & { isWorking: boolean }

const start = async ($: Engine, on: On, served: number) => {
  const clock = mock.clock(on)
  await clock.set(AT + 10 * 60_000)
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('session.id', () => ({ value: ID }))
  on('env.get', (_$, e) => ({
    value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-desktop' : '/home/me',
  }))
  on('process.run', (_$, e) => {
    switch (e.argv[0]) {
      case 'find':
        return ran(`/home/me/.claude/projects/-work-acme/${ID}.jsonl\n`)
      case 'tail':
        return ran(request('2026-10-13T08:00:00.000Z', { ephemeral_1h_input_tokens: 126 }, served))
      default:
        return ran(e.argv.includes('status') ? ' M a.ts\n?? b.ts\n' : 'main\n')
    }
  })
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })

  return {
    clock,
    read: async (surface: 'terminal' | 'desktop', props: Props = BAND.props) => {
      const ui = await $.ui.mount({ ...BAND, props, surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text.trim())
      await ui.unmount()

      return texts
    },
  }
}

test('the band stays quiet: project, branch with its uncommitted count, and the cache counting down', async ($, on) => {
  const { clock, read } = await start($, on, 428_278)

  for (const surface of SURFACES) {
    const texts = await read(surface)
    expect(texts).toEqual(['▍', 'acme', '⎇ main', '±2', 'cache 50m'])
  }

  // While a turn runs, its requests keep the cache at its full life.
  expect(await read('desktop', { ...BAND.props, isWorking: true })).toContain('cache 60m')

  await clock.advance(47 * 60_000)
  expect(await read('desktop')).toContain('cache 3m')

  await clock.advance(5 * 60_000)
  expect(await read('desktop')).toContain('cache 만료')
})

test('a request the cache barely served is called a miss', async ($, on) => {
  const { read } = await start($, on, 20)

  expect(await read('desktop')).toContain('cache miss (hit 13%)')
})

test('in a session another client hosts, the mod draws nothing and the app draws its own', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: 'claude-vscode' }))
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>the app's own</Text>
  })

  await $.session.start({ cwd: '/work/acme', surface: 'vscode', isInteractive: true })

  const row = await $.ui.mount({ ...ROW, surface: 'vscode' })
  expect(await row.find({ type: 'Text', text: /the app's own/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /SH/ })).toBeUndefined()
  await row.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /acme|cache/ })).toBeUndefined()
  await band.unmount()
})
