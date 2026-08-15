/**
 * The sweep — comparing what the head expects against what the store serves (#1044).
 *
 * This is the only place absence becomes visible. #1041 and #1042 can reject a
 * record that lies about itself; neither can notice one that never arrived, or
 * one served at an older version than the client wrote. Both are indistinguishable
 * from the truth without an independent record of what should be there.
 *
 * @packageDocumentation
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import type { VaultHeadStrategy } from './strategy.js'

/** One record the store is not serving faithfully. */
export interface HeadDiscrepancy {
  readonly collection: string
  readonly id: string
  /** What the client last committed. */
  readonly expected: number
  /**
   * What the store serves now — or `null` when it serves nothing.
   *
   * The two are different attacks wearing the same result. `null` is
   * **suppression**: the record is gone. A lower number is **rollback**: an
   * authentic older version served in place of the current one, which is the
   * case no amount of per-envelope authentication can see.
   */
  readonly actual: number | null
  readonly kind: 'withheld' | 'rolled-back'
}

export interface HeadVerifyResult {
  readonly checked: number
  readonly discrepancies: readonly HeadDiscrepancy[]
  /** `true` when every record the head knows about is served at or above its expected version. */
  readonly clean: boolean
}

/**
 * Sweep one collection.
 *
 * **A record the store serves that the head does NOT know is not reported.**
 * That is not an oversight: the head can be enabled on an existing vault, and
 * every pre-existing record would otherwise read as an anomaly. The head's
 * claim is one-directional — *what I wrote must still be there* — and an
 * unknown record simply falls outside it.
 *
 * **A HIGHER version than expected is also not reported**, for the same reason:
 * another device legitimately advanced it. The head detects going backwards, not
 * moving forwards.
 */
export async function verifyVaultHead(
  head: VaultHeadStrategy,
  store: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<EnclaveKey>,
  collection: string,
): Promise<HeadVerifyResult> {
  const known = await head.knownIn(store, vault, getDEK, collection)
  const discrepancies: HeadDiscrepancy[] = []

  for (const [id, expected] of known) {
    const env = await store.get(vault, collection, id)
    if (env === null) {
      discrepancies.push({ collection, id, expected, actual: null, kind: 'withheld' })
      continue
    }
    if (env._v < expected) {
      discrepancies.push({ collection, id, expected, actual: env._v, kind: 'rolled-back' })
    }
  }

  return { checked: known.size, discrepancies, clean: discrepancies.length === 0 }
}
