/**
 * `Collection._applyCutoverTransform` — bulk-rewrite every record through a
 * coordinated-schema-cutover transform.
 *
 * Extracted from `collection.ts` (kernel-surface line ceiling) as a pure,
 * mechanical move — no behavior change. The delegator in `collection.ts`
 * builds a {@link CutoverTransformContext} from its own private members
 * (methods bound so `this` stays correct) and calls straight through.
 *
 * @internal
 */
import type { EncryptedEnvelope, NoydbStore, VdigFieldPolicy } from './types.js'
import { isTombstone, isDeleteMarker, type RecordCodec, type EnclaveKey } from './enclave/index.js'
import { assertCutoverTierSafe } from './tier-visibility.js'
import type { MutationOrigin } from './mutation.js'

/**
 * @internal Structural (not imported) view of `UnlockedKeyring` — only
 * `userId` is read here. Kept local rather than importing the with-party
 * type so this kernel-spine file stays clean of the port-layering guard
 * (Check 9) that `collection.ts` is individually grandfathered for.
 */
interface KeyringUserId {
  readonly userId: string
}

/**
 * @internal Structural (not imported) view of `LedgerStore` — only the
 * `append` shape this transform's single call site uses. Same
 * port-layering rationale as {@link KeyringUserId}.
 */
interface LedgerAppender {
  append(input: {
    readonly op: 'migration'
    readonly collection: string
    readonly id: string
    readonly version: number
    readonly actor: string
    readonly payloadHash: string
    readonly reason: string
  }): Promise<unknown>
}

/** @internal Exactly the `Collection` members `applyCutoverTransform` reads/calls. */
export interface CutoverTransformContext<T> {
  readonly adapter: NoydbStore
  readonly vault: string
  readonly name: string
  readonly tiers: ReadonlySet<number> | null
  readonly storeCiphertext: boolean
  readonly codec: RecordCodec<T>
  readonly perRecordCek: boolean
  readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null
  readonly ledger: LedgerAppender | undefined
  readonly keyring: KeyringUserId
  readonly envelopePayloadHash: (envelope: EncryptedEnvelope) => Promise<string>
  readonly resolveRecordCek: (id: string) => Promise<EnclaveKey>
  readonly onRecordMutated: (
    id: string,
    action: 'put' | 'delete',
    origin: MutationOrigin,
    ctx?: { readonly record?: T; readonly version?: number },
  ) => Promise<void>
  readonly transform: (doc: Record<string, unknown>) => Record<string, unknown>
}

/**
 * @internal — bulk-rewrite every record through a cutover transform. Raw adapter path (bypasses the write gate + guards — the transform is trusted and runs only during the `migrating` phase). Bumps each record's `_v` and appends a ledger `op:'migration'` entry. #708: refuses BEFORE any rewrite if a live record is elevated (assertCutoverTierSafe) — demote it first.
 */
export async function applyCutoverTransform<T>(ctx: CutoverTransformContext<T>): Promise<number> {
  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  await assertCutoverTierSafe(ctx.adapter, ctx.vault, ctx.name, ctx.tiers !== null)
  let count = 0
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env || isTombstone(env, ctx.storeCiphertext) || isDeleteMarker(env)) continue
    const decoded = await ctx.codec.decryptRecord({ collection: ctx.name, id }, env, { skipValidation: true, })
    if (decoded === null) continue // defensive: shredded between list and get
    const record = decoded as unknown as Record<string, unknown>
    const next = ctx.transform(record)
    const nextVersion = (env._v ?? 0) + 1
    // Migration pass: on a `perRecordKeys` collection, a legacy (no-`_cek`)
    // record gets a freshly minted CEK here (legacy → CEK re-encrypt), while
    // an already-CEK record reuses its stable CEK. This is the
    // erasure-completeness pass — once migrated, the record body is keyed
    // off a per-record CEK and a future shred can erase it. Until then it
    // stays directly under the collection DEK. `forget()`/shred reports
    // un-migrated records explicitly rather than claiming erasure.
    const cek = ctx.perRecordCek ? await ctx.resolveRecordCek(id) : undefined
    const migEnvelope = await ctx.codec.encryptRecord({ collection: ctx.name, id }, next as unknown as T, nextVersion, cek, undefined, undefined, ctx.vdigFields !== null ? { id, prev: env } : undefined)
    await ctx.adapter.put(ctx.vault, ctx.name, id, migEnvelope)
    await ctx.onRecordMutated(id, 'put', 'cutover') // refresh in-memory cache after the raw write (parity: cache only)
    if (ctx.ledger) {
      await ctx.ledger.append({
        op: 'migration', collection: ctx.name, id, version: nextVersion,
        actor: ctx.keyring.userId, payloadHash: await ctx.envelopePayloadHash(migEnvelope), reason: 'schema:coordinated-cutover',
      }).catch(() => { /* ledger is best-effort here */ })
    }
    count++
  }
  return count
}
