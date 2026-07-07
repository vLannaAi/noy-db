/**
 * Satellite declaration wiring (#591, archetype-③) — the full body behind
 * `Vault.collection()`'s thin call-site: in-session reconcile (idempotent
 * identical redeclare / R-S9 divergent refusal), sync validation
 * (R-S3/R-S5/R-S8), the R-S7 forget-coverage gate, lazy registry + poison
 * write-gate creation, registration, and the fire-and-forget postRegister
 * (marker persistence + R-S1 cross-check). Kept dependency-narrow: no
 * `Vault` import — the kernel supplies a {@link SatelliteDeclareContext}.
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { SatelliteConfigError } from '../../kernel/errors.js'
import { SatelliteRegistry } from './registry.js'
import { validateSatelliteDeclaration, hashFields } from './validate.js'

/** The narrow slice of Vault that declaration wiring needs. */
export interface SatelliteDeclareContext {
  readonly adapter: NoydbStore
  readonly vaultName: string
  /** `forgetStrategy.subjects` — collection → subject field (R-S7 gate input). */
  readonly forgetSubjects: Record<string, string>
  readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  /** The base collection's attached Standard Schema validator, if constructed. */
  readonly getBaseSchema: (base: string) => unknown
  /** Registers the vault-wide poison write-gate; invoked at most once per vault. */
  readonly registerPoisonHook: (hook: (e: { readonly vault: string; readonly collection: string }) => void) => void
  /**
   * Iterates the vault's SyncEngine(s) (#591 Task 11) — used to wire the
   * live pair-expander (once per vault, alongside `registerPoisonHook`; the
   * closure captures the registry itself, not a snapshot, so pairs declared
   * later are still picked up by push/pull filters) and to retroactively
   * re-mirror conflict resolvers on every successful pair registration.
   * No-op when sync is not configured.
   */
  readonly forEachSyncEngine: (fn: (engine: PairSyncEngine) => void) => void
}

/** The narrow slice of SyncEngine that satellite declaration wiring drives (#591 Task 11). */
export interface PairSyncEngine {
  setPairExpander(expander: (names: readonly string[]) => readonly string[]): void
  remirrorPairResolvers(names: readonly string[]): void
}

export interface SatelliteDeclarationOptions {
  readonly satelliteOf: string
  readonly fields?: readonly string[] | undefined
  readonly joined?: string | undefined
  readonly perRecordKeys?: boolean | undefined
  readonly crdt?: unknown
}

/**
 * Register `collectionName` as a satellite per `options`. Returns the
 * (possibly newly created) registry — the caller stores it back on the vault.
 * A refused declaration throws {@link SatelliteConfigError} and leaves NO
 * side effect (no registry created, no hook registered).
 */
export function declareSatellite(
  ctx: SatelliteDeclareContext,
  collectionName: string,
  options: SatelliteDeclarationOptions,
  existingRegistry: SatelliteRegistry | null,
): SatelliteRegistry {
  if (existingRegistry !== null) {
    const existing = existingRegistry.bySatellite(collectionName)
    if (existing) { // in-session reconcile: identical redeclare is a no-op, divergent refuses (R-S9)
      const same = existing.base === options.satelliteOf
        && hashFields(existing.fields) === hashFields(options.fields ?? [])
        && (existing.joined ?? null) === (options.joined ?? null)
      if (!same) {
        throw new SatelliteConfigError(`R-S9: "${collectionName}" re-declared divergently within this session (base/fields/joined mismatch).`)
      }
      return existingRegistry
    }
  }
  // Validate FIRST — a refused declaration must leave no side effect (no registry, no hook).
  const spec = validateSatelliteDeclaration({
    satellite: collectionName, satelliteOf: options.satelliteOf, fields: options.fields, joined: options.joined,
    baseIsSatellite: (existingRegistry?.bySatellite(options.satelliteOf) ?? null) !== null,
    crdtMode: options.crdt !== undefined,
  })
  if (ctx.forgetSubjects[spec.base] !== undefined && options.perRecordKeys !== true) {
    throw new SatelliteConfigError(`R-S7: satellite "${collectionName}" of forget-covered base "${spec.base}" must declare perRecordKeys.`)
  }
  let reg = existingRegistry
  if (reg === null) {
    const created = new SatelliteRegistry()
    ctx.registerPoisonHook((e) => { // gate writes against the poison map (R-S1 cross-check)
      if (e.vault === ctx.vaultName) created.assertNotPoisoned(e.collection)
    })
    ctx.forEachSyncEngine(e => e.setPairExpander(names => created.expandNames(names))) // #591 Task 11: sync push/pull + conflict resolvers treat a pair as a unit
    reg = created
  }
  reg.register(spec)
  // #591 Task 11: retroactive resolver mirroring — a conflictPolicy resolver
  // registered on either member BEFORE this pair existed is copied to both now.
  ctx.forEachSyncEngine(e => e.remirrorPairResolvers([spec.base, spec.satellite]))
  const registry = reg // const alias — closure below must not capture the `let`
  const baseSchema = ctx.getBaseSchema(spec.base)
  void import('./post-register.js') // .catch: never-throw-async, independent of postRegister internals
    .then((m) => m.postRegister(ctx.adapter, ctx.vaultName, spec, ctx.getDEK, baseSchema, registry))
    .catch(() => {})
  return reg
}
