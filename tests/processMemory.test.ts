import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import {
  parseProcStatus,
  parsePsOutput,
  parseTasklistOutput,
  processMemoryMb
} from '../src/main/processMemory.ts'

test('linux VmRSS is read out of the status block', () => {
  const status = [
    'Name:\tjava',
    'State:\tS (sleeping)',
    'VmPeak:\t14680064 kB',
    'VmSize:\t14680064 kB',
    'VmRSS:\t  3512320 kB',
    'Threads:\t62'
  ].join('\n')
  assert.equal(parseProcStatus(status), 3430)
  // VmPeak and VmSize sit right beside it and are not the same number.
  assert.notEqual(parseProcStatus(status), Math.round(14680064 / 1024))
})

test('a status block without VmRSS reads as unknown, not zero', () => {
  assert.equal(parseProcStatus('Name:\tjava\nState:\tZ (zombie)\n'), null)
  assert.equal(parseProcStatus(''), null)
})

test('macOS ps output is kilobytes and nothing else', () => {
  assert.equal(parsePsOutput('  3512320\n'), 3430)
  assert.equal(parsePsOutput('\n'), null)
  assert.equal(parsePsOutput('0'), null)
})

/**
 * `tasklist` writes the memory field with a unit and thousands separators, and
 * which separator depends on the Windows display language — a dot on a Turkish
 * install, a comma on an English one.
 */
test('tasklist output is read under either display language', () => {
  const turkish = '"javaw.exe","12345","Console","1","3.512.320 K"\r\n'
  const english = '"javaw.exe","12345","Console","1","3,512,320 K"\r\n'
  assert.equal(parseTasklistOutput(turkish), 3430)
  assert.equal(parseTasklistOutput(english), 3430)
})

test('tasklist saying the process is gone reads as unknown', () => {
  assert.equal(parseTasklistOutput('INFO: No tasks are running which match the specified criteria.\r\n'), null)
  assert.equal(parseTasklistOutput(''), null)
})

/**
 * The parser is only half of it; the other half is that the command actually
 * produces something it can read. Measured against this very process.
 */
test('this process reports a believable size on the real platform', async (t) => {
  const mine = await processMemoryMb(process.pid)
  if (mine === null) {
    t.skip(`${process.platform} does not report process memory here`)
    return
  }
  assert.ok(mine > 5, `${mine} MB is too small to be a node process`)
  assert.ok(mine < 8192, `${mine} MB is too large to be this test`)

  // And it agrees with the platform's own tool, within the slack of two reads
  // taken a moment apart.
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const reference = Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(process.pid)])) / 1024)
    assert.ok(Math.abs(mine - reference) < 64, `${mine} MB vs ${reference} MB`)
  }
})

test('a process that does not exist reports unknown rather than throwing', async () => {
  // Nothing is running under this pid; the point is that it answers at all.
  assert.equal(await processMemoryMb(0x7ffffff0), null)
})
