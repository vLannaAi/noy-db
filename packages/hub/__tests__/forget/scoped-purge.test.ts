/**
 * #633 — opt-in `scopedPurge` forget-strategy knob: gates the vault-level
 * unconditional `_sealed_cek` + blob purges on per-collection via
 * declarations, reporting skipped-but-detected residue through
 * `ForgetResult.scopedPurgeResidue` instead of a silent skip.
 *
 * Ratified design: the DEFAULT stays the unconditional purge (today's
 * behavior, byte-identical when `scopedPurge` is absent/false) — scoping is
 * an explicit per-vault opt-in for perf-sensitive deployments.
 *
 * Four scenarios:
 *  (a) DEFAULT parity — an undeclared-but-using collection (bare `sensitive`
 *      + `sealRecordToHost`, the `forget-sealed-erasure.test.ts:112` recipe)
 *      still gets its `_sealed_cek` envelope purged unconditionally.
 *  (b) SCOPED mode, sealed-CEK arm — a classified-declared collection's
 *      envelopes purge; a bare-`sensitive` (undeclared) collection's
 *      envelopes are LEFT IN PLACE + reported as residue.
 *  (c) SCOPED mode, blob arm — a `blobFields`-declared collection's blob
 *      shreds; an undeclared collection's blob scan is SKIPPED ENTIRELY (no
 *      `_blob_slots_*` list() call) + reported as residue.
 *  (d) per-vault independence — two independently-configured vaults (one
 *      scoped, one not) behave independently off the same recipe.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { MemoryRecipientSealer } from '../../src/with-party/team/managed-passphrase.js'
import { withSealedRecord } from '../../src/with-audit/sealed-record/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withForgetCascade } from '../../src/with-audit/forget/index.js'
import { withBlobs } from '../../src/via/blob/index.js'
import { classified } from '../../src/via/classified/presets.js'

/** In-memory store exposing raw stored envelopes + a `list()` call log for
 *  white-box assertions (the blob arm's "no scan for undeclared" pin needs
 *  to see that `_blob_slots_<undeclared>` was never listed). */
function memory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  listCalls: { vault: string; collection: string }[]
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const listCalls: { vault: string; collection: string }[] = []
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    listCalls,
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) {
      listCalls.push({ vault: c, collection: col })
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Person { id: string; subjectId: string; name: string; ssn: string }
interface Contact { id: string; subjectId: string; email: string }
interface Inv { id: string; buyerId: string }

const SECRET = 'scoped-purge-passphrase-2026'
const HOUR = 60 * 60 * 1000
const bytes = (s: string) => new TextEncoder().encode(s)

describe('forget() scopedPurge — (a) DEFAULT parity (unconditional, pins today)', () => {
  it('a bare-sensitive+sealRecordToHost collection still gets its _sealed_cek envelope purged', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }), // no scopedPurge
      sealedRecordStrategy: withSealedRecord(),
    })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', name: 'Ada', ssn: '123-45-6789' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('people', 'p1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    expect(store.raw('v', '_sealed_cek', `people/p1/${pid}`)).toBeDefined()

    const result = await vault.forget('subject-1')

    expect(store.raw('v', '_sealed_cek', `people/p1/${pid}`)).toBeUndefined()
    expect(result.sealedCekEnvelopesPurged).toBe(1)
    expect(result.sealedCekResidue).toEqual([])
  })
})

describe('forget() scopedPurge — (b) SCOPED mode: sealed-CEK arm', () => {
  async function setup() {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({
        subjects: { contacts: 'subjectId', people: 'subjectId' },
        scopedPurge: true,
      }),
      sealedRecordStrategy: withSealedRecord(),
    })
    const vault = await db.openVault('v')
    // declared: classifiedFields — the "richer" declaration.
    const contacts = vault.collection<Contact>('contacts', {
      perRecordKeys: true,
      classifiedFields: { email: classified.email() },
    })
    // undeclared: bare `sensitive` (no classified binder) — can still be
    // sealed to a host ad hoc (the exact gap #633 names).
    const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    return { store, vault, contacts, people }
  }

  it('purges the declared collection, leaves the undeclared collection\'s entries in place + reports residue', async () => {
    const { store, vault, contacts, people } = await setup()
    await contacts.put('c1', { id: 'c1', subjectId: 'subject-1', email: 'ada@example.com' })
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', name: 'Ada', ssn: '123-45-6789' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid: contactsPid } = await vault.sealRecordToHost('contacts', 'c1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    const { pid: peoplePid } = await vault.sealRecordToHost('people', 'p1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })

    const result = await vault.forget('subject-1')

    // declared: purged.
    expect(store.raw('v', '_sealed_cek', `contacts/c1/${contactsPid}`)).toBeUndefined()
    // undeclared: NOT deleted.
    expect(store.raw('v', '_sealed_cek', `people/p1/${peoplePid}`)).toBeDefined()

    expect(result.sealedCekEnvelopesPurged).toBe(1) // contacts only
    expect(result.scopedPurgeResidue).toEqual([
      { reason: 'skipped-undeclared-sealed-cek', collection: 'people', count: 1 },
    ])
  })
})

