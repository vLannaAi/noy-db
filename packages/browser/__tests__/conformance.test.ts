import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { browser } from '../src/index.js'

// Run conformance suite against localStorage backend
runAdapterConformanceTests(
  'browser (localStorage)',
  async () => {
    // Clear localStorage before each test factory call
    localStorage.clear()
    return browser({ prefix: `test-${Date.now()}`, backend: 'localStorage' })
  },
  async () => {
    localStorage.clear()
  },
)
