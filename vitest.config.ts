import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'examples/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Resolve workspace packages to their TS source so tests run without a build step.
      '@agentic-stigmergy/core': r('./packages/core/src/index.ts'),
      '@stigmergy/storage-conformance': r('./packages/storage-conformance/src/index.ts'),
      '@stigmergy/storage-sqljs': r('./packages/storage-sqljs/src/index.ts'),
      '@stigmergy/storage-better-sqlite3': r('./packages/storage-better-sqlite3/src/index.ts'),
      '@agentic-stigmergy/loop': r('./packages/loop/src/index.ts'),
      '@stigmergy/harness': r('./packages/harness/src/index.ts'),
      '@stigmergy/connect': r('./packages/connect/src/index.ts'),
      '@stigmergy/cli': r('./packages/cli/src/index.ts'),
      '@stigmergy/llm': r('./packages/llm/src/index.ts'),
    },
  },
})
