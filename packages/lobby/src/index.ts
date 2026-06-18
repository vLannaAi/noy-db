/**
 * @klum-db/lobby — the Lobby orchestrates a group of sovereign noy-db vaults.
 * @packageDocumentation
 */
import type { Noydb } from '@noy-db/hub'
import { ValidationError, ReservedVaultNameError, VaultTemplateNotFoundError } from '@noy-db/hub/kernel'
import { STATE_VAULT_NAME } from '@noy-db/hub'
import type { VaultGroup } from './federation/vault-group.js'
import type { StateManagementVault } from './federation/state-vault.js'
import type { VaultTemplate, VaultGroupOptions } from './federation/types.js'
import type { AsXlsxSheetOptions } from '@noy-db/as-xlsx'
import type { CrossVaultRef } from './interchange/extract-cross-vault.js'

/**
 * Options for {@link Lobby.exportMultiVaultXlsx} (FR-9).
 *
 * Walks the cross-vault FK closure (FR-2) starting from `primary.vault` using
 * the supplied `primary.seeds` predicates, then delegates to
 * `@noy-db/as-xlsx`'s `toBytesMultiVault` for edge-pure rendering.
 *
 * **Primary-vault row scope:** `walkCrossVaultClosure` populates
 * `perVaultClosure` for the primary vault (the seed predicate rows are
 * collected there). This orchestrator passes that closure to the primary
 * vault entry, so the export contains exactly the seeded rows — not more,
 * not less. Supporting vaults receive their closure slice (FK-referenced ids
 * only, never the full collection).
 */
export interface ExportMultiVaultXlsxOptions {
  /** Primary vault: name + seed predicates per collection. */
  readonly primary: {
    readonly vault: string
    readonly seeds: Record<string, (rec: Record<string, unknown>) => boolean | Promise<boolean>>
  }
  /** Cross-vault FK edges that drive the closure walk. */
  readonly crossVaultRefs?: readonly CrossVaultRef[]
  /**
   * Per-vault sheet specs. Keys must be vault names (including `primary.vault`).
   * Sheet options may include `denormalize` for FK-join columns.
   */
  readonly sheets: Readonly<Record<string, readonly AsXlsxSheetOptions[]>>
  /** Optional maxDepth for walkCrossVaultClosure. */
  readonly maxDepth?: number
  /** Optional sheet-name separator forwarded to toBytesMultiVault. */
  readonly sheetSeparator?: string
}

// ─── FR-7 Surface type imports (used in Lobby method signatures) ──────────────
import type { SurfaceRow } from './federation/types.js'
import type { MergeReport } from './interchange/merge-compartment.js'

export class Lobby {
  readonly noydb: Noydb
  private readonly vaultTemplates = new Map<string, VaultTemplate>()

  constructor(noydb: Noydb) {
    this.noydb = noydb
  }

  withVaultTemplate(name: string, template: VaultTemplate): void {
    this.vaultTemplates.set(name, template)
  }

  async openVaultGroup<T>(name: string, opts: VaultGroupOptions<T>): Promise<VaultGroup<T>> {
    const db = this.noydb
    if (db.isClosed) throw new ValidationError('Instance is closed')
    if (name === STATE_VAULT_NAME) throw new ReservedVaultNameError(name)
    const template = this.vaultTemplates.get(opts.sharding.vaultTemplate)
    if (!template) throw new VaultTemplateNotFoundError(opts.sharding.vaultTemplate)
    const { VaultGroup } = await import('./federation/vault-group.js')
    const { StateManagementVault } = await import('./federation/state-vault.js')
    const stateVault = opts.registry ? undefined : await StateManagementVault.open(db)
    const registry = opts.registry ?? stateVault!.registry
    const group = new VaultGroup<T>(db, name, registry, opts.sharding, template, opts.migrateOnOpen ?? false)
    if (stateVault) {
      group._attachStateVault(stateVault)
      await stateVault.recordManifest(opts.sharding.vaultTemplate, template)
      try {
        await stateVault.appendEvent({ type: 'manifest-recorded', group: name, templateName: opts.sharding.vaultTemplate, version: template.version })
        await stateVault.appendEvent({ type: 'group-opened', group: name })
      } catch { /* best-effort */ }
    }
    return group
  }

