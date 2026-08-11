/**
 * `writePod` / `writePod` option-key validation (#991).
 *
 * `autoPassphrases` was renamed to `autoSecrets` during the `passphrase-*` →
 * `secret-*` storm, and then generalised again to `autoCredentials`. Unlike
 * every other rename in that set, the old key failed SILENTLY: the option is
 * optional, so nothing rejected it at build time, and the write path simply
 * never populated the slot. The result was a structurally valid pod whose
 * one-click demo login was dead — reported by niwat-app, caught only by a
 * runtime round-trip assertion in their own suite.
 *
 * Wire-format options are exactly where silent-drop is most expensive: the
 * artifact looks fine and the defect surfaces later, in someone else's
 * runtime. So `writePod` rejects any key it does not read.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createNoydb, writePod, readPod } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { WRITE_POD_OPTION_KEYS } from '../src/with-pod/bundle.js'

const SECRET = 'correct-horse-battery'

async function seededVault() {
  const db = await createNoydb({ store: memoryStore(), user: 'ann', secret: SECRET })
  const vault = await db.openVault('demo')
  await vault.collection<{ id: string; n: number }>('items').put('a', { id: 'a', n: 1 })
  return vault
}

describe('writePod option-key validation', () => {
  it('rejects the retired `autoPassphrases` and names its replacement', async () => {
    const vault = await seededVault()
    await expect(
      writePod(vault, {
        autoPassphrases: { policy: 'public-by-design', perUser: { ann: SECRET } },
      } as never),
    ).rejects.toThrow(/autoPassphrases.*autoCredentials/s)
  })

  it('rejects an unrecognised key rather than dropping it', async () => {
    const vault = await seededVault()
    await expect(
      writePod(vault, { autoUnlok: true } as never),
    ).rejects.toThrow(/autoUnlok/)
  })

  it('still writes a readable pod with a recognised auto-unlock key', async () => {
    const vault = await seededVault()
    const bytes = await writePod(vault, {
      autoSecrets: { policy: 'public-by-design', perUser: { ann: SECRET } },
    })
    const { autoUnlock } = await readPod(bytes)
    expect(autoUnlock?.kind).toBe('unsealed')
  })

  it('accepts every key `WritePodOptions` declares', async () => {
    const vault = await seededVault()
    // Undefined values must not trip the guard — spreading a partially-built
    // options object is the normal call shape.
    const everyKey = Object.fromEntries(WRITE_POD_OPTION_KEYS.map((k) => [k, undefined]))
    await expect(writePod(vault, everyKey)).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('the accepted-key list tracks the interface', () => {
  it('names exactly the keys `WritePodOptions` declares', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/with-pod/bundle.ts', import.meta.url)),
      'utf8',
    )
    const body = /export interface WritePodOptions \{([\s\S]*?)\n\}/.exec(src)?.[1]
    expect(body, 'WritePodOptions interface not found').toBeDefined()
    const declared = [
      ...(body as string)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/^ {2}readonly ([A-Za-z0-9_]+)\??:/gm),
    ].map((m) => m[1])
    expect([...WRITE_POD_OPTION_KEYS].sort()).toEqual(declared.sort())
  })
})
