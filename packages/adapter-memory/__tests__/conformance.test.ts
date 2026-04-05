import { runAdapterConformanceTests } from '@noydb/test-adapter-conformance'
import { memory } from '../src/index.js'

runAdapterConformanceTests('memory', async () => memory())
