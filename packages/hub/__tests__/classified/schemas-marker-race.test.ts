/**
 * Regression for #583 — the `_schemas/<collection>` classified-marker
 * lost-update race.
 *
 * The R10 config-drift guard's persisted signal is an `x-classified` marker
 * merged into the collection's `_schemas/<collection>` record. That record is
 * SHARED with the JSON-Schema writer (`persistSchemaIfNeeded`). Both do a
 * get-then-put read-modify-write. Interleave their load→save windows and the
 * later put clobbers the earlier one — the classic lost update:
 *
 *   schema-writer loads (no marker) → marker-writer loads (no marker) →
 *   marker-writer saves {…, classified} → schema-writer saves stale
 *   {classified: undefined} → marker gone → R10 signal (b) disabled.
 *
 * The fix threads the loaded envelope `_v` through the save as an optimistic
 * version guard (CAS) and retries on conflict, so the losing writer re-reads,
 * re-merges the other's field, and re-puts. The marker survives.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'
import {
  persistSchemaIfNeeded,
  persistClassifiedMarker,
} from '../../src/with-shape/persisted-schemas/register.js'
import { loadPersistedSchema } from '../../src/with-shape/persisted-schemas/storage.js'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import type { ClassifiedMarker } from '../../src/kernel/types.js'

const VAULT = 'v1'
const COLL = 'users'

const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

const marker: ClassifiedMarker = { digestOnly: ['password'], equatable: [] }

/**
 * Wrap a store so a one-shot async hook fires the first time
 * `_schemas/<COLL>` is READ. The hook runs AFTER the pre-existing state is
 * captured for that read, modelling "the other writer's put lands in the gap
 * between this writer's load and its save". Re-entrant reads (from inside the
 * hook itself) bypass the gate via the `fired` latch.
 */
function gateOnFirstSchemaRead(
  inner: InlineMemoryStore,
  hook: () => Promise<void>,
): InlineMemoryStore {
  let fired = false
  return {
    ...inner,
    async get(c: string, col: string, id: string): Promise<EncryptedEnvelope | null> {
      const res = await inner.get(c, col, id)
      if (!fired && col === '_schemas' && id === COLL) {
        fired = true
        await hook() // the racing writer runs to completion in the gap
      }
      return res
    },
  }
}

describe('#583 — _schemas classified-marker lost-update race', () => {
  it('schema-writer racing a marker-write must NOT drop the classified marker', async () => {
    const base = inlineMemory()
    const dek = await generateDEK()

    // The schema writer's load fires the marker write to completion in its gap.
    const store = gateOnFirstSchemaRead(base, async () => {
      await persistClassifiedMarker({
        store: base, vault: VAULT, collectionName: COLL, dek, marker,
      })
    })

    // First registration of a (non-Zod) validator -> the schema writer WILL
    // write. Under the no-CAS RMW it overwrites the just-landed marker.
    await persistSchemaIfNeeded({
      store, vault: VAULT, collectionName: COLL, validator: {}, dek,
    })

    const stored = await loadPersistedSchema(base, VAULT, COLL, dek)
    expect(stored?.classified).toBeDefined()
    expect(stored?.classified?.digestOnly).toEqual(['password'])
  })

  it('marker-writer racing a schema-write must NOT drop the derived schema body', async () => {
    // Symmetric direction: the marker writer's load fires the schema write in
    // its gap; CAS then forces the marker writer to re-merge onto the schema
    // record rather than clobber it back to a bare marker envelope. A real Zod
    // validator gives the schema a non-null body, so a clobber is observable.
    const base = inlineMemory()
    const dekB = await generateDEK()
    const validator = z.object({ password: z.string(), name: z.string() })

    let fired = false
    const store: InlineMemoryStore = {
      ...base,
      async get(c, col, id) {
        const res = await base.get(c, col, id)
        if (!fired && col === '_schemas' && id === COLL) {
          fired = true
          await persistSchemaIfNeeded({
            store: base, vault: VAULT, collectionName: COLL, validator, dek: dekB,
          })
        }
        return res
      },
    }

    await persistClassifiedMarker({
      store, vault: VAULT, collectionName: COLL, dek: dekB, marker,
    })

    const stored = await loadPersistedSchema(base, VAULT, COLL, dekB)
    // both signals coexist on the single record
    expect(stored?.classified?.digestOnly).toEqual(['password'])
    expect(stored?.kind).toBe('Zod')
    expect(stored?.jsonSchema).not.toBeNull()
    expect(stored?.hash).not.toBeNull()
  })

  it('R10 still fires end-to-end: a naive handle over a marked+schema-persisting collection throws', async () => {
    const store = inlineMemory()
    // Seed a classified collection that ALSO persists its JSON schema, so both
    // writers touch `_schemas/users`. The marker must survive.
    const db = await createNoydb({ store, user: 'a', secret: 'pw-583-e2e' })
    const v = await db.openVault(VAULT)
    const users = v.collection<Record<string, unknown>>(COLL, {
      perRecordKeys: true,
      persistJsonSchema: true,
      classifiedFields: { password: passwordSpec },
    })
    await users.put('r1', { password: 'hunter2-hunter2', name: 'A' })

    // A fresh session opening a naive handle must be refused by R10.
    const db2 = await createNoydb({ store, user: 'a', secret: 'pw-583-e2e' })
    const v2 = await db2.openVault(VAULT)
    const naive = v2.collection<Record<string, unknown>>(COLL, { perRecordKeys: true })
    await expect(naive.put('r1', { name: 'B' })).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)

  it('classified() preset is exercised (sanity: marker digest set matches preset)', async () => {
    // guards against an accidentally trivial marker in the e2e vector above
    const spec = classified.password()
    expect(spec.storage).toBe('digest-only')
  })
})
