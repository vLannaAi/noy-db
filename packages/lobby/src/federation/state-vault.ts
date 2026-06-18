/**
 * @category capability
 * StateManagement Vault — federation control plane (registry +
 * schema-manifest + append-only deployment-events). See
 * docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md.
 */
import type { Noydb } from '@noy-db/hub/kernel'
import type { Collection } from '@noy-db/hub/kernel'
import type { Query } from '@noy-db/hub/kernel'
import type { VaultRegistryRow, SchemaManifestRow, DeploymentEvent, MigrationStatusRow, SurfaceRow, VaultTemplate } from './types.js'
import { captureBlueprint, fingerprintBlueprint } from './schema-manifest.js'
import { STATE_VAULT_NAME } from './constants.js'
import { generateULID } from '@noy-db/hub/kernel'

// Re-export so federation/index.ts can surface STATE_VAULT_NAME without reaching past state-vault.
export { STATE_VAULT_NAME } from './constants.js'

// Physical collection names — single-token (camelCase) to stay clear of any
// collection-name charset restrictions; the existing suite uses single-word names.
const REGISTRY = 'vaultRegistry'
const MANIFEST = 'schemaManifest'
const EVENTS = 'deploymentEvents'
const MIGRATION_STATUS = 'migrationStatus'
const SURFACES = 'surfaces'

export class StateManagementVault {
  /**
   * The append-only deployment-events log is kept truly private so the raw
   * mutable Collection is never surfaced — events may only be written via
   * `appendEvent` and read via `queryEvents`. (`registry` and
   * `schemaManifest` are deliberately public: consumers read and write them.)
   */
  readonly #events: Collection<DeploymentEvent>
  /** Per-shard fleet-migration progress (#271). Surfaced via typed methods only. */
  readonly #migrationStatus: Collection<MigrationStatusRow>
  /** Persisted Surface agreements (FR-7). Surfaced via typed methods only. */
  readonly #surfaces: Collection<SurfaceRow>

  private constructor(
    readonly registry: Collection<VaultRegistryRow>,
    readonly schemaManifest: Collection<SchemaManifestRow>,
    events: Collection<DeploymentEvent>,
    migrationStatus: Collection<MigrationStatusRow>,
    surfaces: Collection<SurfaceRow>,
  ) {
    this.#events = events
    this.#migrationStatus = migrationStatus
    this.#surfaces = surfaces
  }

  /** Idempotently open the reserved state vault and bind the control-plane collections. */
  static async open(db: Noydb): Promise<StateManagementVault> {
    const vault = await db.openVault(STATE_VAULT_NAME)
    return new StateManagementVault(
      vault.collection<VaultRegistryRow>(REGISTRY),
      vault.collection<SchemaManifestRow>(MANIFEST),
      vault.collection<DeploymentEvent>(EVENTS),
      vault.collection<MigrationStatusRow>(MIGRATION_STATUS),
      vault.collection<SurfaceRow>(SURFACES),
    )
  }

  /** Read one shard's migration status (or null). */
  async getMigrationStatus(vaultId: string): Promise<MigrationStatusRow | null> {
    return this.#migrationStatus.get(vaultId)
  }

  /** All migration-status rows (hydrates first). */
  async listMigrationStatus(): Promise<MigrationStatusRow[]> {
    await this.#migrationStatus.list()
    return this.#migrationStatus.query().toArray()
  }

  /** Upsert one shard's migration status (keyed by vaultId). */
  async upsertMigrationStatus(row: MigrationStatusRow): Promise<void> {
    await this.#migrationStatus.put(row.vaultId, row)
  }

  // ─── FR-7 Surface CRUD ────────────────────────────────────────────────────

  /** Persist a new Surface row (keyed by `row.id`). */
  async createSurface(row: SurfaceRow): Promise<void> {
    await this.#surfaces.put(row.id, row)
  }

  /** Read one Surface row by id, or null if absent. */
  async getSurface(id: string): Promise<SurfaceRow | null> {
    return this.#surfaces.get(id)
  }

  /** All persisted Surface rows (hydrates first). */
  async listSurfaces(): Promise<SurfaceRow[]> {
    await this.#surfaces.list()
    return this.#surfaces.query().toArray()
  }

  /**
   * Merge `patch` into the existing Surface row keyed by `id`, persist the
   * result, and return it. Mirrors the migrationStatus upsert pattern but
   * returns the merged row for convenience.
   */
  async updateSurface(id: string, patch: Partial<SurfaceRow>): Promise<SurfaceRow> {
    const existing = await this.#surfaces.get(id)
    if (!existing) throw new Error(`Surface not found: ${id}`)
    const updated: SurfaceRow = { ...existing, ...patch }
    await this.#surfaces.put(id, updated)
    return updated
  }

  /** Read-only query over the append-only deployment-events log. */
  queryEvents(): Query<DeploymentEvent> {
    return this.#events.query()
  }

  /**
   * Append a deployment event with a fresh unique (ULID) id. This is the
   * only write path to the events log; no update/delete is exposed.
   * Callers should treat failures as non-fatal — this method does not
   * swallow errors, so wrap the call site in try/catch where appropriate.
   */
  async appendEvent(event: Omit<DeploymentEvent, 'id' | 'ts'> & { ts?: number }): Promise<void> {
    const ts = event.ts ?? Date.now()
    const id = generateULID()
    await this.#events.put(id, { ...event, id, ts })
  }

  /**
   * Ensure a manifest row exists for `(templateName, template.version)`.
   * Safe to call repeatedly: the `fingerprint` is a deterministic hash of
   * the template's declared shape (stable across calls), though each call
   * refreshes `recordedAt`.
   */
  async recordManifest(templateName: string, template: VaultTemplate): Promise<string> {
    const bp = captureBlueprint(template.configure)
    const fingerprint = await fingerprintBlueprint(bp)
    await this.schemaManifest.put(`${templateName}:${template.version}`, {
      templateName,
      version: template.version,
      collections: bp.collections,
      indexes: bp.indexes,
      persistJsonSchema: bp.persistJsonSchema,
      fingerprint,
      recordedAt: Date.now(),
    })
    return fingerprint
  }

  /**
   * True when `template`'s current declared shape does not match the recorded
   * manifest for `(templateName, template.version)`. Because shards carry no
   * schema state independent of their template, this catches "a template's
   * shape changed without bumping `version`" — not independent per-shard drift.
   * A missing manifest is treated as drift (nothing to verify against).
   */
  async detectDrift(templateName: string, template: VaultTemplate): Promise<boolean> {
    const row = await this.schemaManifest.get(`${templateName}:${template.version}`)
    if (!row) return true
    const current = await fingerprintBlueprint(captureBlueprint(template.configure))
    return current !== row.fingerprint
  }
}
