import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const START = 1_000_000_000

// The machine beneath the mod: one log file whose size, tail and process the test moves.
const setup = (on: Parameters<typeof mock.clock>[0]) => {
  const clock = mock.clock(on, { now: START })
  const world = { size: 1000, mtimeMs: START - MIN, tail: 'step 30/100\n', alive: true, exists: true }
  const toasts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'watch' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.exists', () => ({ value: world.exists }))
  on('fs.stat', () => ({ value: { size: world.size, mtimeMs: world.mtimeMs } }) as never)
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[0] === 'tail') return { value: { exitCode: 0, stdout: world.tail, stderr: '' } } as never
    if (argv[0] === 'ps') return { value: { exitCode: world.alive ? 0 : 1, stdout: '', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { clock, world, toasts }
}

const watch = ($: Parameters<Parameters<typeof test>[1]>[0], args: string) => $.command.run({ command: 'watch', args })

test('progress comes from the log tail, with an ETA once it moves', async ($, on) => {
  const { clock, world } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect((await watch($, 'run.log sim --pid 4242')).text).toMatch(/Watching sim/)
  expect((await watch($, 'list')).text).toMatch(/sim\s+running\s+30%/)

  world.size += 500
  world.tail = 'step 60/100\n'
  await clock.advance(10 * MIN)
  expect((await watch($, 'list')).text).toMatch(/60%.*left/)
})

test('a run whose process ends is done, and it is told once', async ($, on) => {
  const { clock, world, toasts } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await watch($, 'run.log sim --pid 4242')
  world.alive = false
  await clock.advance(2 * MIN)
  expect((await watch($, 'list')).text).toMatch(/done/)
  expect(toasts.filter(t => /sim finished/.test(t))).toHaveLength(1)
  await clock.advance(5 * MIN)
  expect(toasts.filter(t => /sim finished/.test(t))).toHaveLength(1)
})

test('a traceback fails the run; the word error alone does not', async ($, on) => {
  const { clock, world, toasts } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await watch($, 'run.log sim')
  world.size += 10
  world.tail = 'mean abs error 0.031\nstep 31/100\n'
  await clock.advance(2 * MIN)
  expect((await watch($, 'list')).text).toMatch(/running/)
  world.size += 10
  world.tail += 'Traceback (most recent call last):\n  File "x.py"\n'
  await clock.advance(2 * MIN)
  expect((await watch($, 'list')).text).toMatch(/failed/)
  expect(toasts.join(' ')).toMatch(/sim failed/)
})

test('a log that stops growing is stalled after the stall time', async ($, on) => {
  const { clock, toasts } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await watch($, 'run.log sim --stall 20m')
  await clock.advance(10 * MIN)
  expect((await watch($, 'list')).text).toMatch(/running/)
  await clock.advance(15 * MIN)
  expect((await watch($, 'list')).text).toMatch(/stalled/)
  expect(toasts.join(' ')).toMatch(/sim stalled/)
})

test('bad input is turned away; stop and clear tidy up', async ($, on) => {
  const { world } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect((await watch($, 'run.log sim --done "("')).text).toMatch(/not a usable pattern/)
  world.exists = false
  expect((await watch($, 'nope.log')).text).toMatch(/No such file/)
  world.exists = true
  await watch($, 'run.log sim')
  expect((await watch($, 'stop 1')).text).toMatch(/Stopped watching #1/)
  expect((await watch($, 'list')).text).toMatch(/No runs watched/)
})

test('the band lists the runs, in a sentence per run', async ($, on) => {
  const { clock, world } = setup(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await watch($, 'run.log sim --pid 4242')
  const ui = await $.ui.mount({ plugin: 'run-watch', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /sim 30%/ })).toBeDefined()
  world.alive = false
  await clock.advance(2 * MIN)
  expect(await ui.find({ type: 'Text', text: /✓ sim/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Clear finished/ })).toBeDefined()
})
