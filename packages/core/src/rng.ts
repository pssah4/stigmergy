// Seedable RNG plus a Beta sampler for the Thompson selection (ADR-04, ADR-13).
// Deterministic given a seed, so harness runs are reproducible.
//
// SECURITY (AUDIT F-12): mulberry32 is cryptographically weak by design. It is for
// reproducible selection only. Never use SeededRng for secrets, tokens, IDs, or nonces;
// use node:crypto for those.

export interface SeededRng {
  /** Next value in [0, 1). */
  next(): number
}

export function mulberry32(seed: number): SeededRng {
  let a = seed >>> 0
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

function normalSample(rng: SeededRng): number {
  let u1 = rng.next()
  if (u1 < 1e-12) u1 = 1e-12
  const u2 = rng.next()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Marsaglia-Tsang gamma sampler. */
function gammaSample(shape: number, rng: SeededRng): number {
  if (shape < 1) {
    const u = rng.next()
    return gammaSample(shape + 1, rng) * Math.pow(u < 1e-12 ? 1e-12 : u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normalSample(rng)
    let v = 1 + c * x
    if (v <= 0) continue
    v = v * v * v
    const u = rng.next()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    const safeU = u < 1e-12 ? 1e-12 : u
    if (Math.log(safeU) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Beta(a, b) via two gamma draws. Returns a value in [0, 1]. */
export function betaSample(a: number, b: number, rng: SeededRng): number {
  const x = gammaSample(a, rng)
  const y = gammaSample(b, rng)
  if (x + y === 0) return 0.5
  return x / (x + y)
}
