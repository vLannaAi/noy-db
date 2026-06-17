/**
 * @klum-db/lobby interchange — cross-vault FK-closure extraction.
 * Composes hub's intra-vault primitives + FR-1's encodeMultiBundle.
 * @packageDocumentation
 */
import type { Vault } from '@noy-db/hub'
import {
  walkClosure,
  extractPartition,
  encodeMultiBundle,
  readNoydbBundleHeader,
  NOYDB_MULTI_BUNDLE_VERSION,
  generateULID,
  describeExtraction,
  type MultiBundleManifest,
  type CompartmentManifest,
  type ExtractionPreview,
} from '@noy-db/hub/bundle'
import { sha256Hex } from '@noy-db/hub/kernel'

/** A denormalized cross-vault FK edge (hub refuses these as native refs). */
export interface CrossVaultRef {
  readonly from: { readonly collection: string; readonly field: string }
  readonly to: {
    readonly vault: string
    readonly collection: string
    /**
     * Target field the FK points to. **Currently must be `'id'` (or omitted).**
     * Non-`id` business-key target fields are not yet supported (will be added
     * when adopt/merge lands).
     */
    readonly field?: string
  }
}

/** Seed for the primary vault (predicate per collection, like hub walkClosure). */
export interface CrossVaultSeed {
  readonly vault: string
  readonly seeds: Record<string, (rec: Record<string, unknown>) => boolean | Promise<boolean>>
}

export interface CrossVaultClosurePlan {
  /** vault → seed predicates to feed extractPartition (primary: caller's; targets: id-membership). */
  readonly perVaultSeeds: Map<string, Record<string, (rec: Record<string, unknown>) => boolean | Promise<boolean>>>
  /** vault → intra closure (collection → ids). */
  readonly perVaultClosure: Map<string, Map<string, Set<string>>>
  /** referenced rows not found in their target closure. */
  readonly dangling: { vault: string; collection: string; id: string }[]
}

function asIdArray(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
  if (typeof v === 'string' || typeof v === 'number') return [String(v)]
  return []
}

/**
 * Walk an FK closure that spans vault boundaries via app-supplied cross-vault refs.
 *
 * @param openVault - resolver for a vault by name (idempotent in the hub —
 *   repeated calls return the same cached instance, so the per-round calls are free).
 * @param opts.maxDepth - bounds BOTH the number of inter-vault rounds (this planner's
 *   outer fixpoint loop) AND hub's intra-vault `walkClosure` FK depth. Default 16.
 */
