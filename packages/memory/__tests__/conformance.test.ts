import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { memory } from '../src/index.js'

runAdapterConformanceTests('memory', async () => memory())
