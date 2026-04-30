/**
 * `noydb verify <file.noydb>` — integrity check.
 *
 * Validates the three integrity properties of a bundle that can be
 * verified **without the passphrase**:
 *
 *   1. Magic prefix + format version match what this CLI supports.
 *   2. Header parses as JSON with the minimum-disclosure key set.
 *   3. Compressed body SHA-256 matches `header.bodySha256`.
 *
 * Ledger-head verification (which does need the passphrase) is not
 * covered here — that's a future enhancement when an `open` subcommand
 * lands. For now, `verify` answers "was this file transmitted intact?"
 * without involving keys.
 *
 * @module
 */
import { readNoydbBundle, readNoydbBundleHeader } from '@noy-db/hub'
import { readFile } from 'node:fs/promises'

export interface VerifyReport {
  ok: boolean
  file: string
  handle: string
  bodyBytes: number
  checks: { magic: boolean; header: boolean; bodyHash: boolean }
  error?: string
}

export async function verify(filePath: string): Promise<VerifyReport> {
  const bytes = new Uint8Array(await readFile(filePath))
  const checks = { magic: false, header: false, bodyHash: false }

  let handle = ''
  let bodyBytes = 0

  try {
    const header = readNoydbBundleHeader(bytes)
    checks.magic = true
    checks.header = true
    handle = header.handle
    bodyBytes = header.bodyBytes

    // readNoydbBundle() verifies bodySha256 internally — if it doesn't
    // throw, the body hash matched.
    await readNoydbBundle(bytes)
    checks.bodyHash = true

    return { ok: true, file: filePath, handle, bodyBytes, checks }
  } catch (err) {
    return {
      ok: false, file: filePath, handle, bodyBytes, checks,
      error: (err as Error).message,
    }
  }
}

export async function runVerify(argv: readonly string[]): Promise<number> {
  const file = argv[0]
  if (!file) {
    process.stderr.write('usage: noydb verify <file.noydb>\n')
    return 2
  }
  const report = await verify(file)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return report.ok ? 0 : 1
}
