import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * How much memory a running process is actually using.
 *
 * The launcher can guess what a profile needs from what is in it, and the guess
 * is only ever a guess: ninety-six small utility mods and ninety-six heavy ones
 * are not the same profile, and nothing on disk reliably says which is which.
 * The game itself knows. Sampling it while it runs turns the advice from a
 * heuristic into a measurement of this pack, on this machine.
 *
 * Resident set size rather than heap: no portable way to ask a JVM for its heap
 * without attaching to it, and RSS is the number that decides whether the
 * machine starts swapping. It counts more than the heap — the JVM's own code,
 * class metadata, the graphics driver — so it reads a little above `-Xmx`
 * territory, which for "is this setting sane" is the right direction to err.
 */

/** `/proc/<pid>/status` reports VmRSS in kilobytes. */
export function parseProcStatus(text: string): number | null {
  const found = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text)
  return found ? Math.round(Number(found[1]) / 1024) : null
}

/** `ps -o rss= -p <pid>` prints kilobytes and nothing else. */
export function parsePsOutput(text: string): number | null {
  const value = Number(text.trim())
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1024) : null
}

/**
 * `tasklist /FO CSV` quotes every field and writes the memory one with a unit
 * and thousands separators — `"312.480 K"` under a Turkish Windows, `"312,480
 * K"` under an English one. Both separators are stripped rather than parsed.
 */
export function parseTasklistOutput(text: string): number | null {
  const line = text.split(/\r?\n/).find((candidate) => /"\s*[\d.,]+\s*K"\s*$/.test(candidate))
  if (!line) return null
  const field = /"([\d.,]+)\s*K"\s*$/.exec(line)
  if (!field) return null
  const kilobytes = Number(field[1].replace(/[.,]/g, ''))
  return Number.isFinite(kilobytes) && kilobytes > 0 ? Math.round(kilobytes / 1024) : null
}

/** Resident memory of one process in MB, or null when it cannot be read. */
export async function processMemoryMb(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      return parseProcStatus(await fsp.readFile(`/proc/${pid}/status`, 'utf8'))
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)])
      return parsePsOutput(stdout)
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      return parseTasklistOutput(stdout)
    }
    return null
  } catch {
    // The process is gone, or the platform will not say. Either way there is
    // nothing to record, and a failed measurement must not touch the game.
    return null
  }
}

/**
 * Watches one process and reports the most it ever used.
 *
 * Sampled rather than continuous: the number wanted is a high-water mark over a
 * session measured in hours, and a reading every half minute finds it without
 * spawning a subprocess anybody would notice. The first sample waits, because
 * a JVM in its first seconds has not loaded the pack yet and its memory then
 * says nothing about what the pack needs.
 */
export function watchPeakMemory(pid: number, intervalMs = 30_000): { stop: () => number | null } {
  let peakMb: number | null = null
  let stopped = false

  const sample = async (): Promise<void> => {
    if (stopped) return
    const current = await processMemoryMb(pid)
    if (current !== null && (peakMb === null || current > peakMb)) peakMb = current
  }

  const timer = setInterval(() => void sample(), intervalMs)
  // Never keep the launcher alive on this alone.
  timer.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      return peakMb
    }
  }
}
