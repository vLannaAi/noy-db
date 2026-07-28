/**
 * Sealed bundle delivery (#197 slice 1) — `autoSecrets` +
 * `sealedSecrets` round-trip coverage.
 *
 * Covers the contract documented in
 * docs/superpowers/specs/2026-05-23-sealed-bundle-delivery.md.
 *
 * Extended for #215 — generalized auto-unlock across credential kinds
 * (password, pin) + sugar/back-compat regression tests.
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
  MemoryRecipientSealer,
  BundleSealMismatchError,
  ValidationError,
} from '../src/index.js'
import {
  encodeBundleHeader,
  decodeBundleHeader,
  NOYDB_BUNDLE_PREFIX_BYTES,
  readUint32BE,
  writeUint32BE,
} from '../src/with-pod/format.js'

function toMemory(): NoydbStore {
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
        for (const [id, e] of Object.entries(recs!)) coll.set(id, e!)
      }
    },
  } as unknown as NoydbStore
}

const STRONG = 'correct horse battery staple printer toaster'

async function freshVault() {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: STRONG,
  })
  const vault = await db.openVault('acme')
  return { db, vault }
}

describe('#197 — autoSecrets (unsealed, public-by-design)', () => {
  it('writes the header autoUnlock flag and round-trips plaintext secrets', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoSecrets: {
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
      'demo-customer': { kind: 'secret', value: 'demo-pass-1' },
      'demo-prospect': { kind: 'secret', value: 'demo-pass-2' },
    })
  })

  it('dumpJson is still parseable / usable after auto-unlock unwrap', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoSecrets: {
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

  it('rejects autoSecrets without policy marker', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        autoSecrets: { perUser: { x: 'y' } } as any,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects empty perUser map', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        autoSecrets: { policy: 'public-by-design', perUser: {} },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects mutual exclusion violation', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test' })
    await expect(
      writeNoydbBundle(vault, {
        autoSecrets: { policy: 'public-by-design', perUser: { a: 'b' } },
        sealedSecrets: { mode: 'self-target', provider, perUser: { c: 'd' } },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('#197 — sealedSecrets (self-target)', () => {
  it('seals + round-trips with the same provider', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'macos-keychain:com.acme/alice' })

    const bytes = await writeNoydbBundle(vault, {
      sealedSecrets: {
        mode: 'self-target',
        provider,
        perUser: { alice: 'alice-secret-here' },
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
      alice: { kind: 'secret', value: 'alice-secret-here' },
    })
  })

  it('returns sealed entries unmodified when no sealingProviders supplied', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test-pid' })

    const bytes = await writeNoydbBundle(vault, {
      sealedSecrets: {
        mode: 'self-target',
        provider,
        perUser: { alice: 'a-pass' },
      },
    })

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    // perUser values are AutoCredential — value is opaque base64 sealed bytes, not the plaintext.
    expect(result.autoUnlock!.perUser['alice']!.value).not.toBe('a-pass')
    expect(result.autoUnlock!.perUser['alice']!.value.length).toBeGreaterThan(0)
  })

  it('throws BundleSealMismatchError when no provider matches pid (strict)', async () => {
    const { vault } = await freshVault()
    const senderProvider = new MemorySealingKeyProvider({ id: 'aws-kms:abc' })
    const otherProvider = new MemorySealingKeyProvider({ id: 'macos-keychain:com.other/bob' })

    const bytes = await writeNoydbBundle(vault, {
      sealedSecrets: {
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
      sealedSecrets: {
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
      sealedSecrets: {
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
        sealedSecrets: {
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
      autoSecrets: { policy: 'public-by-design', perUser: { a: 'b' } },
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
      autoSecrets: { policy: 'public-by-design', perUser: { a: 'b' } },
    })
    const header = await readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('unsealed')
    // publicEnvelope is undefined because the vault has none —
    // that's correct back-compat. The header just carries the new flag.
    expect(header.publicEnvelope).toBeUndefined()
  })
})

// ─── #215 — generalized auto-unlock (new credential kinds + sugar/back-compat) ──

describe('#215 — autoCredentials, password kind (unsealed)', () => {
  it('round-trips password credential as { kind:"password", value }', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoCredentials: {
        policy: 'public-by-design',
        perUser: { carol: { kind: 'password', value: 'hunter2' } },
      },
    })

    const header = readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('unsealed')

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser['carol']).toEqual({ kind: 'password', value: 'hunter2' })
  })
})

describe('#215 — autoCredentials, pin kind (unsealed)', () => {
  it('round-trips pin credential as { kind:"pin", value }', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoCredentials: {
        policy: 'public-by-design',
        perUser: { dave: { kind: 'pin', value: '1234' } },
      },
    })

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser['dave']).toEqual({ kind: 'pin', value: '1234' })
  })
})

describe('#215 — autoCredentials, secret kind (unsealed)', () => {
  it('round-trips secret credential via autoCredentials same as sugar path', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoCredentials: {
        policy: 'public-by-design',
        perUser: { eve: { kind: 'secret', value: 'correct-horse' } },
      },
    })

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser['eve']).toEqual({ kind: 'secret', value: 'correct-horse' })
  })
})

describe('#215 — sealedCredentials, password kind (sealed)', () => {
  it('seals password credential and unseals to { kind:"password", value } when provider matches', async () => {
    const { vault } = await freshVault()
    const pid = 'macos-keychain:com.acme/carol'
    const senderProvider = new MemorySealingKeyProvider({ id: pid })

    const bytes = await writeNoydbBundle(vault, {
      sealedCredentials: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { carol: { kind: 'password', value: 'hunter2' } },
      },
    })

    const header = readNoydbBundleHeader(bytes)
    expect(header.autoUnlock).toBe('sealed')

    // WITH matching provider — should unseal to { kind:'password', value }
    const recipientProvider = new MemorySealingKeyProvider({ id: pid })
    const result = await readNoydbBundle(bytes, { sealingProviders: [recipientProvider] })

    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    expect(result.autoUnlock!.perUser['carol']).toEqual({ kind: 'password', value: 'hunter2' })
  })

  it('passes through sealed entry with kind preserved when no sealingProviders supplied', async () => {
    const { vault } = await freshVault()
    const senderProvider = new MemorySealingKeyProvider({ id: 'test-sealed-password-pid' })

    const bytes = await writeNoydbBundle(vault, {
      sealedCredentials: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { carol: { kind: 'password', value: 'hunter2' } },
      },
    })

    // WITHOUT provider — kind is preserved in passthrough, value is the opaque sealed bytes
    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    const entry = result.autoUnlock!.perUser['carol']!
    expect(entry.kind).toBe('password')
    // value is the opaque base64 sealed blob, NOT the plaintext
    expect(entry.value).not.toBe('hunter2')
    expect(entry.value.length).toBeGreaterThan(0)
  })
})

describe('#215 — sugar back-compat', () => {
  it('autoSecrets sugar round-trips as { kind:"secret", value }', async () => {
    const { vault } = await freshVault()
    const bytes = await writeNoydbBundle(vault, {
      autoSecrets: {
        policy: 'public-by-design',
        perUser: { 'legacy-user': 'legacy-pass' },
      },
    })

    const result = await readNoydbBundle(bytes)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser['legacy-user']).toEqual({
      kind: 'secret',
      value: 'legacy-pass',
    })
  })

  it('sealedSecrets sugar unseals as { kind:"secret", value }', async () => {
    const { vault } = await freshVault()
    const pid = 'macos-keychain:com.acme/legacy'
    const senderProvider = new MemorySealingKeyProvider({ id: pid })

    const bytes = await writeNoydbBundle(vault, {
      sealedSecrets: {
        mode: 'self-target',
        provider: senderProvider,
        perUser: { 'legacy-user': 'legacy-pass' },
      },
    })

    const recipientProvider = new MemorySealingKeyProvider({ id: pid })
    const result = await readNoydbBundle(bytes, { sealingProviders: [recipientProvider] })

    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('sealed')
    expect(result.autoUnlock!.perUser['legacy-user']).toEqual({
      kind: 'secret',
      value: 'legacy-pass',
    })
  })

  /**
   * Pre-0.2 bundles stored bare strings in the unsealed `perUser` map.
   * We verify the `coerceUnsealed` path by injecting a crafted bundle body
   * (written with compression:'none' so the body is accessible without
   * decompression, then surgically patching the perUser entry to a bare
   * string and recomputing the header hash).
   */
  it('pre-0.2 bare-string entry in unsealed body coerces to { kind:"secret", value }', async () => {
    const { vault } = await freshVault()

    // Write an uncompressed unsealed bundle so the body bytes are raw UTF-8 JSON.
    const originalBytes = await writeNoydbBundle(vault, {
      compression: 'none',
      autoCredentials: {
        policy: 'public-by-design',
        perUser: { bob: { kind: 'secret', value: 'old-secret' } },
      },
    })

    // ── Parse the prefix to locate header + body ──────────────────────────
    const headerLen = readUint32BE(originalBytes, 6)
    const bodyOffset = NOYDB_BUNDLE_PREFIX_BYTES + headerLen
    const headerBytes = originalBytes.slice(NOYDB_BUNDLE_PREFIX_BYTES, bodyOffset)
    const header = decodeBundleHeader(headerBytes)
    const bodyBytes = originalBytes.slice(bodyOffset)

    // ── Patch: replace the AutoCredential object with a bare string ───────
    const bodyStr = new TextDecoder().decode(bodyBytes)
    const bodyObj = JSON.parse(bodyStr) as {
      _noydb_bundle_body: 1
      dump: string
      _autoUnlock: { kind: 'unsealed'; perUser: Record<string, unknown> }
    }
    // Simulate a pre-0.2 bundle: store a bare string instead of { kind, value }
    bodyObj._autoUnlock.perUser['bob'] = 'old-secret'
    const patchedBodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj))

    // ── Recompute body SHA-256 for the patched body ───────────────────────
    const copy = new Uint8Array(patchedBodyBytes.length)
    copy.set(patchedBodyBytes)
    const digestBuf = await crypto.subtle.digest('SHA-256', copy)
    const digestView = new Uint8Array(digestBuf)
    let newSha = ''
    for (let i = 0; i < digestView.length; i++) newSha += digestView[i]!.toString(16).padStart(2, '0')

    // ── Rebuild header with updated bodyBytes + bodySha256 ────────────────
    const patchedHeader = {
      ...header,
      bodyBytes: patchedBodyBytes.length,
      bodySha256: newSha,
    }
    const patchedHeaderBytes = encodeBundleHeader(patchedHeader)

    // ── Reassemble: prefix (first 6 bytes keep flags/algo) + new headerLen + new header + body ──
    const patchedPrefix = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES)
    // Copy magic + flags + algo bytes unchanged
    patchedPrefix.set(originalBytes.slice(0, 6))
    writeUint32BE(patchedPrefix, 6, patchedHeaderBytes.length)

    const patchedBundle = new Uint8Array(
      patchedPrefix.length + patchedHeaderBytes.length + patchedBodyBytes.length,
    )
    let off = 0
    patchedBundle.set(patchedPrefix, off); off += patchedPrefix.length
    patchedBundle.set(patchedHeaderBytes, off); off += patchedHeaderBytes.length
    patchedBundle.set(patchedBodyBytes, off)

    // ── Read back — coerceUnsealed should promote the bare string ─────────
    const result = await readNoydbBundle(patchedBundle)
    expect(result.autoUnlock).toBeDefined()
    expect(result.autoUnlock!.kind).toBe('unsealed')
    expect(result.autoUnlock!.perUser['bob']).toEqual({ kind: 'secret', value: 'old-secret' })
  })
})

