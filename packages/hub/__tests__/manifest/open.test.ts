/**
 * `open(podBytesOrFile)` — the pod READ-path orchestrator (#941 Task 4).
 *
 * Mirrors `derive.test.ts`'s AC #2 round-trip test (write a pod → restore
 * into a fresh store → re-derive the manifest) and `pod-signature-verify.
 * test.ts`'s signing helpers, but drives them through `open()` instead of
 * the manual createNoydb/openVault/vault.load/deriveSchemaManifest sequence
 * — proving open() is a faithful composition of those exact pieces.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { generateDocSigningKeyPair } from '@noy-db/attestation'
import { createNoydb, writePod } from '../../src/index.js'
import { readPod } from '../../src/with-pod/bundle.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { open, type OpenPodOptions } from '../../src/with-pod/open.js'
import { PodHeaderVerificationError, MigrationRequiredError } from '../../src/kernel/errors.js'
import { coordinatedCutover } from '../../src/with-shape/schema-update/index.js'
import {
  encodeBundleHeader,
  readUint32BE,
  writeUint32BE,
  NOYDB_BUNDLE_PREFIX_BYTES,
  type NoydbPodHeader,
} from '../../src/with-pod/format.js'
import type { DocSigner } from '../../src/with-audit/attestation/signer.js'
import type { NoydbStore } from '../../src/kernel/types.js'
import { toMemory } from '../../../to-memory/src/index.js'

const USER = 'alice'
const SECRET = 'test-pw-12345678'
const VAULT = 'acme'

interface Invoice { id: string; amount: number }

async function makeSourcePod(opts: { readonly sign?: false | DocSigner } = {}): Promise<Uint8Array> {
  const store = toMemory()
  const db = await createNoydb({ store, user: USER, secret: SECRET, historyStrategy: withHistory() })
  const vault = await db.openVault(VAULT)
  const Schema = z.object({ id: z.string(), amount: z.number() })
  vault.collection<Invoice>('invoices', { schema: Schema, persistJsonSchema: true })
  await vault._drainPendingSchemaWrites()
  await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
  return writePod(vault, { compression: 'none', ...(opts.sign !== undefined ? { sign: opts.sign } : {}) })
}

// The source pods are always written with history on (`_ledger` travels in
// the dump — see `backup.ts`'s internalNames list), so `vault.load()`'s
// post-load `verifyBackupIntegrity()` needs the SAME strategy on the
// destination to reconstruct a matching chain (mirrors both
// `bundle-roundtrip.test.ts` and `derive.test.ts`'s dst setup).
function baseOpts(store: NoydbStore, extra: Partial<OpenPodOptions> = {}): OpenPodOptions {
  return {
    store, vault: VAULT, user: USER, secret: SECRET,
    noydbOptions: { historyStrategy: withHistory() },
    ...extra,
  }
}

/**
 * A pod whose `invoices` collection went through a REAL coordinated cutover
 * (mirrors `derive.test.ts`'s a→b rename test) — the only way to get a
 * `_schemas/invoices` envelope legitimately stamped with `generation > 0`.
 * `_meta/schema-fence` itself does NOT travel in the dump (it's local
 * session-coordination state, not portable pod content), so the per-collection
 * `generation` stamp inside `_schemas/<collection>` is the only signal that
 * actually survives a restore — each phase below reopens a FRESH `Noydb`
 * instance (matching `openWith()` in derive.test.ts) so each session's own
 * `SchemaFenceController` snapshot tracks the bump it itself causes.
 */
async function makeAheadPod(): Promise<Uint8Array> {
  const store = toMemory()
  const oldSchema = z.object({ id: z.string(), amount: z.number() })
  const newSchema = z.object({ id: z.string(), total: z.number() })
  const transform = (d: Record<string, unknown>) => {
    const { amount, ...rest } = d as { amount?: number }
    return { ...rest, total: amount }
  }

  // No records are written before the cutover — only the schema declaration
  // needs to exist for `runSchemaCutover` to bump the fence; an empty
  // collection means the cutover's data-transform pass has nothing to
  // migrate, keeping this fixture focused on the generation stamp alone.
  let db = await createNoydb({ store, user: USER, secret: SECRET, historyStrategy: withHistory() })
  let vault = await db.openVault(VAULT)
  vault.collection<Invoice>('invoices', { schema: oldSchema, persistJsonSchema: true })
  await vault._drainPendingSchemaWrites()

  db = await createNoydb({ store, user: USER, secret: SECRET, historyStrategy: withHistory() })
  vault = await db.openVault(VAULT)
  vault.collection('invoices', {
    schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })],
  })
  await vault._drainPendingSchemaWrites()
  await vault.runSchemaCutover()

  // Cutover alone doesn't re-persist `_schemas` — the next declare does
  // (matches derive.test.ts's comment on the same pattern).
  db = await createNoydb({ store, user: USER, secret: SECRET, historyStrategy: withHistory() })
  vault = await db.openVault(VAULT)
  vault.collection('invoices', { schema: newSchema, persistJsonSchema: true })
  await vault._drainPendingSchemaWrites()

  return writePod(vault, { compression: 'none' })
}

