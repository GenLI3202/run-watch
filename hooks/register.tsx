import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Watch, WatchStatus } from '../types'

const KEY = 'watches'
const POLL_MS = 60_000
const TAIL_BYTES = 16_384
const MAX_WATCHES = 12
const DEFAULT_STALL_MIN = 30
// Narrow on purpose: a simulation log is full of "error" meaning a metric, so a bare word never fails a run.
const DEFAULT_FAIL = /Traceback \(most recent call last\)|\bFATAL\b|Segmentation fault|\bKilled\b|CUDA out of memory|MemoryError|OutOfMemory/
const COLORS: Record<WatchStatus, string | undefined> = { running: undefined, stalled: '#E0A030', done: '#2FB67A', failed: '#E5484D', lost: '#E5484D' }

const watches = atom({ plugin: 'run-watch', key: 'watches' } as const, [], { shape: 'watches-1' })
const now = atom({ plugin: 'run-watch', key: 'now' } as const, 0)

let cancelPoll: (() => void) | null = null
let lastPollAt = 0

const pad = (n: number): string => String(n).padStart(2, '0')
const span = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${pad(m % 60)}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function safeRegex(source: string | undefined, flags = 'i'): RegExp | null {
  if (!source || source.length > 200) return null
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

// The last "a/b" or "n%" the log tail shows, as a fraction of the way through.
function progressOf(text: string, custom?: string): number | undefined {
  const lines = text.split('\n').slice(-60).reverse()
  const re = safeRegex(custom, '')
  for (const line of lines) {
    if (re) {
      const m = re.exec(line)
      if (!m) continue
      if (m[2] !== undefined && Number(m[2]) > 0) return Math.min(1, Number(m[1]) / Number(m[2]))
      if (m[1] !== undefined) return Math.min(1, Number(m[1]) / 100)
      continue
    }
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(line)
    if (pct) return Math.min(1, Number(pct[1]) / 100)
    const frac = /(\d+)\s*\/\s*(\d+)/.exec(line)
    if (frac && Number(frac[2]) > 0 && Number(frac[1]) <= Number(frac[2])) return Number(frac[1]) / Number(frac[2])
  }
  return undefined
}

async function save($: EngineInterface, list: Watch[]) {
  await update($, watches, () => list)
  await $.store.set(KEY, list as never)
}

async function tell($: EngineInterface, w: Watch, text: string) {
  $.ui.toast(text)
  await $.process
    .run(['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Claude Code run-watch" sound name "Glass"', '-e', 'end run', text], { timeoutMs: 5000 })
    .catch(() => undefined)
}

// One look at one run: the file, its tail, the process. Returns the updated record.
async function look($: EngineInterface, w: Watch, at: number): Promise<Watch> {
  let size = 0
  let mtimeMs = 0
  try {
    const st = await $.fs.stat(w.path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return { ...w, status: 'lost', note: 'log file not found' }
  }
  const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), w.path], { timeoutMs: 8000 }).then(r => r.stdout, () => '')
  const grew = size !== w.lastSize
  const next: Watch = { ...w, lastSize: size, lastGrowAt: grew ? Math.max(at, mtimeMs) : w.lastGrowAt }

  const frac = progressOf(tail, w.progress)
  if (frac !== undefined) {
    next.frac = frac
    if (next.firstFrac === undefined) {
      next.firstFrac = frac
      next.firstAt = at
    }
  }
  const failRe = safeRegex(w.fail) ?? DEFAULT_FAIL
  if (failRe.test(tail)) return { ...next, status: 'failed', note: 'the log shows a failure' }

  const doneRe = safeRegex(w.done)
  if (doneRe?.test(tail)) return { ...next, status: 'done', note: 'finish line found in the log' }
  if (w.pid !== undefined) {
    const alive = await $.process.run(['ps', '-p', String(w.pid)], { timeoutMs: 4000 }).then(r => r.exitCode === 0, () => true)
    if (!alive) return { ...next, status: doneRe ? 'failed' : 'done', note: doneRe ? 'process ended before the finish line' : 'process ended' }
  } else if (!doneRe && next.frac !== undefined && next.frac >= 1) {
    return { ...next, status: 'done', note: 'progress reached 100%' }
  }
  const quiet = at - next.lastGrowAt
  if (quiet > w.stallMin * 60_000) return { ...next, status: 'stalled', note: `no new output for ${span(quiet)}` }
  return { ...next, status: 'running', note: '' }
}

async function poll($: EngineInterface) {
  lastPollAt = await $.clock.now()
  const list = await read($, watches)
  if (!list.some(w => w.status === 'running' || w.status === 'stalled')) return
  const at = lastPollAt
  const out: Watch[] = []
  for (const w of list) {
    if (w.status === 'done' || w.status === 'failed' || w.status === 'lost') {
      out.push(w)
      continue
    }
    const next = await look($, w, at)
    const changed = next.status !== w.status
    if (changed && next.status !== 'running') {
      const label = next.status === 'done' ? 'finished' : next.status === 'failed' ? 'failed' : next.status === 'stalled' ? 'stalled' : 'lost'
      await tell($, next, `${next.name} ${label}${next.note ? `: ${next.note}` : ''}`)
      next.isTold = true
    }
    out.push(next)
  }
  await save($, out)
  await update($, now, () => at)
}

async function ensurePoll($: EngineInterface) {
  const at = await $.clock.now()
  if (cancelPoll && at - lastPollAt < POLL_MS * 3) return
  cancelPoll?.()
  lastPollAt = at
  cancelPoll = $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
}

