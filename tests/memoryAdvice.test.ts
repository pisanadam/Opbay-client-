import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryAdvice } from '../src/shared/memoryAdvice.ts'

const MB = 1_048_576
const SMALL_PACK = 30 * MB
const BIG_PACK = 700 * MB

test('with nothing measured the advice says it is an estimate', () => {
  const advice = memoryAdvice({ currentMb: 2048, modBytes: 0, totalMb: 16384 })
  assert.equal(advice.basis, 'estimated')
  assert.equal(advice.recommendedMb, 2048)
  assert.equal(advice.warning, undefined)
})

/**
 * The whole point of measuring: the same number of mods can be a folder of
 * small tweaks or one full of heavy content, and the count cannot tell them
 * apart. Weight on disk at least notices.
 */
test('a heavy pack and a light one get different estimates', () => {
  const light = memoryAdvice({ currentMb: 4096, modBytes: SMALL_PACK, totalMb: 16384 })
  const heavy = memoryAdvice({ currentMb: 4096, modBytes: BIG_PACK, totalMb: 16384 })
  assert.ok(heavy.recommendedMb > light.recommendedMb, `${heavy.recommendedMb} vs ${light.recommendedMb}`)
  assert.equal(light.basis, 'estimated')
  assert.equal(heavy.basis, 'estimated')
})

test('a measured session replaces the estimate and says so', () => {
  const advice = memoryAdvice({
    currentMb: 14336,
    modBytes: BIG_PACK,
    totalMb: 32768,
    // Reached 3.4 GB with 14 GB available: it had every chance to take more.
    sessions: [{ peakMb: 3482, capMb: 14336 }]
  })
  assert.equal(advice.basis, 'measured')
  assert.equal(advice.warning, 'too-high')
  assert.match(advice.reason, /\{peak\} GB/)
  assert.equal(advice.reasonParams.peak, 3.4)
  // 3.4 GB observed, half again plus the cushion, rounded to the slider step.
  assert.equal(advice.recommendedMb, 6144)
})

/**
 * The trap in measuring: a game that reached 1.9 GB under a 2 GB limit may have
 * wanted far more and simply had nowhere to go. Reading that as "1.9 GB is
 * enough" would pin a starved profile to the setting that starved it.
 */
test('a peak pressed against its limit is not read as enough', () => {
  const pressed = memoryAdvice({
    currentMb: 2048,
    modBytes: BIG_PACK,
    totalMb: 16384,
    sessions: [{ peakMb: 1950, capMb: 2048 }]
  })
  assert.equal(pressed.warning, 'too-low')
  // Above the limit it kept hitting, and never down at the peak itself.
  assert.ok(pressed.recommendedMb > 2048, String(pressed.recommendedMb))
  assert.doesNotMatch(pressed.reason, /\{peak\}/)

  // The same peak with room to spare is the opposite reading.
  const settled = memoryAdvice({
    currentMb: 8192,
    modBytes: BIG_PACK,
    totalMb: 16384,
    sessions: [{ peakMb: 1950, capMb: 8192 }]
  })
  assert.equal(settled.warning, 'too-high')
  assert.ok(settled.recommendedMb < 8192, String(settled.recommendedMb))
})

test('the highest settled session wins, and pressed ones do not drag it down', () => {
  const advice = memoryAdvice({
    currentMb: 12288,
    modBytes: BIG_PACK,
    totalMb: 32768,
    sessions: [
      { peakMb: 1200, capMb: 12288 },
      { peakMb: 5200, capMb: 12288 },
      { peakMb: 2000, capMb: 2048 }
    ]
  })
  assert.equal(advice.reasonParams.peak, 5.1)
  assert.equal(advice.recommendedMb, 8704)
})

test('a session with no usable numbers is ignored', () => {
  const advice = memoryAdvice({
    currentMb: 4096,
    modBytes: SMALL_PACK,
    totalMb: 16384,
    sessions: [{ peakMb: 0, capMb: 4096 }, { peakMb: 2000, capMb: 0 }]
  })
  assert.equal(advice.basis, 'estimated')
})

test('the advice never claims more than half the machine', () => {
  const advice = memoryAdvice({
    currentMb: 4096,
    modBytes: BIG_PACK,
    totalMb: 8192,
    sessions: [{ peakMb: 6000, capMb: 16384 }]
  })
  assert.equal(advice.recommendedMb, 4096)
})

test('leaving the system without 2 GB is caught before anything else', () => {
  const advice = memoryAdvice({ currentMb: 7168, modBytes: 0, totalMb: 8192 })
  assert.equal(advice.warning, 'starves-system')
  assert.equal(advice.reasonParams.total, 8)
})

test('close enough is left alone', () => {
  for (const currentMb of [5632, 6144, 7168, 8192]) {
    const advice = memoryAdvice({
      currentMb,
      modBytes: BIG_PACK,
      totalMb: 32768,
      sessions: [{ peakMb: 3482, capMb: 14336 }]
    })
    assert.equal(advice.warning, undefined, String(currentMb))
  }
})

test('the recommendation always lands on the slider step', () => {
  for (const modBytes of [0, 10 * MB, 120 * MB, 400 * MB, 2000 * MB]) {
    for (const totalMb of [4096, 8192, 16384, 65536]) {
      for (const sessions of [[], [{ peakMb: 3333, capMb: 16384 }], [{ peakMb: 3900, capMb: 4096 }]]) {
        const { recommendedMb } = memoryAdvice({ currentMb: 4096, modBytes, totalMb, sessions })
        assert.equal(recommendedMb % 512, 0, `${modBytes} / ${totalMb}`)
        assert.ok(recommendedMb >= 2048)
        assert.ok(recommendedMb <= Math.max(2048, totalMb / 2))
      }
    }
  }
})