/** Re-wrap a pod with a fresh header, same body/prefix (mirrors pod-signature-verify.test.ts). */
function reassembleWithHeader(bytes: Uint8Array, newHeader: NoydbPodHeader): Uint8Array {
  const headerLen = readUint32BE(bytes, 6)
  const bodyOffset = NOYDB_BUNDLE_PREFIX_BYTES + headerLen
  const body = bytes.slice(bodyOffset)
  const newHeaderBytes = encodeBundleHeader(newHeader)
  const out = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES + newHeaderBytes.length + body.length)
  out.set(bytes.slice(0, NOYDB_BUNDLE_PREFIX_BYTES), 0)
  writeUint32BE(out, 6, newHeaderBytes.length)
  out.set(newHeaderBytes, NOYDB_BUNDLE_PREFIX_BYTES)
  out.set(body, NOYDB_BUNDLE_PREFIX_BYTES + newHeaderBytes.length)
  return out
}

describe('open() — #941 Task 4', () => {
  it('opens a pod with schemas: vault is open, a record reads back, manifest matches the source', async () => {
    const bytes = await makeSourcePod()

    const result = await open(bytes, baseOpts(toMemory()))

    expect(result.header.formatVersion).toBeGreaterThanOrEqual(1)
    expect(result.manifest).toBeDefined()
    expect(Object.keys(result.manifest!.collections)).toEqual(['invoices'])

    // Redeclare the collection on the restored vault (same as bundle-roundtrip.test.ts) and read.
    const record = await result.vault.collection<Invoice>('invoices').get('inv-1')
    expect(record).toEqual({ id: 'inv-1', amount: 100 })
  })

  it('trustedKeys + a signed pod → verification.status === verified', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await makeSourcePod({ sign: signer })
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const result = await open(bytes, baseOpts(toMemory(), { trustedKeys }))

    expect(result.verification?.status).toBe('verified')
    expect(result.verification?.keyId).toBe(signer.keyId)
  })

  it('unsigned pod + trustedKeys → status unsigned, open still succeeds', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await makeSourcePod({ sign: false })

    const result = await open(bytes, baseOpts(toMemory(), {
      trustedKeys: { [signer.keyId]: signer.publicKeyB64 },
    }))

    expect(result.verification?.status).toBe('unsigned')
    expect(result.vault).toBeDefined()
  })

  it('untrusted signer + trustedKeys → open FAILS (PodHeaderVerificationError)', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await makeSourcePod({ sign: signer })

    await expect(
      open(bytes, baseOpts(toMemory(), { trustedKeys: {} /* signer's keyId not trusted */ })),
    ).rejects.toThrow(PodHeaderVerificationError)
  })

  it('tampered header + trustedKeys → open FAILS (PodHeaderVerificationError)', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await makeSourcePod({ sign: signer })

    // Swap `keyId` to a forged value mapped (in trustedKeys) to the real
    // public key — bodySha256/bodyBytes stay correct so `readPod`'s own
    // integrity check passes and the tamper is only visible to signature
    // verification (mirrors pod-signature-verify.test.ts's "mutating keyId"
    // case; a bodySha256 tamper would fail `readPod` before verification
    // ever runs, which isn't what this case is testing).
    const { header } = await readPod(bytes)
    const forgedKeyId = '0123456789abcdef'
    expect(forgedKeyId).not.toBe(signer.keyId)
    const tamperedHeader: NoydbPodHeader = { ...header, keyId: forgedKeyId }
    const tamperedBytes = reassembleWithHeader(bytes, tamperedHeader)

    await expect(
      open(tamperedBytes, baseOpts(toMemory(), { trustedKeys: { [forgedKeyId]: signer.publicKeyB64 } })),
    ).rejects.toThrow(PodHeaderVerificationError)
  })

  it('pod generation ahead of the reader → MigrationRequiredError', async () => {
    const bytes = await makeAheadPod()

    await expect(open(bytes, baseOpts(toMemory()))).rejects.toThrow(MigrationRequiredError)
  })

  it('allowGenerationAhead: true opens anyway, with a console warning', async () => {
    const bytes = await makeAheadPod()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await open(bytes, baseOpts(toMemory(), { allowGenerationAhead: true }))
    expect(result.vault).toBeDefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('#941 review Important 3 (AC #4): reader ahead of the pod is non-fatal but warns (divergence observable in EITHER direction)', async () => {
    // Give the TARGET store its own local generation (1) — independent of
    // any pod — by cutting over a vault that already lives there, mirroring
    // makeAheadPod()'s pattern but applied to the store open() restores
    // INTO. `_meta/schema-fence` does NOT travel in a pod dump (see the
    // module doc), so this local generation survives `vault.load()` intact.
    const targetStore = toMemory()
    const oldSchema = z.object({ id: z.string(), amount: z.number() })
    const newSchema = z.object({ id: z.string(), total: z.number() })
    const transform = (d: Record<string, unknown>) => {
      const { amount, ...rest } = d as { amount?: number }
      return { ...rest, total: amount }
    }
    let db = await createNoydb({ store: targetStore, user: USER, secret: SECRET, historyStrategy: withHistory() })
    let vault = await db.openVault(VAULT)
    vault.collection<Invoice>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    db = await createNoydb({ store: targetStore, user: USER, secret: SECRET, historyStrategy: withHistory() })
    vault = await db.openVault(VAULT)
    vault.collection('invoices', {
      schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })],
    })
    await vault._drainPendingSchemaWrites()
    await vault.runSchemaCutover() // target's local fence is now at generation 1

    // A source pod whose OWN generation stays 0 (never migrated).
    const bytes = await makeSourcePod()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await open(bytes, baseOpts(targetStore))
    expect(result.vault).toBeDefined() // non-fatal — no MigrationRequiredError
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ahead of the pod'))
    warnSpy.mockRestore()
  })
})
