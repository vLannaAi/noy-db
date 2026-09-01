/**
 * Kit self-test — a test of the test.
 *
 * noy-db's own enclave (exercised in `conformance.test.ts`) supports every
 * optional group, so its run never takes the "EVERY function in the group
 * throws `EnclaveNotSupportedError`" branches in `runEnclaveConformance`.
 * Without this file that half of the kit would ship unexercised. This wraps
 * the REAL (wire-compatible) core primitives and forces exactly one optional
 * group at a time to throw `EnclaveNotSupportedError`, run once per group, to
 * prove those branches actually fire and actually pass.
 */
import { describe, it, expect } from 'vitest'
import { EnclaveNotSupportedError } from '@noy-db/hub'
import * as real from '../../../packages/hub/src/kernel/enclave/index.js'
import { runEnclaveConformance, assertGroupRefuses, type EnclaveModule } from '../src/index.js'

type Group = 'sealing' | 'deterministic' | 'per-record-keys' | 'classify'

function refuses(group: Group): (...args: never[]) => Promise<never> {
  return async () => {
    throw new EnclaveNotSupportedError(group)
  }
}

/** The real enclave, with exactly one optional group forced to refuse. */
function makeStub(unsupportedGroup: Group): EnclaveModule<CryptoKey> {
  return {
    encrypt: real.encrypt,
    decrypt: real.decrypt,
    generateDEK: real.generateDEK,
    deriveKey: real.deriveKey,
    wrapKey: real.wrapKey,
    unwrapKey: real.unwrapKey,
    openEnvelopeJson: real.openEnvelopeJson,
    writeEnvelopeBody: real.writeEnvelopeBody,
    hasPerRecordKey: real.hasPerRecordKey,
    envelopeBodyForHash: real.envelopeBodyForHash,
    isTombstone: real.isTombstone,
    buildTombstone: real.buildTombstone,
    deriveSealedFieldKey: unsupportedGroup === 'sealing' ? refuses('sealing') : real.deriveSealedFieldKey,
    deriveSealedFieldKeyFromCek:
      unsupportedGroup === 'sealing' ? refuses('sealing') : real.deriveSealedFieldKeyFromCek,
    encryptDeterministic:
      unsupportedGroup === 'deterministic' ? refuses('deterministic') : real.encryptDeterministic,
    decryptDeterministic:
      unsupportedGroup === 'deterministic' ? refuses('deterministic') : real.decryptDeterministic,
    wrapCek: unsupportedGroup === 'per-record-keys' ? refuses('per-record-keys') : real.wrapCek,
    unwrapCek: unsupportedGroup === 'per-record-keys' ? refuses('per-record-keys') : real.unwrapCek,
    encryptBytesWithAAD: unsupportedGroup === 'classify' ? refuses('classify') : real.encryptBytesWithAAD,
    decryptBytesWithAAD: unsupportedGroup === 'classify' ? refuses('classify') : real.decryptBytesWithAAD,
    deriveVdigSlotKey: unsupportedGroup === 'classify' ? refuses('classify') : real.deriveVdigSlotKey,
    pbkdf2VerifyDigest: unsupportedGroup === 'classify' ? refuses('classify') : real.pbkdf2VerifyDigest,
    deriveClassifyIndexKey:
      unsupportedGroup === 'classify' ? refuses('classify') : real.deriveClassifyIndexKey,
    deriveClassifyIndexSalt:
      unsupportedGroup === 'classify' ? refuses('classify') : real.deriveClassifyIndexSalt,
    mintBidxTag: unsupportedGroup === 'classify' ? refuses('classify') : real.mintBidxTag,
    computeBidxTarget: unsupportedGroup === 'classify' ? refuses('classify') : real.computeBidxTarget,
    ctEqualTags:
      unsupportedGroup === 'classify'
        ? () => {
            throw new EnclaveNotSupportedError('classify')
          }
        : real.ctEqualTags,
    evaluateKofN:
      unsupportedGroup === 'classify'
        ? () => {
            throw new EnclaveNotSupportedError('classify')
          }
        : real.evaluateKofN,
  }
}

describe('kit self-test: sealing unsupported', () => {
  runEnclaveConformance(makeStub('sealing'), {
    supports: { sealing: false, deterministic: true, perRecordKeys: true, classify: true },
  })
})

describe('kit self-test: deterministic unsupported', () => {
  runEnclaveConformance(makeStub('deterministic'), {
    supports: { sealing: true, deterministic: false, perRecordKeys: true, classify: true },
  })
})

describe('kit self-test: per-record-keys unsupported', () => {
  runEnclaveConformance(makeStub('per-record-keys'), {
    supports: { sealing: true, deterministic: true, perRecordKeys: false, classify: true },
  })
})

describe('kit self-test: classify unsupported', () => {
  runEnclaveConformance(makeStub('classify'), {
    supports: { sealing: true, deterministic: true, perRecordKeys: true, classify: false },
  })
})

/**
 * The three describes above only ever exercise a FULLY-supported or a
 * FULLY-unsupported group — `runEnclaveConformance` never sees a group
 * where one function refuses and its sibling silently "works". This
 * directly self-tests the group-consistency guarantee itself
 * (`assertGroupRefuses`, extracted from `runEnclaveConformance`'s optional-
 * group checks) against a deliberately MIXED stub, proving an inconsistent
 * fork enclave would be reported rather than swallowed.
 */
describe('kit self-test: assertGroupRefuses catches an inconsistent (mixed) group', () => {
  it('sealing: one function silently works while its sibling refuses — reported', async () => {
    const dek = await real.generateDEK()
    const mixed: EnclaveModule<CryptoKey> = {
      ...makeStub('sealing'),
      deriveSealedFieldKeyFromCek: async () => dek, // works — does not refuse
    }
    expect(await assertGroupRefuses(mixed, 'sealing')).toEqual(['deriveSealedFieldKeyFromCek'])
  })

  it('deterministic: one function silently works while its sibling refuses — reported', async () => {
    const mixed: EnclaveModule<CryptoKey> = {
      ...makeStub('deterministic'),
      decryptDeterministic: async () => 'plaintext', // works — does not refuse
    }
    expect(await assertGroupRefuses(mixed, 'deterministic')).toEqual(['decryptDeterministic'])
  })

  it('per-record-keys: one function silently works while its sibling refuses — reported', async () => {
    const dek = await real.generateDEK()
    const mixed: EnclaveModule<CryptoKey> = {
      ...makeStub('per-record-keys'),
      unwrapCek: async () => dek, // works — does not refuse
    }
    expect(await assertGroupRefuses(mixed, 'per-record-keys')).toEqual(['unwrapCek'])
  })

  it('a fully-consistent refusing group reports no failures', async () => {
    expect(await assertGroupRefuses(makeStub('sealing'), 'sealing')).toEqual([])
  })
})
