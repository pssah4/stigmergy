import type { CapabilityAugmenter } from '../api-types.js'

// Deterministic CapabilityAugmenter for tests and conformance (FEAT-01-07). Counts calls so a
// test can assert the once-per-capability guard (SC-01), and can be set to fail so a test can
// assert the fallback to the raw description (SC-04). Not for production augmentation.
export class FakeAugmenter implements CapabilityAugmenter {
  calls = 0

  constructor(private readonly opts: { model?: string; fail?: boolean } = {}) {}

  async augment(input: { id: string; type: string; description: string }): Promise<{ description: string; model: string } | null> {
    this.calls++
    if (this.opts.fail) return null
    return { description: `aug(${input.description})`, model: this.opts.model ?? 'fake-model' }
  }
}
