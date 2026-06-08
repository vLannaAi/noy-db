/**
 * @category capability
 * StateManagement Vault — federation control plane (registry +
 * schema-manifest + append-only deployment-events). See
 * docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md.
 */
import type { Noydb } from '../noydb.js'
import type { Collection } from '../collection.js'
import type { Query } from '../query/builder.js'
import type { VaultRegistryRow, SchemaManifestRow, DeploymentEvent, VaultTemplate } from './types.js'
import { captureBlueprint, fingerprintBlueprint } from './schema-manifest.js'
import { STATE_VAULT_NAME } from './constants.js'
import { generateULID } from '../bundle/ulid.js'

// Re-export so consumers can `import { STATE_VAULT_NAME } from '@noy-db/hub'`.
export { STATE_VAULT_NAME } from './constants.js'

// Physical collection names — single-token (camelCase) to stay clear of any
// collection-name charset restrictions; the existing suite uses single-word names.
const REGISTRY = 'vaultRegistry'
const MANIFEST = 'schemaManifest'
const EVENTS = 'deploymentEvents'

export class StateManagementVault {
  /**
   * The append-only deployment-events log is kept truly private so the raw
   * mutable Collection is never surfaced — events may only be written via
   * `appendEvent` and read via `queryEvents`. (`registry` and
   * `schemaManifest` are deliberately public: consumers read and write them.)
   */
  readonly #events: Collection<DeploymentEvent>

  private constructor(
    readonly registry: Collection<VaultRegistryRow>,
    readonly schemaManifest: Collection<SchemaManifestRow>,
    events: Collection<DeploymentEvent>,
  ) {
    this.#events = events
  }

  /** Idempotently open the reserved state vault and bind the three control-plane collections. */
  static async open(db: Noydb): Promise<StateManagementVault> {
    const vault = await db.openVault(STATE_VAULT_NAME)
    return new StateManagementVault(
      vault.collection<VaultRegistryRow>(REGISTRY),
      vault.collection<SchemaManifestRow>(MANIFEST),
      vault.collection<DeploymentEvent>(EVENTS),
    )
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