function tokens(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

function etaOf(w: Watch, at: number): string {
  if (w.frac === undefined || w.firstFrac === undefined || w.firstAt === undefined || w.frac <= w.firstFrac || w.frac >= 1) return ''
  const rate = (w.frac - w.firstFrac) / (at - w.firstAt)
  return rate > 0 ? ` · ${span((1 - w.frac) / rate)} left` : ''
}

async function add($: EngineInterface, args: string[]): Promise<string> {
  const flags: Record<string, string> = {}
  const plain: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a.startsWith('--') && i + 1 < args.length) flags[a.slice(2)] = args[++i] ?? ''
    else plain.push(a)
  }
  const raw = plain[0]
  if (!raw) return 'Usage: /watch <log file> [name] [--pid N] [--done REGEX] [--fail REGEX] [--progress REGEX] [--stall 30m]'
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const path = raw.startsWith('/') ? raw : raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : `${cwd}/${raw}`
  if (!(await $.fs.exists(path))) return `No such file: ${path}`
  const list = await read($, watches)
  if (list.filter(w => w.status === 'running' || w.status === 'stalled').length >= MAX_WATCHES) return `Already watching ${MAX_WATCHES} runs.`
  for (const key of ['done', 'fail', 'progress'])
    if (flags[key] && !safeRegex(flags[key])) return `--${key} is not a usable pattern (up to 200 characters).`
  const stall = /^(\d+)\s*(m|h)?$/i.exec(flags.stall ?? '')
  const stallMin = stall ? Math.max(1, Number(stall[1]) * (stall[2]?.toLowerCase() === 'h' ? 60 : 1)) : DEFAULT_STALL_MIN
  const pid = flags.pid && /^\d+$/.test(flags.pid) ? Number(flags.pid) : undefined
  const at = await $.clock.now()
  const st = await $.fs.stat(path)
  const id = Math.max(0, ...list.map(w => w.id)) + 1
  const name = (plain[1] ?? raw.split('/').pop() ?? raw).slice(0, 40)
  const w: Watch = { id, name, path, pid, done: flags.done, fail: flags.fail, progress: flags.progress, stallMin, status: 'running', createdAt: at, lastSize: st.size, lastGrowAt: Math.max(at, st.mtimeMs), isTold: false, note: '' }
  await save($, [...list, await look($, w, at)])
  await update($, now, () => at)
  await ensurePoll($)
  return `Watching ${name} (#${id}): checks every minute, no model calls.`
}

async function describe($: EngineInterface): Promise<string> {
  const list = await read($, watches)
  if (list.length === 0) return 'No runs watched. /watch <log file> starts one.'
  const at = await $.clock.now()
  return list
    .map(w => `#${w.id} ${w.name}  ${w.status}${w.frac !== undefined ? `  ${Math.round(w.frac * 100)}%${etaOf(w, at)}` : ''}${w.note ? `  (${w.note})` : ''}`)
    .join('\n')
}

async function drop($: EngineInterface, id: number) {
  await save($, (await read($, watches)).filter(w => w.id !== id))
}

async function clearFinished($: EngineInterface) {
  await save($, (await read($, watches)).filter(w => w.status === 'running' || w.status === 'stalled'))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'watch',
      description: 'Watch a long run from its log: /watch <log> [name] [--pid N] [--done RE] [--fail RE] [--progress RE] [--stall 30m] | list | stop <#> | clear',
      argumentHint: '<log file> [name] [--pid N] | list | stop <#> | clear',
      immediate: true,
    })
    try {
      const saved = await $.store.get(KEY)
      if (Array.isArray(saved) && saved.length > 0) await update($, watches, () => saved as never)
    } catch {
      // Nothing stored.
    }
    await ensurePoll($)
    return started
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    const args = tokens(String(e.args ?? ''))
    const word = args[0]?.toLowerCase()
    if (!word || word === 'list' || word === 'status') return { text: await describe($) }
    if (word === 'clear') {
      await clearFinished($)
      return { text: 'Cleared the finished runs.' }
    }
    if (word === 'stop') {
      const id = Number((args[1] ?? '').replace('#', ''))
      if (!Number.isInteger(id)) return { text: 'Usage: /watch stop <#>' }
      await drop($, id)
      return { text: `Stopped watching #${id}.` }
    }
    return { text: await add($, args) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const list = await read($, watches)
    if (list.length === 0 || e.props.hasSurvey) return rest
    await read($, now)
    const at = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = list.slice(-3)
    const hasEnded = list.some(w => w.status === 'done' || w.status === 'failed' || w.status === 'lost')
    return (
      <Box flexDirection="column">
        {rest}
        <Box gap="md" flexWrap="wrap" alignItems="center">
          <Text dimColor>runs</Text>
          {shown.map(w => (
            <Text key={`w${w.id}`} color={COLORS[w.status]}>
              {w.status === 'done' ? '✓ ' : w.status === 'failed' || w.status === 'lost' ? '✗ ' : w.status === 'stalled' ? '⚠ ' : ''}
              {w.name}
              {w.frac !== undefined && w.status === 'running' ? ` ${Math.round(w.frac * 100)}%${etaOf(w, at)}` : ''}
              {w.status !== 'running' && w.note ? ` · ${w.note}` : ''}
            </Text>
          ))}
          {list.length > shown.length && <Text dimColor>+{list.length - shown.length}</Text>}
          {hasEnded && <Button key="clear" label="Clear finished" onPress={() => clearFinished($)} />}
        </Box>
      </Box>
    )
  })
}
