// Injectable clock so all time-dependent computation stays deterministic in
// tests (ADR-06).

export interface ClockProvider {
  /** Unix timestamp in milliseconds. */
  now(): number
}

export class SystemClock implements ClockProvider {
  now(): number {
    return Date.now()
  }
}

export class FixedClock implements ClockProvider {
  constructor(private time: number) {}

  now(): number {
    return this.time
  }

  set(time: number): void {
    this.time = time
  }

  advance(deltaMs: number): void {
    this.time += deltaMs
  }
}