describe('forget() scopedPurge — (c) SCOPED mode: blob arm', () => {
  async function setup() {
    const store = memory()
    const db = await createNoydb({
      store, user: 'a', secret: SECRET,
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({
        subjects: { invoicesDeclared: 'buyerId', invoicesUndeclared: 'buyerId' },
        scopedPurge: true,
      }),
    })
    const vault = await db.openVault('v')
    const declared = vault.collection<Inv>('invoicesDeclared', { blobFields: { 'contract.pdf': {} } })
    // undeclared: no blobFields option, yet `.blob(id)` is still called directly
    // (the exact "no-blobFields+blob()" gap #633 names, per-blob-cek.test.ts).
    const undeclared = vault.collection<Inv>('invoicesUndeclared')
    return { store, vault, declared, undeclared }
  }

  it('shreds the declared collection\'s blob; skips the undeclared collection\'s scan entirely + reports residue', async () => {
    const { store, vault, declared, undeclared } = await setup()
    await declared.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await declared.blob('i-1').put('contract.pdf', bytes('buyer-1 declared data'))
    await undeclared.put('i-2', { id: 'i-2', buyerId: 'buyer-1' })
    await undeclared.blob('i-2').put('contract.pdf', bytes('buyer-1 undeclared data'))

    store.listCalls.length = 0 // only care about calls made during forget()

    const result = await vault.forget('buyer-1')

    expect(result.blobsShredded).toBe(1) // declared only
    expect(result.scopedPurgeResidue).toContainEqual(
      { reason: 'skipped-undeclared-blob-scan', collection: 'invoicesUndeclared', count: 1 },
    )
    // the perf win: no per-collection list() scan for the undeclared collection.
    expect(store.listCalls.some((c) => c.collection === '_blob_slots_invoicesUndeclared')).toBe(false)
    // the undeclared blob survives untouched (never scanned, never shredded).
    expect(new TextDecoder().decode((await undeclared.blob('i-2').get('contract.pdf'))!)).toBe('buyer-1 undeclared data')
  })
})

describe('forget() scopedPurge — (d) per-vault independence', () => {
  it('a scoped vault and an unscoped vault behave independently off the same recipe', async () => {
    async function buildVault(scopedPurge: boolean | undefined) {
      const store = memory()
      const db = await createNoydb({
        store, user: 'alice', secret: SECRET,
        historyStrategy: withHistory(),
        forgetStrategy: withForgetCascade({
          subjects: { people: 'subjectId' },
          ...(scopedPurge !== undefined ? { scopedPurge } : {}),
        }),
        sealedRecordStrategy: withSealedRecord(),
      })
      const vault = await db.openVault('v')
      const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
      await people.put('p1', { id: 'p1', subjectId: 'subject-1', name: 'Ada', ssn: '123-45-6789' })
      const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
      const { pid } = await vault.sealRecordToHost('people', 'p1', host, {
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
      })
      return { store, vault, pid }
    }

    const scoped = await buildVault(true)
    const unscoped = await buildVault(false)

    const scopedResult = await scoped.vault.forget('subject-1')
    const unscopedResult = await unscoped.vault.forget('subject-1')

    // scoped: undeclared collection's envelope survives + reported.
    expect(scoped.store.raw('v', '_sealed_cek', `people/p1/${scoped.pid}`)).toBeDefined()
    expect(scopedResult.scopedPurgeResidue).toEqual([
      { reason: 'skipped-undeclared-sealed-cek', collection: 'people', count: 1 },
    ])

    // unscoped: unconditional purge, exactly today's behavior.
    expect(unscoped.store.raw('v', '_sealed_cek', `people/p1/${unscoped.pid}`)).toBeUndefined()
    expect(unscopedResult.scopedPurgeResidue).toEqual([])
  })
})
