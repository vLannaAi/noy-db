/**
 * Showcase 52 — `.noydb` bundle: per-recipient expiry + record filters
 *
 * What you'll learn
 * ─────────────────
 * Three opt-in extensions to `writeNoydbBundle` for sharing scoped
 * snapshots without giving the recipient the whole vault forever:
 *
 *   - `recipients[].expiresAt` — time-boxed slot that refuses to
 *     unlock past an ISO cutoff (#306). Throws `KeyringExpiredError`
 *     before any DEK unwrap, so an expired slot doesn't leak timing
 *     on the passphrase.
 *   - `where: (record, ctx) => boolean` — plaintext predicate run
 *     after decryption; survivors carry their ORIGINAL ciphertext
 *     into the bundle (no re-encrypt, zero-knowledge clean) (#320).
 *   - `tierAtMost: number` — hierarchical-tier ceiling on the
 *     envelope's `_tier` field; vaults without tiers see this as a
 *     no-op (#321).
 *
 * Why it matters
 * ──────────────
 * "Give the auditor everything paid in Q4 but only for 30 days" is
 * a workflow that today requires bespoke export glue. With these three
 * options it's three lines on the existing bundle API.
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-noydb (#306 #320 #321)
 */

import { describe, it, expect } from 'vitest'
import type { BundleRecipient, EncryptedEnvelope } from '@noy-db/hub'
import { KeyringExpiredError, createNoydb, writeNoydbBundle, readNoydbBundle } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number; status: 'draft' | 'paid' }

async function setup() {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'showcase-52-pw',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100, status: 'draft' })
  await vault.collection<Invoice>('invoices').put('b', { id: 'b', amount: 200, status: 'paid' })
  await vault.collection<Invoice>('invoices').put('c', { id: 'c', amount: 300, status: 'paid' })
  return { db, vault }
}

async function restoreAs(
  bundle: Uint8Array,
  recipientId: string,
  recipientPass: string,
): Promise<{ db: Awaited<ReturnType<typeof createNoydb>> }> {
  const { dumpJson } = await readNoydbBundle(bundle)
  const dump = JSON.parse(dumpJson) as {
    _compartment: string
    keyrings: Record<string, unknown>
    collections: Record<string, Record<string, EncryptedEnvelope>>
    _internal?: Record<string, Record<string, EncryptedEnvelope>>
  }
  const target = memory()
  for (const [userId, kf] of Object.entries(dump.keyrings)) {
    await target.put(dump._compartment, '_keyring', userId, {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify(kf),
    })
  }
  for (const [coll, records] of Object.entries(dump.collections)) {
    for (const [id, env] of Object.entries(records)) {
      await target.put(dump._compartment, coll, id, env)
    }
  }
  if (dump._internal) {
    for (const [coll, records] of Object.entries(dump._internal)) {
      for (const [id, env] of Object.entries(records)) {
        await target.put(dump._compartment, coll, id, env)
      }
    }
  }
  return {
    db: await createNoydb({
      store: target, user: recipientId, secret: recipientPass,
      historyStrategy: withHistory(),
    }),
  }
}

describe('Showcase 52 — per-recipient expiresAt (#306)', () => {
  it('past-cutoff slot refuses to unlock with KeyringExpiredError', async () => {
    const { db: src, vault } = await setup()
    const yesterday = new Date(Date.now() - 86400_000).toISOString()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: yesterday },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const { db } = await restoreAs(bytes, 'auditor', 'aud-pw')
    await expect(db.openVault('demo')).rejects.toThrow(KeyringExpiredError)
    db.close()
  })

  it('future-cutoff slot opens and reads records normally', async () => {
    const { db: src, vault } = await setup()
    const tomorrow = new Date(Date.now() + 86400_000).toISOString()
    const bytes = await writeNoydbBundle(vault, {
      recipients: [
        { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: tomorrow },
      ],
    })
    src.close()

    const { db } = await restoreAs(bytes, 'auditor', 'aud-pw')
    const v = await db.openVault('demo')
    expect(await v.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', amount: 100, status: 'draft' })
    db.close()
  })
})

describe('Showcase 52 — `where` predicate filter (#320)', () => {
  it('selective predicate trims the bundle to matching records', async () => {
    const { db: src, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, {
      where: (record) => (record as Invoice).status === 'paid',
    })
    const { dumpJson } = await readNoydbBundle(bytes)
    const dump = JSON.parse(dumpJson) as {
      collections: Record<string, Record<string, EncryptedEnvelope>>
    }
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    src.close()
  })

  it('survivors carry their ORIGINAL ciphertext (zero-knowledge invariant)', async () => {
    const { db: src, vault } = await setup()
    const baseline = JSON.parse((await readNoydbBundle(await writeNoydbBundle(vault))).dumpJson) as {
      collections: Record<string, Record<string, EncryptedEnvelope>>
    }
    const filtered = JSON.parse((await readNoydbBundle(
      await writeNoydbBundle(vault, { where: (r) => (r as Invoice).status === 'paid' }),
    )).dumpJson) as { collections: Record<string, Record<string, EncryptedEnvelope>> }

    // Surviving record 'b' should ship the byte-identical _iv + _data
    // — proves the filter dropped non-matching records without
    // re-encrypting the survivors.
    expect(filtered.collections.invoices!.b!._iv)
      .toBe(baseline.collections.invoices!.b!._iv)
    expect(filtered.collections.invoices!.b!._data)
      .toBe(baseline.collections.invoices!.b!._data)
    src.close()
  })
})

describe('Showcase 52 — `tierAtMost` ceiling (#321)', () => {
  it('untiered vault → tierAtMost is a no-op (defensive)', async () => {
    const { db: src, vault } = await setup()
    const baseline = JSON.parse((await readNoydbBundle(await writeNoydbBundle(vault))).dumpJson) as {
      collections: Record<string, Record<string, EncryptedEnvelope>>
    }
    const filtered = JSON.parse((await readNoydbBundle(
      await writeNoydbBundle(vault, { tierAtMost: 0 }),
    )).dumpJson) as { collections: Record<string, Record<string, EncryptedEnvelope>> }

    expect(Object.keys(filtered.collections.invoices ?? {}).sort())
      .toEqual(Object.keys(baseline.collections.invoices ?? {}).sort())
    src.close()
  })
})

describe('Showcase 52 — composition', () => {
  it('all three extensions compose: expiresAt + where + tierAtMost', async () => {
    const { db: src, vault } = await setup()
    const tomorrow = new Date(Date.now() + 86400_000).toISOString()
    const bytes = await writeNoydbBundle(vault, {
      tierAtMost: 1,
      where: (r) => (r as Invoice).amount >= 200,
      recipients: [
        { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: tomorrow },
      ],
    })

    const { dumpJson } = await readNoydbBundle(bytes)
    const dump = JSON.parse(dumpJson) as {
      collections: Record<string, Record<string, EncryptedEnvelope>>
    }
    // `where` keeps `b` and `c`; `tierAtMost: 1` is no-op for untiered;
    // `expiresAt` is enforced at unlock time, not at slice time.
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    src.close()
  })
})
