/**
 * `open(podBytesOrFile)` — the pod READ-path orchestrator (#941 Task 4).
 *
 * A free function (never a `Vault` method — `kernel/vault.ts` is at its
 * line ceiling and open() needs no vault-internal state that isn't already
 * reachable through published seams). Composes, in order:
 *
 *   1. `readPod` — parse + integrity-check the container (throws
 *      `BundleIntegrityError` on a corrupted/truncated pod).
 *   2. `verifyPodHeader` — only when `opts.trustedKeys` is supplied.
 *      `'unsigned'` is benign (legacy pod, or `writePod({ sign: false })`)
 *      and open() proceeds; `'untrusted'` / `'tampered'` are fail-closed —
 *      `PodHeaderVerificationError` — mirroring `followRedirects`'s
 *      `RedirectBadSignatureError` posture: once a caller opts into
 *      verification, an unverifiable header is a hard stop.
 *   3. `createNoydb` + `openVault` + `vault.load(dumpJson)` — the exact
 *      unlock+restore sequence `bundle-roundtrip.test.ts` drives by hand.
 *      The pod header carries no vault name (minimum-disclosure —
 *      `format.ts`'s forbidden-fields list), so the caller names the
 *      target vault via `opts.vault`.
 *   4. Re-derive the `SchemaManifest` from the just-restored `_schemas/*`
 *      (the source of truth — Task 3's `deriveSchemaManifest`), via a
 *      NON-MINTING `LookupDEK` built from `loadKeyring`'s already-unwrapped
 *      `UnlockedKeyring.deks` map directly (`with-party/team/keyring.js`).
 *      **Not** `ensureCollectionDEK` (#941 review fix — Important 2): that
 *      helper mints+persists a fresh DEK into `_keyring/<user>` for any
 *      collection absent from the keyring, which is correct for a WRITE
 *      path but wrong here — `deriveSchemaManifest` only ever reads
 *      collections that already have a `_schemas` envelope, so an absent
 *      DEK means "this principal can't decrypt this sibling" (e.g. a
 *      collection-scoped grantee), never "new collection." The old
 *      minting call polluted a scoped principal's freshly-restored keyring
 *      with garbage sibling DEKs on every `open()`. The returned
 *      `manifest` is that principal's own visible slice — see
 *      `derive.ts`'s `LookupDEK` doc and `sync.ts`'s module doc for the
 *      full rationale (the same distinction governs why the sync path
 *      must SKIP rather than write a partial manifest).
 *   5. Generation check (AC #4 coexistence): compare the HIGHEST
 *      per-collection generation stamp carried by the restored manifest
 *      against THIS store's schema-fence generation as it stood
 *      immediately before the restore (0 for a brand-new vault; whatever a
 *      coexisting local vault already had). If the pod is ahead and
 *      `!opts.allowGenerationAhead`, throw `MigrationRequiredError` (the
 *      same class `SchemaFenceController`'s write-path gate throws) — the
 *      reader hasn't reconciled schema changes that happened elsewhere.
 *      `allowGenerationAhead: true` is the documented dev override: open
 *      proceeds, with a console warning. Divergence in the OTHER direction
 *      (reader ahead of the pod) is non-fatal but also warned (#941
 *      review, Important 3 — AC #4 coexistence divergence must be
 *      observable in either direction, not just the bypass case).
 *
 *      NOTE: this deliberately reads per-collection entries, not
 *      `manifest.generation` itself. `_meta/schema-fence` is local
 *      session-coordination state and does NOT travel in a pod dump
 *      (`with-pod/backup.ts`'s reserved-collection list carries `_schemas`
 *      and `_manifest` but not `_meta`) — a fresh re-derive's top-level
 *      `generation` is always driven by the (untouched-by-restore) target
 *      store's own fence, not the pod's. Each `_schemas/<collection>`
 *      envelope's own `generation` field DOES travel (it's stamped at
 *      declare-time from the writer's real fence), so per-collection
 *      entries are the only signal that survives a restore intact.
 *
 * @module
 */

import { readPod, verifyPodHeader } from './bundle.js'
import type { NoydbPodHeader } from './format.js'
import type { PodVerifyResult } from './bundle.js'
import { createNoydb } from '../kernel/noydb.js'
import type { Noydb } from '../kernel/noydb.js'
import type { Vault } from '../kernel/vault.js'
import type { NoydbOptions, NoydbStore, EchoSecretParts } from '../kernel/types.js'
import { MigrationRequiredError, PodHeaderVerificationError } from '../kernel/errors.js'
import { loadKeyring } from '../with-party/team/keyring.js'
import { loadFence } from '../with-shape/schema-update/fence.js'
import { deriveSchemaManifest, type LookupDEK } from '../with-shape/manifest/derive.js'
import type { SchemaManifest } from '../with-shape/manifest/types.js'

