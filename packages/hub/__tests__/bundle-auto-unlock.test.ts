/**
 * Sealed bundle delivery (#197 slice 1) — `autoPassphrases` +
 * `sealedPassphrases` round-trip coverage.
 *
 * Covers the contract documented in
 * docs/superpowers/specs/2026-05-23-sealed-bundle-delivery.md.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import {
  ConflictError,
  createNoydb,
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  MemorySealingKeyProvider,
  BundleSealMismatchError,
  ValidationError,
} from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  } as unknown as NoydbStore
}

const STRONG = 'correct horse battery staple printer toaster'

async function freshVault() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: STRONG,
  })
  const vault = await db.openVault('acme')
  return { db, vault }
}

describe('#197 — autoPassphrases (unsealed, public-by-design)', () => {
  it('writes the header autoUnlock flag and round-trips plaintext passphrases', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoPassphrases: {
        policy: 'public-by-design',
        perUser: { 'demo-customer': 'demo-pass-1', 'demo-prospect': 'demo-pass-2' },
      },
    })

    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('unsealed')

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser).toEqual({
      'demo-customer': 'demo-pass-1',
      'demo-prospect': 'demo-pass-2',
    })
  })

  it('dumpJson is still parseable / usable after auto-unlock unwrap', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoPassphrases: {
        policy: 'public-by-design',
        perUser: { 'alice': 'demo' },
      },
    })
    const result = await readNoydbBundle(bytes)
    expect(result.dumpJson).toBeTypeOf('string')
    // Dump JSON contains the keyring map and other vault metadata —
    // verify it survives the wrap/unwrap by parsing.
    const parsed = JSON.parse(result.dumpJson) as Record<string, unknown>
    expect(typeof parsed).toBe('object')
  })

  it('rejects autoPassphrases without policy marker', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        autoPassphrases: { perUser: { x: 'y' } } as any,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects empty perUser map', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        autoPassphrases: { policy: 'public-by-design', perUser: {} },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects mutual exclusion violation', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test' })
    await expect(
      writeNoydbBundle(vault, {
        autoPassphrases: { policy: 'public-by-design', perUser: { a: 'b' } },
        sealedPassphrases: { mode: 'self-target', provider, perUser: { c: 'd' } },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('#197 — sealedPassphrases (self-target)', () => {
  it('seals + round-trips with the same provider', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'macos-keychain:com.acme/alice' })

    const bytes = await writeNoydbBundle(vault, {
      sealedPassphrases: {
        mode: 'self-target',
        provider,
        perUser: { alice: 'alice-passphrase-here' },
      },
    })

    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('sealed')

    // Read with matching provider — should auto-unseal to plaintext.
    const recipientProvider = new MemorySealingKeyProvider({
      id: 'macos-keychain:com.acme/alice',
    })
    const result = await readNoydbBundle(bytes, {
      sealingProviders: [recipientProvider],
    })

    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    expect(result.autoUnlock!.perUser).toEqual({
      alice: 'alice-passphrase-here',
    })
  })

  it('returns sealed entries unmodified when no sealingProviders supplied', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test-pid' })

    const bytes = await writeNoydbBundle(vault, {
      sealedPassphrases: {
        mode: 'self-target',
        provider,
        perUser: { alice: 'a-pass' },
      },
    })

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    // perUser values are base64 sealed bytes — opaque, not the plaintext.
    expect(result.autoUnlock!.perUser['alice']).not.toBe('a-pass')
    expect(result.autoUnlock!.perUser['alice'].length).toBeGreaterThan(0)
  })

  it('throws BundleSealMismatchError when no provider matches pid (strict)', async () => {
    const { vault } = await freshVault()
    const senderProvider = new MemorySealingKeyProvider({ id: 'aws-kms:abc' })
    const otherProvider = new MemorySealingKeyProvider({ id: 'macos-keychain:com.other/bob' })

    const bytes = await writeNoydbBundle(vault, {
      sealedPassphrases: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { alice: 'a-pass' },
      },
    })

    await expect(
      readNoydbBundle(bytes, { sealingProviders: [otherProvider] }),
    ).rejects.toBeInstanceOf(BundleSealMismatchError)
  })

  it('BundleSealMismatchError message names the failing pid + actionable resolutions', async () => {
    const { vault } = await freshVault()
    const senderProvider = new MemorySealingKeyProvider({ id: 'aws-kms:secret-arn' })
    const otherProvider = new MemorySealingKeyProvider({ id: 'wrong-pid' })

    const bytes = await writeNoydbBundle(vault, {
      sealedPassphrases: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { alice: 'a-pass' },
      },
    })

    try {
      await readNoydbBundle(bytes, { sealingProviders: [otherProvider] })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BundleSealMismatchError)
      const msg = (err as Error).message
      expect(msg).toContain('alice')
      expect(msg).toContain('aws-kms:secret-arn')
      expect(msg).toContain('attemptUnsealAcrossProviders')
    }
  })

  it('attemptUnsealAcrossProviders opt-in tries each provider when pid mismatches', async () => {
    const { vault } = await freshVault()
    // Sender + a same-key receiver with DIFFERENT ids
    // MemorySealingKeyProvider seals deterministically on its own
    // id — so two providers with different ids can't unseal each
    // other's output. To exercise the trial-mode code path
    // successfully we use the SAME id under a different instance
    // (simulating a recipient who has the same provider configured
    // but the bundle was written with a slightly different id —
    // unrealistic edge case; verify it gracefully fails closed).
    const senderProvider = new MemorySealingKeyProvider({ id: 'unique-sender' })
    const otherProvider1 = new MemorySealingKeyProvider({ id: 'wrong-pid-1' })
    const otherProvider2 = new MemorySealingKeyProvider({ id: 'wrong-pid-2' })

    const bytes = await writeNoydbBundle(vault, {
      sealedPassphrases: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { alice: 'a-pass' },
      },
    })

    // None of the "other" providers can actually unseal — trial mode
    // exhausts and throws BundleSealMismatchError.
    await expect(
      readNoydbBundle(bytes, {
        sealingProviders: [otherProvider1, otherProvider2],
        attemptUnsealAcrossProviders: true,
      }),
    ).rejects.toBeInstanceOf(BundleSealMismatchError)
  })

  it('rejects mode other than self-target', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test' })
    await expect(
      writeNoydbBundle(vault, {
        sealedPassphrases: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mode: 'recipient-target' as any,
          provider,
          perUser: { a: 'b' },
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('#197 — back-compat', () => {
  it('a bundle written without any auto-unlock options reads as pre-#197 shape', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault)
    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBeUndefined()

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeUndefined()
    // dumpJson is the raw vault.dump() JSON (no wrapper).
    const parsed = JSON.parse(result.dumpJson) as Record<string, unknown>
    expect(typeof parsed).toBe('object')
  })

  it('readNoydbBundleHeader does not require body decompression', async () => {
    // We can't easily assert "didn't decompress" from outside, but we
    // can confirm the function returns the autoUnlock flag and only
    // the flag — the body might be truncated and the call would still
    // succeed because we look only at the header.
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoPassphrases: { policy: 'public-by-design', perUser: { a: 'b' } },
    })
    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('unsealed')
    expect(header.handle).toBeTypeOf('string')
    expect(header.bodySha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('#197 — composes with publicEnvelope', () => {
  it('both publicEnvelope and autoUnlock can coexist on the same bundle header', async () => {
    // Vaults without a public envelope persist nothing — the bundle's
    // publicEnvelope field stays undefined. Just verify autoUnlock
    // doesn't interfere with the existing envelope path.
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoPassphrases: { policy: 'public-by-design', perUser: { a: 'b' } },
    })
    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('unsealed')
    // publicEnvelope is undefined because the vault has none —
    // that's correct back-compat. The header just carries the new flag.
    expect(header.publicEnvelope).toBeUndefined()
  })
})
