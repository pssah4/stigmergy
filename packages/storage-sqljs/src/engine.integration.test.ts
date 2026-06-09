import { defineEngineConformance } from '@stigmergy/storage-conformance'
import { createSqlJsStorage } from './index.js'

defineEngineConformance('sql.js (in-memory)', () => createSqlJsStorage())
