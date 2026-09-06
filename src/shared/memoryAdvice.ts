/**
 * How much memory a profile actually wants.
 *
 * Everyone's first instinct is to give Minecraft as much as the machine has,
 * and it is the wrong instinct: the Java garbage collector has to walk what it
 * was given, so a heap far larger than the game needs turns short, unnoticeable
 * pauses into long ones. The other direction is worse but at least it announces
 * itself — too little memory and the game crashes with OutOfMemoryError.
 *
 * The hard part is knowing what "needs" means for a particular profile. Counting
 * mods does not answer it: ninety-six small utility mods and ninety-six heavy
 * ones are not the same pack, and the number is the same. Nothing on disk answers
 * it reliably either — a mod's jar can be large because of textures and cost
 * almost nothing at runtime.
 *
 * So the launcher stops guessing as soon as it can. Every session records the
 * most memory the game actually held, and from the second launch onwards the
 * advice is a measurement of this pack on this machine. Until then it falls back
 * to what the profile weighs on disk, which is a rough signal and is described
 * as one.
 */

export interface MemoryAdvice {
  /** What the launcher would set, in MB. */
  recommendedMb: number
  /** Set only when the current value is worth saying something about. */
  warning?: 'too-low' | 'too-high' | 'starves-system'
  /**
   * The reason, as a translation template rather than a finished sentence.
   *
   * Building the sentence here would put a Turkish string with a number in it
   * in front of every player: the tables are keyed by source text, so a message
   * assembled from pieces matches no key and stays Turkish in all sixteen
   * languages.
   */
  reason: string
  reasonParams: Record<string, string | number>
  /** Whether the advice rests on measured sessions or on a guess. */
  basis: 'measured' | 'estimated'
}

/** Vanilla runs comfortably here; every step above is about mods. */
const BASE_MB = 2048

/**
 * Headroom over what the game was seen to use.
 *
 * A heap sized to the exact high-water mark collects constantly. Half again,
 * plus a fixed cushion, is enough that a heavier world than the one measured
 * does not immediately run out.
 */
const HEADROOM = 1.5
const CUSHION_MB = 768

/**
 * Weight on disk, as a stand-in until there is a measurement.
 *
 * Chosen over a mod count because it at least notices the difference between a
 * folder of small tweaks and one full of large content mods. It is still only a
 * proxy, and the advice says so.
 */
function fromDiskSize(modBytes: number): number {
  const megabytes = modBytes / 1_048_576
  if (megabytes < 1) return BASE_MB
  if (megabytes <= 50) return 3072
  if (megabytes <= 200) return 4096
  if (megabytes <= 500) return 6144
  return 8192
}

/** Rounded to the slider's own step so the advice is reachable by dragging. */
function toStep(megabytes: number): number {
  return Math.round(megabytes / 512) * 512
}

/** How close to its limit a session has to get before the peak stops meaning "enough". */
const PRESSED = 0.8

export interface MeasuredSession {
  peakMb: number
  /** The heap limit it ran under. */
  capMb: number
}

export function memoryAdvice(input: {
  currentMb: number
  /** Total size of the profile's mods on disk, in bytes. */
  modBytes: number
  /** The machine's total RAM, when it is known. */
  totalMb?: number
  /** Recent sessions of this profile that were measured. */
  sessions?: MeasuredSession[]
}): MemoryAdvice {
  const { currentMb, modBytes, totalMb, sessions = [] } = input

  const usable = sessions.filter(
    (session) =>
      Number.isFinite(session.peakMb) &&
      Number.isFinite(session.capMb) &&
      session.peakMb > 0 &&
      session.capMb > 0
  )

  // Sessions that finished with room to spare: the JVM could have taken more
  // and did not, so the peak is what the pack wanted.
  const settled = usable.filter((session) => session.peakMb < session.capMb * PRESSED)
  // Sessions that ran up against their limit say only "at least this much".
  const pressed = usable.filter((session) => session.peakMb >= session.capMb * PRESSED)

  const estimate = fromDiskSize(modBytes)
  const observedPeak = settled.length > 0 ? Math.max(...settled.map((session) => session.peakMb)) : null

  let wanted: number
  let basis: MemoryAdvice['basis']
  if (observedPeak !== null) {
    wanted = Math.max(BASE_MB, toStep(observedPeak * HEADROOM + CUSHION_MB))
    basis = 'measured'
  } else if (pressed.length > 0) {
    // It used everything it was given, every time. That is not a measurement of
    // what it needs, only a floor under it — so the estimate is raised to sit
    // above the limit it kept hitting rather than replaced by it.
    const highestCap = Math.max(...pressed.map((session) => session.capMb))
    wanted = Math.max(estimate, toStep(highestCap + 1024))
    basis = 'measured'
  } else {
    wanted = estimate
    basis = 'estimated'
  }

  // Never advise more than half the machine: the rest of the system, and
  // Minecraft's own non-heap memory, have to live in what is left.
  const ceiling = totalMb ? Math.max(2048, toStep(totalMb / 2)) : Number.POSITIVE_INFINITY
  const recommendedMb = toStep(Math.min(wanted, ceiling))

  const asGb = (megabytes: number): number => Number((megabytes / 1024).toFixed(1))
  const peakParams = { peak: asGb(observedPeak ?? 0) }

  // Leaving the system under 2 GB is the one that makes the whole computer
  // unusable rather than just the game, so it is checked first.
  if (totalMb && totalMb - currentMb < 2048) {
    return {
      recommendedMb,
      basis,
      warning: 'starves-system',
      reason: 'Bu makinede {total} GB var; bu kadarını oyuna verince sisteme yetecek kadarı kalmıyor.',
      reasonParams: { total: Math.round(totalMb / 1024) }
    }
  }

  if (currentMb < wanted - 512) {
    if (observedPeak !== null) {
      return {
        recommendedMb,
        basis,
        warning: 'too-low',
        reason: 'Oyun son oturumlarda {peak} GB kullandı; bu ayar ona yetmiyor.',
        reasonParams: peakParams
      }
    }
    return {
      recommendedMb,
      basis,
      warning: 'too-low',
      reason:
        pressed.length > 0
          ? 'Oyun kendisine verilen belleğin tamamını kullandı; bu ayar az görünüyor.'
          : 'Bu profil için az görünüyor; oyun bellek yetmediği için çökebilir.',
      reasonParams: {}
    }
  }

  // A heap well past what the profile needs is the case nobody suspects, so the
  // reason says out loud that more is not better.
  if (currentMb > recommendedMb + 2048) {
    return {
      recommendedMb,
      basis,
      warning: 'too-high',
      reason:
        observedPeak === null
          ? 'Bu profil için fazla görünüyor. Gereğinden büyük bellek çöp toplayıcıyı yavaşlatır, FPS düşer.'
          : 'Oyun son oturumlarda en fazla {peak} GB kullandı. Gereğinden büyük bellek çöp toplayıcıyı yavaşlatır, FPS düşer.',
      reasonParams: peakParams
    }
  }

  return {
    recommendedMb,
    basis,
    reason:
      observedPeak === null
        ? 'Bu profil için uygun görünüyor.'
        : 'Oyun son oturumlarda en fazla {peak} GB kullandı; bu ayar uygun.',
    reasonParams: peakParams
  }
}