export async function walkCrossVaultClosure(
  openVault: (name: string) => Promise<Vault>,
  opts: { seed: CrossVaultSeed; crossVaultRefs?: readonly CrossVaultRef[]; maxDepth?: number },
): Promise<CrossVaultClosurePlan> {
  const refs = opts.crossVaultRefs ?? []
  const maxDepth = opts.maxDepth ?? 16

  // Guard: non-id target fields are silently broken (dangling false-positives + fixpoint burn).
  // Fail loud until business-key target support is added with adopt/merge.
  for (const ref of refs) {
    if (ref.to.field !== undefined && ref.to.field !== 'id') {
      throw new Error(
        `cross-vault extraction: to.field "${ref.to.field}" (on ${ref.to.vault}/${ref.to.collection}) is not supported yet — `
        + `the cross-vault target field must be "id" (or omitted). Business-key target fields are a future enhancement.`,
      )
    }
  }

  const perVaultClosure = new Map<string, Map<string, Set<string>>>()
  const perVaultSeeds: CrossVaultClosurePlan['perVaultSeeds'] = new Map()
  // accumulated referenced ids per target vault+collection
  const targetIds = new Map<string, Map<string, Set<string>>>()

  const addTarget = (v: string, c: string, id: string) => {
    let m = targetIds.get(v)
    if (!m) { m = new Map(); targetIds.set(v, m) }
    let s = m.get(c)
    if (!s) { s = new Set(); m.set(c, s) }
    s.add(id)
  }

  const mergeClosure = (v: string, cl: Map<string, Set<string>>) => {
    let dest = perVaultClosure.get(v)
    if (!dest) { dest = new Map(); perVaultClosure.set(v, dest) }
    for (const [c, ids] of cl) {
      let s = dest.get(c)
      if (!s) { s = new Set(); dest.set(c, s) }
      for (const id of ids) s.add(id)
    }
  }

  // round 0: primary vault
  perVaultSeeds.set(opts.seed.vault, opts.seed.seeds)
  const queue: string[] = [opts.seed.vault]
  const walkedSignature = new Set<string>()

  let round = 0
  while (queue.length > 0) {
    if (round++ > maxDepth) break
    const batch = queue.splice(0, queue.length)
    for (const vaultName of batch) {
      const seeds = perVaultSeeds.get(vaultName)!
      const v = await openVault(vaultName)
      const { closure } = await walkClosure(v, {
        seeds,
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      })
      mergeClosure(vaultName, closure)
      // harvest cross-vault FKs from this vault's closure
      for (const ref of refs) {
        const ids = closure.get(ref.from.collection)
        if (!ids) continue
        const coll = v.collection<Record<string, unknown>>(ref.from.collection)
        for (const id of ids) {
          const rec = await coll.get(id)
          for (const fk of asIdArray(rec?.[ref.from.field])) {
            addTarget(ref.to.vault, ref.to.collection, fk)
          }
        }
      }
    }
    // enqueue targets whose id-set introduces records not yet in their closure
    for (const [tVault, colls] of targetIds) {
      for (const [tColl, ids] of colls) {
        const field = refs.find((r) => r.to.vault === tVault && r.to.collection === tColl)?.to.field ?? 'id'
        const have = perVaultClosure.get(tVault)?.get(tColl) ?? new Set<string>()
        const sig = `${tVault}\0${tColl}\0${[...ids].sort().join(',')}`
        if ([...ids].every((id) => have.has(id)) || walkedSignature.has(sig)) continue
        // Stamp before enqueue; safe because harvest is sequential — no other FK
        // accumulation can extend targetIds between this stamp and the next round.
        walkedSignature.add(sig)
        const wanted = new Set(ids)
        const seed = { [tColl]: (rec: Record<string, unknown>) => wanted.has(String(rec[field])) }
        const existing = perVaultSeeds.get(tVault)
        // `wanted` is always the full cumulative targetIds set for this collection,
        // so overwriting an existing predicate for tColl is safe and idempotent.
        perVaultSeeds.set(tVault, existing ? { ...existing, ...seed } : seed)
        queue.push(tVault)
      }
    }
  }

  // dangling check: every harvested target id must appear in the final closure
  const dangling: CrossVaultClosurePlan['dangling'] = []
  for (const [tVault, colls] of targetIds) {
    for (const [tColl, ids] of colls) {
      const have = perVaultClosure.get(tVault)?.get(tColl) ?? new Set<string>()
      for (const id of ids) {
        if (!have.has(id)) dangling.push({ vault: tVault, collection: tColl, id })
      }
    }
  }

  return { perVaultSeeds, perVaultClosure, dangling }
}

// ─── Task 2: extractCrossVaultPartition ────────────────────────────────────────

export class CrossVaultDanglingRefError extends Error {
  constructor(readonly dangling: { vault: string; collection: string; id: string }[]) {
    super(
      `cross-vault extraction: ${dangling.length} referenced row(s) missing from their target closure: `
      + dangling.slice(0, 5).map((d) => `${d.vault}/${d.collection}/${d.id}`).join(', '),
    )
    this.name = 'CrossVaultDanglingRefError'
  }
}

export interface CompartmentMeta {
  readonly roleTag?: string
  readonly disclose?: {
    readonly name?: boolean | string
    readonly collections?: boolean
  }
}

export interface ExtractCrossVaultOptions {
  readonly seed: CrossVaultSeed
  readonly crossVaultRefs?: readonly CrossVaultRef[]
  readonly maxDepth?: number
  readonly carrySchemas?: boolean
  readonly carryLedger?: boolean
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
  readonly compartmentMeta?: Record<string, CompartmentMeta>
}

export interface ExtractCrossVaultResult {
  readonly bundle: Uint8Array
  /**
   * Per-compartment raw 32-byte transfer keys, keyed by vault name. Each
   * unseals that compartment's DEKs on adoption.
   * @remarks SECRET — deliver these out-of-band, SEPARATELY from `bundle`.
   * Anyone with both the bundle and a compartment's key can decrypt that
   * compartment. Never store them alongside the bundle.
   */
  readonly transferKeys: Record<string, Uint8Array>
  readonly sealIds: Record<string, string>
}

