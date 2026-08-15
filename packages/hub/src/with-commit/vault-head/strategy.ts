/**
 * `withVaultHead()` — the opt-in detector for **omission** (#1044).
 *
 * ## What it is for, and what it deliberately is not
 *
 * #1041 made every envelope self-authenticating at its identity, and #1042
 * made the merge reject one that is not. What neither can catch is **absence**:
 * a store that serves a genuine, unmodified `v1` when `v7` exists, or serves
 * nothing at all. An authentic old envelope is indistinguishable from an
 * authentic current one without external knowledge of what *should* be there.
 *
 * The head is that external knowledge: an authenticated `{id → version}`
 * manifest the client writes and the store cannot forge. It is **not** a Merkle
 * chain over content — content integrity is already handled, so the head needs
 * only versions.
 *
 * ## Why it is opt-in when AAD is not
 *
 * AAD costs nothing to coordinate and closes *alteration*, so it is kernel. The
 * head costs a write per commit and needs anti-entropy; on a single-device
 * offline vault it defends against nothing. Making it kernel would tax every
 * user for a multi-writer property. ADR 0003, Decision 3.
 *
 * `SECURITY.md` states the split exactly: a store cannot alter, relocate,
 * re-tier, re-author or rewind a record; **without `withVaultHead()` it can
 * still withhold or omit.**
 *
 * ## Bucketed, and why that is not a compromise
 *
 * ADR 0003 left head granularity open and asked for it to be sized early.
 * Measured, at the documented 50K-record vault ceiling:
 *
 * | shape | write cost per commit | detection |
 * |---|---|---|
 * | one per-vault manifest | **1.1 MiB** | per-record |
 * | one per collection | the same problem, renamed | per-record |
 * | **bucketed, 256 buckets** | **~4.4 KiB** | per-record |
 *
 * Bucketing changes *only* write amplification. Each bucket still lists every
 * one of its records' versions, so detection stays per-record — which is why
 * this is not a trade-off between cost and strength. Verifying one pulled
 * record reads one bucket rather than a megabyte.
 *
 * @packageDocumentation
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/** Reserved collection the head's buckets live in. */
export const VAULT_HEAD_COLLECTION = '_head' as const

/** Default bucket count — see the sizing table above. */
export const DEFAULT_HEAD_BUCKETS = 256

export interface WithVaultHeadOptions {
  /**
   * How many buckets the manifest is split across. Higher means smaller writes
   * and more reads to sweep the whole vault; lower means the opposite.
   * Changing it on an existing vault re-homes every entry, so treat it as a
   * layout decision rather than a tuning knob.
   */
  readonly buckets?: number
}

/** One record's expected state, as the client last committed it. */
export interface HeadEntry {
  readonly collection: string
  readonly id: string
  readonly version: number
}

export interface VaultHeadStrategy {
  /** Bucket a record id lands in — pure, so callers can pre-group a batch. */
  bucketFor(collection: string, id: string): string

  /**
   * Record `entry` as the client's expectation for that record.
   *
   * Called on every committed write, INSIDE the same logical operation, so
   * there is no window where the record exists and the head does not know it.
   */
  note(
    store: NoydbStore,
    vault: string,
    getDEK: (collection: string) => Promise<EnclaveKey>,
    entry: HeadEntry,
  ): Promise<void>

  /**
   * What the client expects for `collection/id`, or `null` if the head has
   * never seen it.
   */
  expected(
    store: NoydbStore,
    vault: string,
    getDEK: (collection: string) => Promise<EnclaveKey>,
    collection: string,
    id: string,
  ): Promise<number | null>

  /**
   * Every record the head knows about in `collection` — the set a sweep
   * compares against what the store actually serves, which is how DELETION
   * SUPPRESSION is caught. A withheld record is absent from the store but
   * present here.
   */
  knownIn(
    store: NoydbStore,
    vault: string,
    getDEK: (collection: string) => Promise<EnclaveKey>,
    collection: string,
  ): Promise<ReadonlyMap<string, number>>
}

function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the vault-head capability. Pass \`vaultHeadStrategy: withVaultHead()\` ` +
    'from "@noy-db/hub/vault-head" to createNoydb().',
  )
}

/**
 * The un-opted-in stub. `note` is a NO-OP rather than a throw: the write path
 * calls it unconditionally, and a vault without the head must simply not keep
 * one. The READ side throws, because asking what the head expects when there is
 * no head is a caller error, not a silent "nothing to report" — the latter
 * would look exactly like a clean sweep.
 */
export const NO_VAULT_HEAD: VaultHeadStrategy = {
  bucketFor: () => '',
  async note() {},
  async expected() { throw notEnabled('vault.verifyHead()') },
  async knownIn() { throw notEnabled('vault.verifyHead()') },
}

export type { EncryptedEnvelope }
