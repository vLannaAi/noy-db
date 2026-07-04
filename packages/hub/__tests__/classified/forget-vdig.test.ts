import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { buildTombstone } from '../../src/kernel/enclave/index.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

describe('forget() × _vdig', () => {
  it('a tombstone structurally carries no _vdig', () => {
    expect(buildTombstone(4, 'actor')._vdig).toBeUndefined()
  })

  it('classifySealedShred reports vdig slots as shreddable on a _cek record (no dekResidue class)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-10' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true, sensitive: ['ssn'],
      classifiedFields: { password: passwordSpec },
    })
    await c.put('u1', { ssn: '123-45-6789', password: 'correct-horse-battery' })
    const live = store._dump('v1', 'users', 'u1')!
    expect(live._vdig?.password).toBeDefined()
    // reach the codec through the collection's internal shim, as forget() does
    const result = await (c as unknown as {
      _classifySealedShred(e: unknown): Promise<{ shreddable: string[]; dekResidue: string[] }>
    })._classifySealedShred(live)
    expect(result.shreddable).toContain('password')
    expect(result.shreddable).toContain('ssn')       // CEK-sealed slot, unchanged behavior
    expect(result.dekResidue).not.toContain('password')
  }, 60_000)
})
