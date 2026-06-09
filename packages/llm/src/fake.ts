import type { ApiHandler } from './types.js'

// Deterministic ApiHandler for tests and offline use. No network. Same prompt -> same answer,
// mirroring FakeEmbedding's role in @agentic-stigmergy/core. Not for production augmentation.
export class FakeApiHandler implements ApiHandler {
  constructor(private readonly prefix: string = 'augmented') {}

  async classifyText(prompt: string): Promise<string> {
    const firstLine = prompt.split('\n').find((l) => l.trim().length > 0) ?? ''
    return `${this.prefix}: ${firstLine.trim()}`
  }
}
