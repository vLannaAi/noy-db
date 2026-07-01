import { describe, it, expect } from 'vitest'
import * as cargo from '../src/cargo/index.js'

describe('@noy-db/hub/cargo surface', () => {
  it('re-exports the /kernel runtime floor', () => {
    for (const s of ['generateULID', 'sha256Hex', 'isQuorum', 'runDrainBarrier',
                     'fuseRetrieval', 'readPath', 'reduceRecords', 'groupAndReduce']) {
      expect(cargo[s as keyof typeof cargo], s).toBeTypeOf('function')
    }
  })
  it('adds the orchestration delta (custody/deed/diff/addressing)', () => {
    for (const s of ['CustodyApi', 'liberateVault', 'createDeedOwner',
                     'loadDeedMarker', 'isDeedVault', 'diffVault', 'STATE_VAULT_NAME']) {
      expect(cargo[s as keyof typeof cargo], s).toBeDefined()
    }
  })
})
