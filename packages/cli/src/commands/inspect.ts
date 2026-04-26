/**
 * `noydb inspect <file.noydb>` — print the unencrypted header.
 *
 * This command is the security-sensitive one in the CLI: it must
 * never prompt for a passphrase and never decrypt anything. It reads
 * exactly the unencrypted header bytes (magic + flags + header
 * length prefix + JSON header) and returns structured metadata.
 *
 * What the header reveals:
 *   - `formatVersion` — container format version
 *   - `handle`        — ULID identifier
 *   - `bodyBytes`     — compressed body size
 *   - `bodySha256`    — body integrity hash
 *
 * What it does **not** reveal: record counts, collection names,
 * ciphertext, keyring, timestamps inside records. Those live past
 * the decryption boundary.
 *
 * @module
 */
import { readNoydbBundleHeader } from '@noy-db/hub'
import { readFile } from 'node:fs/promises'

export interface InspectResult {
  formatVersion: number
  handle: string
  bodyBytes: number
  bodySha256: string
}

export async function inspect(filePath: string): Promise<InspectResult> {
  const bytes = await readFile(filePath)
  const header = readNoydbBundleHeader(new Uint8Array(bytes))
  return {
    formatVersion: header.formatVersion,
    handle: header.handle,
    bodyBytes: header.bodyBytes,
    bodySha256: header.bodySha256,
  }
}

export async function runInspect(argv: readonly string[]): Promise<number> {
  const file = argv[0]
  if (!file) {
    process.stderr.write('usage: noydb inspect <file.noydb>\n')
    return 2
  }
  try {
    const info = await inspect(file)
    process.stdout.write(JSON.stringify(info, null, 2) + '\n')
    return 0
  } catch (err) {
    process.stderr.write(`inspect failed: ${(err as Error).message}\n`)
    return 1
  }
}
