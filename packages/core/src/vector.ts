// Pure vector helpers shared by consult (eta term) and the outcome tracker
// (topic-shift detection). cosine is dimension-checked.

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Parse an ISO-8601 timestamp to epoch milliseconds (Edge.lastUpdated is ISO; decay computes in ms). */
export function isoToMs(iso: string): number {
  return Date.parse(iso)
}

/** Format epoch milliseconds (from the injected clock) as an ISO-8601 string for storage. */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString()
}