  async openStateManagementVault(): Promise<StateManagementVault> {
    const db = this.noydb
    if (db.isClosed) throw new ValidationError('Instance is closed')
    const { StateManagementVault } = await import('./federation/state-vault.js')
    return StateManagementVault.open(db)
  }

  // ─── FR-7 Surface API ─────────────────────────────────────────────────────

  /**
   * Export a scoped partition from `vaultName` bounded to the given surface.
   * Delegates to `exportSurface` in `interchange/surface.ts`.
   * The vault is opened via `this.noydb.openVault(vaultName)`.
   */
  async exportSurface(
    vaultName: string,
    surface: SurfaceRow,
  ): Promise<{ bundleBytes: Uint8Array; transferKey: Uint8Array }> {
    const { exportSurface: exportSurfaceFn } = await import('./interchange/surface.js')
    const vault = await this.noydb.openVault(vaultName)
    return exportSurfaceFn(vault, surface)
  }

  /**
   * Apply an exported surface bundle into `vaultName`.
   * Delegates to `applySurface` in `interchange/surface.ts`.
   * The vault is opened via `this.noydb.openVault(vaultName)`.
   */
  async applySurface(
    vaultName: string,
    surface: SurfaceRow,
    bundleBytes: Uint8Array,
    transferKey: Uint8Array,
  ): Promise<MergeReport> {
    const { applySurface: applySurfaceFn } = await import('./interchange/surface.js')
    const vault = await this.noydb.openVault(vaultName)
    return applySurfaceFn(vault, surface, bundleBytes, transferKey)
  }

  /**
   * One-call multi-vault Excel export (FR-9).
   *
   * 1. Calls `walkCrossVaultClosure` (FR-2) to build the FK closure across all
   *    referenced vaults, starting from `opts.primary.vault` using the supplied
   *    seed predicates.
   * 2. For each vault in `opts.sheets`, opens the vault and attaches the
   *    per-vault closure slice from the plan:
   *    - **Primary vault**: gets its `perVaultClosure` slice (the seeded rows).
   *    - **Supporting vaults**: get their closure slice (FK-referenced ids only).
   * 3. Delegates to `@noy-db/as-xlsx`'s `toBytesMultiVault` for edge-pure
   *    rendering (no cross-vault walk in the adapter).
   *
   * Every vault in `opts.sheets` must independently hold
   * `assertCanExport('plaintext','xlsx')`.
   */
  async exportMultiVaultXlsx(opts: ExportMultiVaultXlsxOptions): Promise<Uint8Array> {
    const { walkCrossVaultClosure } = await import('./interchange/extract-cross-vault.js')
    const { toBytesMultiVault } = await import('@noy-db/as-xlsx')

    const openVault = (name: string) => this.noydb.openVault(name)

    const plan = await walkCrossVaultClosure(openVault, {
      seed: { vault: opts.primary.vault, seeds: opts.primary.seeds },
      ...(opts.crossVaultRefs !== undefined ? { crossVaultRefs: opts.crossVaultRefs } : {}),
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    })

    const entries = await Promise.all(
      Object.entries(opts.sheets).map(async ([vaultName, sheets]) => {
        const vault = await openVault(vaultName)
        const closure = plan.perVaultClosure.get(vaultName)
        // Both primary and supporting vaults get their perVaultClosure slice:
        //   - primary: the seeded rows (walkCrossVaultClosure includes the seed vault)
        //   - supporting: the FK-referenced ids only
        // This ensures the export is bounded to exactly what the closure walk found.
        return {
          vault,
          sheets: sheets as AsXlsxSheetOptions[],
          label: vaultName,
          ...(closure ? { closure } : {}),
        }
      }),
    )

    return toBytesMultiVault(entries, {
      ...(opts.sheetSeparator !== undefined ? { sheetSeparator: opts.sheetSeparator } : {}),
    })
  }
}

export function createLobby(noydb: Noydb): Lobby {
  return new Lobby(noydb)
}

