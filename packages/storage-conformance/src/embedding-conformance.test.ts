import { FakeEmbedding } from '@agentic-stigmergy/core'
import { defineEmbeddingConformance } from './embedding-conformance.js'

// The deterministic test double must satisfy the same EmbeddingPort contract that
// every real adapter will run (FEAT-01-05).
defineEmbeddingConformance('FakeEmbedding', async () => new FakeEmbedding())
