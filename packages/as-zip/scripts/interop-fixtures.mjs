// Writes 5 WinZip-AES-256 test fixtures to <repo-root>/tmp/interop/.
// Run after `pnpm build` in packages/as-zip.
// Usage: pnpm interop:fixtures  (from packages/as-zip)
import { writeZip } from '../dist/index.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const outDir = resolve(dir, '../../../tmp/interop')
const PW = 'noydb-interop-2026'

const enc = new TextEncoder()

const VECTORS = [
  { name: 'single-byte',   entryPath: 'single-byte.bin',    bytes: new Uint8Array([0x42]) },
  { name: 'sixteen-bytes', entryPath: 'sixteen-bytes.bin',  bytes: new Uint8Array(16) },
  { name: 'nonascii',      entryPath: 'données/résumé.txt', bytes: enc.encode('hello') },
  { name: 'onemib',        entryPath: 'onemib.bin',         bytes: new Uint8Array(1024 * 1024).fill(0xab) },
]

await mkdir(outDir, { recursive: true })

for (const v of VECTORS) {
  const archive = await writeZip([{ path: v.entryPath, bytes: v.bytes }], { password: PW })
  await writeFile(resolve(outDir, `${v.name}.zip`), archive)
  console.log(`  wrote ${v.name}.zip`)
}

console.log(`
Fixtures written to tmp/interop/
Password: ${PW}

For each tool:
  1. Open the zip — confirm it prompts for a password (not "corrupt archive")
  2. Enter the password — confirm contents extract correctly
  3. Record pass/fail in docs/interop-matrix.md
`)