export interface OpenPodOptions {
  /** The ciphertext store to restore into (and where the opened `Vault` lives). */
  readonly store: NoydbStore
  /**
   * The target vault name. The pod header deliberately carries no vault
   * name (minimum-disclosure — `NoydbPodHeader`'s forbidden-fields list),
   * so the caller names the vault to restore into/open.
   */
  readonly vault: string
  /** User identifier — passed through to `createNoydb`. */
  readonly user: string
  /** That user's secret — passed through to `createNoydb` / `loadKeyring`. */
  readonly secret: string | EchoSecretParts
  /**
   * Trusted signing keys (`keyId → publicKeyB64`). When supplied,
   * `verifyPodHeader` runs and its result is returned as `verification`.
   * Omitted → no verification attempted, `verification` is absent.
   */
  readonly trustedKeys?: Readonly<Record<string, string>>
  /**
   * Passthrough to `createNoydb` for every option beyond `store`/`user`/
   * `secret` (history/indexing/blobs/… strategies, `secretMode`, etc.).
   */
  readonly noydbOptions?: Omit<NoydbOptions, 'store' | 'user' | 'secret'>
  /**
   * Dev override for the generation-ahead fence (AC #4). Default `false`:
   * a pod whose schema manifest generation is ahead of this store's
   * pre-restore fence generation throws `MigrationRequiredError`. `true`
   * opens anyway, logging a console warning.
   */
  readonly allowGenerationAhead?: boolean
}

export interface OpenPodResult {
  readonly db: Noydb
  readonly vault: Vault
  readonly header: NoydbPodHeader
  /** Present iff `opts.trustedKeys` was supplied. */
  readonly verification?: PodVerifyResult
  /** The pod's schema manifest, re-derived from the just-restored `_schemas/*`. */
  readonly manifest?: SchemaManifest
}

/**
 * Open a `.noydb` pod: verify its integrity (and, opt-in, its signature),
 * unlock + restore it into `opts.vault`, and re-derive its schema manifest.
 * See the module doc for the full flow and the errors each step can throw.
 */
export async function open(podFileOrBytes: Uint8Array, opts: OpenPodOptions): Promise<OpenPodResult> {
  const { header, dumpJson } = await readPod(podFileOrBytes)

  let verification: PodVerifyResult | undefined
  if (opts.trustedKeys !== undefined) {
    verification = await verifyPodHeader(podFileOrBytes, opts.trustedKeys)
    if (verification.status === 'untrusted' || verification.status === 'tampered') {
      throw new PodHeaderVerificationError(verification.status, verification.keyId)
    }
  }

  // Reader's pre-restore generation snapshot (see module doc, step 5) —
  // must be read from the raw store BEFORE vault.load() overwrites it.
  const readerGeneration = (await loadFence(opts.store, opts.vault)).currentSchemaVersion

  const db = await createNoydb({ ...opts.noydbOptions, store: opts.store, user: opts.user, secret: opts.secret })
  const vault = await db.openVault(opts.vault)
  await vault.load(dumpJson)

  // #941 review fix: a NON-MINTING lookup, not `ensureCollectionDEK` (which
  // mints+persists a fresh DEK for any collection absent from the keyring).
  // open() is a READ path — deriveSchemaManifest only ever iterates
  // collections that already have a `_schemas` envelope, so an absent DEK
  // here means "this principal cannot decrypt this sibling," never "new
  // collection." The old minting call polluted a scoped principal's just-
  // restored `_keyring/<user>` file with garbage sibling DEKs on every
  // open(). See `derive.ts`'s `LookupDEK` doc for the full rationale.
  const keyring = await loadKeyring(opts.store, opts.vault, { userId: opts.user, secret: opts.secret })
  const lookupDEK: LookupDEK = async (name) => keyring.deks.get(name)
  const { manifest, undecodableCollections } = await deriveSchemaManifest(opts.store, opts.vault, lookupDEK)

  // A scoped principal's `manifest` is legitimately their own visible
  // slice (see `sync.ts`'s module doc) — `open()` is a per-principal read,
  // not an assertion of pod-wide completeness. `undecodableCollections` is
  // intentionally not surfaced on `OpenPodResult` (out of this fix's
  // scope); callers that need it can call `deriveSchemaManifest` directly.
  void undecodableCollections

  // See module doc, step 5 — the pod's generation signal is the highest
  // per-collection stamp, not the (locally re-derived, fence-driven)
  // top-level `manifest.generation`.
  const podGeneration = Object.values(manifest.collections)
    .reduce((max, entry) => Math.max(max, entry.generation), 0)

  if (podGeneration > readerGeneration) {
    if (!opts.allowGenerationAhead) {
      throw new MigrationRequiredError(
        `open(): pod's schema generation (${podGeneration}) is ahead of vault ` +
          `"${opts.vault}"'s local generation (${readerGeneration}). Pass ` +
          `\`allowGenerationAhead: true\` to open anyway, or reconcile the schema first.`,
      )
    }
    console.warn(
      `[noy-db] open(): vault "${opts.vault}" opened with allowGenerationAhead — pod schema ` +
        `generation ${podGeneration} is ahead of the local generation ${readerGeneration}.`,
    )
  } else if (podGeneration < readerGeneration) {
    // #941 review (Important 3, AC #4): divergence in EITHER direction
    // should be observable, not just the ahead-bypass case above. The
    // reader being ahead of the pod is non-fatal (the pod is simply older
    // content) but silent coexistence divergence is exactly what AC #4
    // asks to surface — same `[noy-db]`-prefixed console.warn facility as
    // `sync.ts`'s cap-exhaustion warning.
    console.warn(
      `[noy-db] open(): vault "${opts.vault}"'s local schema generation (${readerGeneration}) is ` +
        `ahead of the pod's (${podGeneration}) — the pod reflects an earlier schema than this reader.`,
    )
  }

  return { db, vault, header, manifest, ...(verification !== undefined ? { verification } : {}) }
}