describe('#215 — mutual exclusion (mixing rejected)', () => {
  it('autoCredentials + autoSecrets together throw ValidationError matching /only one of/', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        autoCredentials: {
          policy: 'public-by-design',
          perUser: { alice: { kind: 'secret', value: 'a' } },
        },
        autoSecrets: {
          policy: 'public-by-design',
          perUser: { bob: 'b' },
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ValidationError && /only one of/i.test((err as Error).message),
    )
  })

  it('autoCredentials + sealedCredentials together throw ValidationError matching /only one of/', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test-mix' })
    await expect(
      writeNoydbBundle(vault, {
        autoCredentials: {
          policy: 'public-by-design',
          perUser: { alice: { kind: 'secret', value: 'a' } },
        },
        sealedCredentials: {
          mode: 'self-target',
          provider,
          perUser: { bob: { kind: 'password', value: 'b' } },
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ValidationError && /only one of/i.test((err as Error).message),
    )
  })
})

describe('#215 — unsupported credential kind rejected', () => {
  it('autoCredentials with kind:"webauthn" rejects with ValidationError naming the kind and valid kinds', async () => {
    const { vault } = await freshVault()
    await expect(
      writeNoydbBundle(vault, {
        autoCredentials: {
          policy: 'public-by-design',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perUser: { alice: { kind: 'webauthn' as any, value: 'x' } },
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ValidationError)) return false
      const msg = (err as Error).message
      // Error must name the bad kind and at minimum mention secret/password/pin
      return /webauthn/i.test(msg) && /secret/i.test(msg)
    })
  })

  it('sealedCredentials with kind:"webauthn" rejects with ValidationError', async () => {
    const { vault } = await freshVault()
    const provider = new MemorySealingKeyProvider({ id: 'test-bad-kind' })
    await expect(
      writeNoydbBundle(vault, {
        sealedCredentials: {
          mode: 'self-target',
          provider,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perUser: { alice: { kind: 'webauthn' as any, value: 'x' } },
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ValidationError)) return false
      const msg = (err as Error).message
      return /webauthn/i.test(msg)
    })
  })
})

describe('recipient-target sealedCredentials — validation', () => {
  it('rejects a recipient-target entry with a missing hint', async () => {
    const { vault: v } = await freshVault()
    const recipient = new MemoryRecipientSealer({ id: 'r1' })

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          provider: recipient,
          // @ts-expect-error — intentionally missing hint to test runtime guard
          perUser: { alice: { credential: { kind: 'secret', value: 'p' } } },
        },
      }),
    ).rejects.toThrow(/hint/)
  })

  it('rejects when hint.alg is not rsa-oaep-sha256', async () => {
    const { vault: v } = await freshVault()
    const recipient = new MemoryRecipientSealer({ id: 'r1' })
    const goodHint = await recipient.publishRecipientHint()
    // Craft a hint with an unsupported alg — RecipientHint.alg is typed but
    // the validator's runtime guard must also catch it for JS callers.
    const badHint = { ...goodHint, alg: 'unsupported-alg' } as unknown as typeof goodHint

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          provider: recipient,
          perUser: { alice: { credential: { kind: 'secret', value: 'p' }, hint: badHint } },
        },
      }),
    ).rejects.toThrow(/rsa-oaep-sha256/)
  })

  it('rejects a recipient-target mode with a self-only provider (runtime guard for JS callers)', async () => {
    const { vault: v } = await freshVault()
    const selfOnly = new MemorySealingKeyProvider({ id: 'self-only' })
    const someHint = await new MemoryRecipientSealer({ id: 'r1' }).publishRecipientHint()

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          // @ts-expect-error — runtime guard for JS callers; TS rejects this at compile time
          provider: selfOnly,
          perUser: { alice: { credential: { kind: 'secret', value: 'p' }, hint: someHint } },
        },
      }),
    ).rejects.toThrow(/RecipientSealer/)
  })

  it('rejects a recipient-target entry with an empty hint.pid', async () => {
    const { vault: v } = await freshVault()
    const recipient = new MemoryRecipientSealer({ id: 'r1' })
    const validHint = await recipient.publishRecipientHint()
    const emptyPidHint = { ...validHint, pid: '' }
    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          provider: recipient,
          perUser: { alice: { credential: { kind: 'secret', value: 'p' }, hint: emptyPidHint } },
        },
      }),
    ).rejects.toThrow(/pid/)
  })
})

