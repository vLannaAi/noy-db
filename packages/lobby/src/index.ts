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
