/**
 * #629 Task 10 — `vault.forget()` routes a `classifiedFields`-declared
 * collection's sealed-slot classification through `Collection._onViaErase`
 * (the classified via binding's `erase()` hook, wired for real with
 * `RecordCodec.classifySealedShred`), NOT the hand-rolled
 * `_classifySealedShred` fallback `forget-sealed-erasure.test.ts` exercises
 * for bare-`sensitive` collections (no classified binding compiled in).
 * Parity pin: identical `sealedFieldsShredded`/`sealedResidue` semantics
 * either way — mirrors `forget-sealed-erasure.test.ts`'s M-1 vectors.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withForget } from '../../src/with-audit/forget/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { classified } from '../../src/via/classified/presets.js'
import { encrypt, deriveSealedFieldKey, generateDEK, wrapCek } from '../../src/kernel/enclave/index.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope } from '../../src/kernel/types.js'
import { inlineMemory } from '../classified/harness.js'

interface Person { id: string; subjectId: string; email: string }

const SECRET = 'via-erase-fold-classified-secret-2026'

async function setup() {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'alice', secret: SECRET,
    historyStrategy: withHistory(),
    forgetStrategy: withForget({ subjects: { people: 'subjectId' } }),
  })
  const vault = await db.openVault('v')
  const people = vault.collection<Person>('people', {
    perRecordKeys: true,
    classifiedFields: { email: classified.email() },
  })
  return { store, vault, people }
}

describe('forget() x classified via binding - _onViaErase (#629 Task 10)', () => {
  it('a normally-written CEK-derived classified recoverable slot is shredded, not residue', async () => {
    const { vault, people } = await setup()
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', email: 'ada@example.com' })

    const result = await vault.forget('subject-1')

    expect(result.sealedFieldsShredded).toBe(1)
    expect(result.sealedResidue).toEqual([])
  })

  it('a legacy DEK-derived classified slot is reported as residue, NOT counted shredded', async () => {
    const { store, vault, people } = await setup()
    // Register the subject index with a normal write first.
    await people.put('p1', { id: 'p1', subjectId: 'subject-2', email: 'placeholder@x.com' })

    // Forge the pre-#306 shape: body CEK-encrypted (`_cek` present) but
    // `_sealed.email` derived off the collection DEK (legacy) — mirrors
    // forget-sealed-erasure.test.ts's M-1 vector exactly, but on a
    // classifiedFields-declared collection (via binding compiled in).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey
    const dekKey = await deriveSealedFieldKey(dek, 'people', 'email')
    const sealedEnc = await encrypt(JSON.stringify('ada@example.com'), dekKey)
    const slot = `${sealedEnc.iv}:${sealedEnc.data}`

    const cek = await generateDEK()
    const body = await encrypt(JSON.stringify({ id: 'p1', subjectId: 'subject-2' }), cek)
    const wrapped = await wrapCek(cek, dek)
    const forged: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 2,
      _ts: new Date().toISOString(),
      _iv: body.iv,
      _data: body.data,
      _cek: wrapped,
      _sealed: { email: slot },
    }
    await store.put('v', 'people', 'p1', forged)

    const result = await vault.forget('subject-2')

    expect(result.sealedResidue).toContain('people:p1:email')
    expect(result.sealedFieldsShredded).toBe(0)
  })
})
