import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { browserLocalStore } from '../src/index.js'

// Run conformance suite against localStorage backend
runStoreConformanceTests(
  'store-browser-local',
  async () => {
    // Clear localStorage before each test factory call
    localStorage.clear()
    return browserLocalStore({ prefix: `test-${Date.now()}` })
  },
  async () => {
    localStorage.clear()
  },
)
