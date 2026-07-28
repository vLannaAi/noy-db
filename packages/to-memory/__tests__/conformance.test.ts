import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toMemory } from '../src/index.js'

runStoreConformanceTests('memory', async () => toMemory())
