#!/usr/bin/env node
/**
 * tsup post-build hook: ensure both bin entry files are executable.
 *
 * tsup carries the shebang from the source file into the built file, but
 * it does NOT chmod +x the result. Without that, `npx noy-db` would
 * happen to work (npm rewrites bin shims via cmd-shim) but a direct
 * `./node_modules/.bin/noy-db` invocation would fail with EACCES.
 *
 * The list is kept in sync with the `entry` array in tsup.config.ts.
 */

import { chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '..', 'dist')

const bins = [
  'bin/create-noy-db.js',
  'bin/noy-db.js',
]

for (const rel of bins) {
  const target = path.join(dist, rel)
  await chmod(target, 0o755)
  console.log(`chmod +x ${rel}`)
}
