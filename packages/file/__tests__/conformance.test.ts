import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { jsonFile } from '../src/index.js'

let dirs: string[] = []

runAdapterConformanceTests(
  'jsonFile',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noydb-test-'))
    dirs.push(dir)
    return jsonFile({ dir })
  },
  async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true })
    }
    dirs = []
  },
)
