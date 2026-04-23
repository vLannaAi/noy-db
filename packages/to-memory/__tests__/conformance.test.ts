import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { memory } from '../src/index.js'

runStoreConformanceTests('memory', async () => memory())