describe('recipient-target sealedCredentials — round-trip', () => {
  it('seals for two recipients; each opens only their own credential', async () => {
    const { vault: v } = await freshVault()

    const aliceRs = new MemoryRecipientSealer({ id: 'alice-rs' })
    const bobRs = new MemoryRecipientSealer({ id: 'bob-rs' })
    const aliceHint = await aliceRs.publishRecipientHint()
    const bobHint = await bobRs.publishRecipientHint()

    // Sender uses a third instance — production shape: sender doesn't hold
    // any recipient's private key.
    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'recipient-target',
        provider: sender,
        perUser: {
          alice: { credential: { kind: 'secret', value: 'alice-pass-bundled' }, hint: aliceHint },
          bob:   { credential: { kind: 'secret', value: 'bob-pass-bundled' },   hint: bobHint },
        },
      },
    })

    // Recipient side — alice unseals with her provider.
    const aliceRead = await readNoydbBundle(bytes, { sealingProviders: [aliceRs] })
    expect(aliceRead.autoUnlock?.kind).toBe('sealed')
    expect(aliceRead.autoUnlock?.perUser.alice).toMatchObject({ kind: 'secret', value: 'alice-pass-bundled' })

    const bobRead = await readNoydbBundle(bytes, { sealingProviders: [bobRs] })
    expect(bobRead.autoUnlock?.perUser.bob).toMatchObject({ kind: 'secret', value: 'bob-pass-bundled' })
  })

  it('a third-party recipient (different keypair) cannot unseal someone else\'s entry', async () => {
    const { vault: v } = await freshVault()
    const aliceRs = new MemoryRecipientSealer({ id: 'alice-rs' })
    const intruderRs = new MemoryRecipientSealer({ id: 'alice-rs' }) // same id, different keypair
    const aliceHint = await aliceRs.publishRecipientHint()
    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'recipient-target',
        provider: sender,
        perUser: { alice: { credential: { kind: 'secret', value: 'p' }, hint: aliceHint } },
      },
    })

    // Intruder has the same pid (so the reader's dispatch finds it) but a
    // different keypair → unseal fails inside the provider.
    await expect(readNoydbBundle(bytes, { sealingProviders: [intruderRs] })).rejects.toThrow(/decrypt|OperationError|operation/i)
  })

  it('back-compat: self-target bundles still round-trip with no hint field', async () => {
    const { vault: v } = await freshVault()
    const selfProvider = new MemorySealingKeyProvider({ id: 'shared-keychain' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'self-target',
        provider: selfProvider,
        perUser: { alice: { kind: 'secret', value: 'alice-pass-bundled' } },
      },
    })
    const recipientProvider = new MemorySealingKeyProvider({ id: 'shared-keychain' })
    const read = await readNoydbBundle(bytes, { sealingProviders: [recipientProvider] })
    expect(read.autoUnlock?.kind).toBe('sealed')
    expect(read.autoUnlock?.perUser.alice).toMatchObject({ kind: 'secret', value: 'alice-pass-bundled' })
    // Self-target entries omit the hint field
    expect((read.autoUnlock?.perUser.alice as unknown as Record<string, unknown>).hint).toBeUndefined()
  })
})
