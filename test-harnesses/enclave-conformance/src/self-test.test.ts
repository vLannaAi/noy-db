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
import { describe } from 'vitest'
import { EnclaveNotSupportedError } from '@noy-db/hub'
import * as real from '../../../packages/hub/src/kernel/enclave/index.js'
import { runEnclaveConformance, type EnclaveModule } from './index.js'

type Group = 'sealing' | 'deterministic' | 'per-record-keys'

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
  }
}

describe('kit self-test: sealing unsupported', () => {
  runEnclaveConformance(makeStub('sealing'), {
    supports: { sealing: false, deterministic: true, perRecordKeys: true },
  })
})

describe('kit self-test: deterministic unsupported', () => {
  runEnclaveConformance(makeStub('deterministic'), {
    supports: { sealing: true, deterministic: false, perRecordKeys: true },
  })
})

describe('kit self-test: per-record-keys unsupported', () => {
  runEnclaveConformance(makeStub('per-record-keys'), {
    supports: { sealing: true, deterministic: true, perRecordKeys: false },
  })
})
