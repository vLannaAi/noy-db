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

/**
 * Why a sweep could not reach a conclusion.
 *
 * - `'no-expectations'` — the head holds nothing for this collection. A fresh
 *   vault, a head switched on after the fact, or a **restore from a snapshot**:
 *   `_head` is `_`-prefixed, so `loadAll` excludes it and a restored vault has
 *   no head to compare against.
 * - `'store-cannot-cas'` — the store does not advertise `capabilities.casAtomic`,
 *   so two writers racing on one bucket can silently lose an entry. A lost entry
 *   is a record the sweep stops expecting, which is a false clean.
 */
export type HeadUnverifiableReason = 'no-expectations' | 'store-cannot-cas'

/**
 * ## Three-way, deliberately (#1101)
 *
 * - `'verified'` — the head held expectations, every one was met, and the store
 *   can serialize head writes.
 * - `'unverifiable'` — the sweep could not conclude. See `because`.
 * - `'tampered'` — at least one discrepancy. Positive evidence, so it wins over
 *   any `unverifiable` reason present at the same time.
 *
 * **The middle value is the point, and collapsing it is wrong in a different
 * direction each way:** folded into "clean" it hides withholding, which is the
 * one thing this service exists to catch; folded into "tampered" it cries wolf
 * on a vault that is merely unexamined.
 *
 * That is not hypothetical. #1044's own first bug was a head that recorded
 * nothing and swept **perfectly clean** — the degraded state rendered
 * identically to a healthy one, which is why its test asserts `checked` before
 * anything else. A two-way verdict makes that state a supported outcome.
 */
export type HeadVerdict = 'verified' | 'unverifiable' | 'tampered'

export interface HeadVerifyResult {
  readonly verdict: HeadVerdict
  readonly checked: number
  readonly discrepancies: readonly HeadDiscrepancy[]
  /**
   * Non-empty only when `verdict === 'unverifiable'`.
   *
   * There is deliberately no `clean: boolean`. It could not distinguish "no
   * expectations" from "all expectations met" — both rendered `true` — and that
   * indistinguishability *was* the defect. Replacing it rather than keeping it
   * alongside forces every caller to face the three-way.
   */
  readonly because: readonly HeadUnverifiableReason[]
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

  const because: HeadUnverifiableReason[] = []
  if (known.size === 0) because.push('no-expectations')
  // Read the store's OWN declared capability rather than probing: a store that
  // cannot serialize head writes may have silently dropped an entry, and a
  // dropped entry is invisible by construction — there is nothing left to find.
  if (store.capabilities?.casAtomic !== true) because.push('store-cannot-cas')

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

  // A discrepancy is positive evidence, so it outranks any reason the sweep was
  // also incomplete: a rolled-back record found by a head that may be missing
  // OTHER entries is still a rolled-back record.
  const verdict: HeadVerdict = discrepancies.length > 0
    ? 'tampered'
    : because.length > 0 ? 'unverifiable' : 'verified'

  return { verdict, checked: known.size, discrepancies, because }
}
