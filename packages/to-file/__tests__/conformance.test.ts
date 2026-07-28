import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toFile } from '../src/index.js'

let dirs: string[] = []

runStoreConformanceTests(
  'toFile',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noydb-test-'))
    dirs.push(dir)
    return toFile({ dir })
  },
  async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true })
    }
    dirs = []
  },
)