export type {
  VaultGroup, ShardedCollection, ShardedQuery, ShardedGroupedQuery,
  CrossVaultAggregation, CrossVaultGroupedAggregation, StateManagementVault,
  VaultTemplate, VaultRegistryRow, ShardingConfig, VaultGroupOptions,
  FanoutQueryOptions, FanoutResult, SkippedVault,
  CrossVaultLiveQuery, CrossVaultLiveAggregation, LiveQueryOptions,
  SchemaManifestRow, DeploymentEvent, CapturedBlueprint,
  CrossVaultDerivationSpec, CrossVaultDerivationContext, RefreshInsightsResult,
  MigrationStatusRow, FleetMigrationResult,
} from './federation/index.js'
export type { GroupedRow as CrossVaultGroupedRow } from './federation/index.js'

// Federation error classes as runtime values — so consumers catch them from
// @klum-db/lobby directly, not via @noy-db/hub's internal /kernel surface.
export {
  CrossShardJoinError,
  UnknownShardError,
  ShardProvisioningError,
  VaultTemplateNotFoundError,
  ReservedVaultNameError,
  DataResidencyError,
} from '@noy-db/hub/kernel'

// ─── FR-2: Cross-vault FK-closure extraction ──────────────────────────────────
export {
  walkCrossVaultClosure,
  extractCrossVaultPartition,
  describeCrossVaultExtraction,
  CrossVaultDanglingRefError,
} from './interchange/extract-cross-vault.js'
export type {
  CrossVaultRef,
  CrossVaultSeed,
  CrossVaultClosurePlan,
  CompartmentMeta,
  ExtractCrossVaultOptions,
  ExtractCrossVaultResult,
  CrossVaultPreview,
} from './interchange/extract-cross-vault.js'

// ─── FR-3: Merge-import / reconcile-into-existing vault ───────────────────────
export { mergeCompartment, mergeDecryptedRecords, FieldLevelDeferredError } from './interchange/merge-compartment.js'
export type {
  MergeStrategy,
  MergeCompartmentOptions,
  MergeConflict,
  MergeReport,
} from './interchange/merge-compartment.js'

// ─── FR-8: Migrate-then-merge — upgrade incoming bundle before reconcile ──────
export {
  migrateThenMerge,
  MinVersionError,
  MigrationTransformRequiredError,
} from './interchange/migrate-then-merge.js'
export type {
  MigrationStep,
  MigrateThenMergeOptions,
  MigrateThenMergeReport,
} from './interchange/migrate-then-merge.js'

// ─── FR-4: Field-authority conflict resolver ──────────────────────────────────
export {
  resolveFieldAuthority,
  resolveRecordByFieldAuthority,
  FieldAuthorityPolicyMissingError,
} from './interchange/field-authority.js'
export type {
  FieldAuthorityRule,
  FieldAuthorityPolicy,
  FieldAuthorityInputs,
} from './interchange/field-authority.js'

// ─── FR-6: Sovereign custody (Deed / Custodian / Liberate) ────────────────────
// Pure re-exports — custody is a vault-level concern in @noy-db/hub; the Lobby
// surfaces the types/functions so fleet-level orchestration can reach them
// without importing hub internals directly (no lobby logic in this slice).
export { CustodyApi, liberateVault, createDeedOwner, loadDeedMarker, isDeedVault } from '@noy-db/hub'
export type { DeedMarker, LiberateOptions, LiberateResult, GrantCustodianOptions } from '@noy-db/hub'

// ─── FR-9: Multi-vault FK-driven Excel export ─────────────────────────────────
// ExportMultiVaultXlsxOptions is declared (and exported) above alongside Lobby.
// Re-export the as-xlsx multi-vault types so consumers don't need to import
// @noy-db/as-xlsx directly.
export type {
  MultiVaultXlsxEntry,
  MultiVaultXlsxOptions,
  MultiVaultDenormColumn,
} from '@noy-db/as-xlsx'

// ─── FR-7: Surface / Scoped Sync ─────────────────────────────────────────────
export {
  proposeSurface,
  agreeSurface,
  exportSurface,
  applySurface,
  isSurfaceDue,
  listDueSurfaces,
  markSynced,
  SurfaceNotFoundError,
  SurfaceStateError,
  SurfaceCadenceScheduler,
} from './interchange/surface.js'
export type {
  SurfaceDefinition,
} from './interchange/surface.js'
export type {
  SurfaceRow,
  SurfaceDirection,
  SurfaceStatus,
  SurfaceConflictPolicy,
} from './federation/types.js'
