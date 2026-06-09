import { defineEngineConformance } from '@stigmergy/storage-conformance'
import { BetterSqlite3Storage } from './index.js'

defineEngineConformance('better-sqlite3 (:memory:)', async () => new BetterSqlite3Storage(':memory:'))