export async function extractCrossVaultPartition(
  openVault: (name: string) => Promise<Vault>,
  opts: ExtractCrossVaultOptions,
): Promise<ExtractCrossVaultResult> {
  const plan = await walkCrossVaultClosure(openVault, opts)
  if (plan.dangling.length > 0) throw new CrossVaultDanglingRefError(plan.dangling)

  const inner: Uint8Array[] = []
  const compartments: CompartmentManifest[] = []
  const transferKeys: Record<string, Uint8Array> = {}
  const sealIds: Record<string, string> = {}

  for (const [vaultName, seeds] of plan.perVaultSeeds) {
    const v = await openVault(vaultName)
    const { bundleBytes, transferKey, sealId } = await extractPartition(v, {
      seeds,
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      carrySchemas: opts.carrySchemas ?? true,
      carryLedger: opts.carryLedger ?? false,
      ...(opts.compression !== undefined ? { compression: opts.compression } : {}),
    })

    const header = readNoydbBundleHeader(bundleBytes)
    const meta = opts.compartmentMeta?.[vaultName]

    const entry: { -readonly [K in keyof CompartmentManifest]: CompartmentManifest[K] } = {
      handle: header.handle,
      exportedAt: new Date().toISOString(),
      innerBytes: bundleBytes.length,
      innerSha256: await sha256Hex(bundleBytes),
    }

    if (meta?.roleTag !== undefined) entry.roleTag = meta.roleTag
    if (meta?.disclose?.name !== undefined && meta.disclose.name !== false) {
      entry.name = meta.disclose.name === true ? v.name : meta.disclose.name
    }
    if (meta?.disclose?.collections === true) {
      const cl = plan.perVaultClosure.get(vaultName)
      // `ids.size` reflects the EXTRACTED CLOSURE SLICE for this vault (the subset
      // selected by the cross-vault FK walk), NOT the full vault record count.
      // This differs from FR-1's writeMultiVaultBundle which counts the full vault.
      if (cl) entry.collections = [...cl].map(([name, ids]) => ({ name, count: ids.size }))
    }

    // FR-8: stamp the source vault's schema fence version so the bundle self-describes its version.
    const fence = await v.schemaFenceState()
    entry.schemaVersion = fence.currentSchemaVersion

    inner.push(bundleBytes)
    compartments.push(entry)
    transferKeys[vaultName] = transferKey
    sealIds[vaultName] = sealId
  }

  const manifest: MultiBundleManifest = {
    multiFormatVersion: NOYDB_MULTI_BUNDLE_VERSION,
    handle: generateULID(),
    compartments,
  }
  return { bundle: encodeMultiBundle(manifest, inner), transferKeys, sealIds }
}

// ─── Task 3: describeCrossVaultExtraction ────────────────────────────────────

export interface CrossVaultPreview {
  readonly compartments: ReadonlyArray<{ readonly vault: string; readonly preview: ExtractionPreview }>
  readonly dangling: ReadonlyArray<{ readonly vault: string; readonly collection: string; readonly id: string }>
}

/**
 * Dry-run that walks the cross-vault FK closure and aggregates hub's per-vault
 * `describeExtraction` into a per-compartment preview.
 *
 * Writes nothing. Returns the per-vault `ExtractionPreview` (record counts,
 * byte totals) and the dangling list from the closure walk.
 */
export async function describeCrossVaultExtraction(
  openVault: (name: string) => Promise<Vault>,
  opts: { seed: CrossVaultSeed; crossVaultRefs?: readonly CrossVaultRef[]; maxDepth?: number },
): Promise<CrossVaultPreview> {
  const plan = await walkCrossVaultClosure(openVault, opts)
  const compartments: Array<{ vault: string; preview: ExtractionPreview }> = []
  for (const [vaultName, seeds] of plan.perVaultSeeds) {
    const v = await openVault(vaultName)
    const preview = await describeExtraction(v, {
      seeds,
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    })
    compartments.push({ vault: vaultName, preview })
  }
  return { compartments, dangling: plan.dangling }
}
