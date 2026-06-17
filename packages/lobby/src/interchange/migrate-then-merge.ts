/**
 * @klum-db/lobby interchange — migrate-then-merge (FR-8). Upgrade an incoming
 * compartment to the receiver's schema version IN STAGING, then merge.
 *
 * Pipeline:
 *   1. Resolve fromVersion / toVersion.
 *   2. Refuse if incoming bundle is newer than receiver (MinVersionError).
 *   3. Decrypt the compartment bytes.
 *   4. STAGING: apply per-collection migration transforms in-memory; then
 *      pre-validate EVERY staged record via `receiver.collection(coll).validateInput()`
 *      BEFORE any write. A throwing transform or validation failure leaves the
 *      receiver completely untouched (staging-safety guarantee).
 *   5. Delegate to `mergeDecryptedRecords` with the now schema-homogeneous
 *      staged records — the merge engine never branches on schema version.
 *
 * @module
 */
import type { Vault } from '@noy-db/hub'
import { decryptExtractedPartition, type DecryptedRecord } from '@noy-db/hub/bundle'
import {
  mergeDecryptedRecords,
  type MergeCompartmentOptions,
  type MergeReport,
} from './merge-compartment.js'

// ─── Public types ─────────────────────────────────────────────────────────────

/** One upgrade step: transform a record body up to `toVersion`. */
export interface MigrationStep {
  /** The target version this step brings records up to. */
  readonly toVersion: number
  /** Pure transform: takes the old record body, returns the new record body. */
  readonly transform: (record: Record<string, unknown>) => Record<string, unknown>
}

export interface MigrateThenMergeOptions extends MergeCompartmentOptions {
  /**
   * Incoming bundle's schema version.
   * Read from `CompartmentManifest.schemaVersion` (stamped by FR-2 extract, Task 2).
   * When omitted, `assumeFromVersion` is used as a fallback.
   */
  readonly fromVersion?: number
  /**
   * Fallback version for bundles whose manifest carries no `schemaVersion` (older bundles).
   * Ignored when `fromVersion` is present.
   */
  readonly assumeFromVersion?: number
  /**
   * Target schema version to migrate to.
   * Defaults to `receiver.schemaFenceState().currentSchemaVersion`.
   */
  readonly toVersion?: number
  /**
   * Per-collection ordered upgrade steps, keyed by collection name.
   * Steps are applied in ascending `toVersion` order, filtered to the
   * `(fromVersion, toVersion]` window.
   */
  readonly migrations?: Record<string, readonly MigrationStep[]>
}

export interface MigrateThenMergeReport extends MergeReport {
  readonly migration: {
    readonly fromVersion: number
    readonly toVersion: number
    /** Per-collection account of how records reached the target version. */
    readonly byCollection: Record<string, 'transformed' | 'additive-no-transform' | 'same-version'>
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when the incoming bundle's schema version is greater than the
 * receiver's `currentSchemaVersion`. The receiver must be upgraded first —
 * a newer bundle cannot be down-migrated.
 */
export class MinVersionError extends Error {
  constructor(
    public readonly fromVersion: number,
    public readonly toVersion: number,
  ) {
    super(
      `migrateThenMerge: incoming bundle is at schema version ${fromVersion} but the receiver ` +
        `is at ${toVersion}. Upgrade the receiver to at least v${fromVersion} before merging ` +
        `(a newer bundle cannot be down-migrated).`,
    )
    this.name = 'MinVersionError'
  }
}

/**
 * Thrown BEFORE any write when a collection's incoming records do not validate
 * against the receiver schema and no migration transform was supplied to fix
 * the shape. Provides an actionable error message identifying the collection.
 */
export class MigrationTransformRequiredError extends Error {
  constructor(
    public readonly collection: string,
    public readonly cause?: unknown,
  ) {
    super(
      `migrateThenMerge: collection "${collection}" did not validate against the receiver schema ` +
        `after migration and no transform was supplied to reach the target version. Provide a ` +
        `migration step for "${collection}". Underlying: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'MigrationTransformRequiredError'
  }
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

/**
 * Two-stage upgrade-then-merge pipeline (FR-8).
 *
 * Migrates an incoming compartment from `fromVersion` to `toVersion` in
 * staging, validates every staged record against the receiver schema (using
 * `Collection.validateInput`), then delegates to `mergeDecryptedRecords`.
 *
 * **Staging-safety guarantee:** all transforms and validations run in-memory
 * before `mergeDecryptedRecords` writes anything. A throwing transform OR a
 * failing validation leaves the receiver completely untouched.
 *
 * **Additive fast-path:** collections with no supplied transform still pass
 * when the old shape validates against the receiver schema (additive-only
 * evolution). When no schema is declared on the receiver collection,
 * `validateInput` is a no-op — any shape passes.
 */
export async function migrateThenMerge(
  receiver: Vault,
  compartmentBytes: Uint8Array,
  opts: MigrateThenMergeOptions,
): Promise<MigrateThenMergeReport> {
  // 1. Resolve target version.
  const toVersion = opts.toVersion ?? (await receiver.schemaFenceState()).currentSchemaVersion

  // 2. Resolve source version.
  const fromVersion = opts.fromVersion ?? opts.assumeFromVersion
  if (fromVersion === undefined) {
    throw new Error(
      'migrateThenMerge: cannot determine the incoming schema version. ' +
        'Pass `fromVersion` (read from the bundle manifest CompartmentManifest.schemaVersion) ' +
        'or `assumeFromVersion` as a fallback for older bundles.',
    )
  }

  // 3. Refuse bundles that are NEWER than the receiver.
  if (fromVersion > toVersion) throw new MinVersionError(fromVersion, toVersion)

  // 4. Decrypt the compartment (records only).
  const incoming = await decryptExtractedPartition(compartmentBytes, opts.transferKey)

  // 5. STAGING: transform + pre-validate every record before any write.
  //    A throwing transform or a validation failure bubbles out here —
  //    `mergeDecryptedRecords` is never reached → receiver is untouched.
  const migrationByCollection: Record<string, 'transformed' | 'additive-no-transform' | 'same-version'> = {}
  const staged: Record<string, DecryptedRecord[]> = {}

  for (const [coll, recs] of Object.entries(incoming)) {
    // Select and order the applicable migration steps: (fromVersion, toVersion].
    const steps = (opts.migrations?.[coll] ?? [])
      .filter((s) => s.toVersion > fromVersion && s.toVersion <= toVersion)
      .slice()
      .sort((a, b) => a.toVersion - b.toVersion)

    // Apply transforms in-memory (throwing transform propagates immediately).
    const out: DecryptedRecord[] = []
    for (const r of recs) {
      let body = r.record
      for (const step of steps) body = step.transform(body)
      out.push({ ...r, record: body })
    }
    staged[coll] = out

    // Classify this collection's migration path.
    if (fromVersion === toVersion) {
      migrationByCollection[coll] = 'same-version'
    } else if (steps.length > 0) {
      migrationByCollection[coll] = 'transformed'
    } else {
      migrationByCollection[coll] = 'additive-no-transform'
    }

    // Pre-validate ALL staged records against the receiver schema.
    // `validateInput` is a no-op when the collection has no schema.
    // A failing record throws MigrationTransformRequiredError — no writes happen.
    const rc = receiver.collection(coll)
    for (const r of out) {
      try {
        await rc.validateInput(r.record as never)
      } catch (cause) {
        throw new MigrationTransformRequiredError(coll, cause)
      }
    }
  }

  // 6. Merge the now schema-homogeneous staged records — no version branching here.
  const report = await mergeDecryptedRecords(receiver, staged, opts)

  return {
    ...report,
    migration: {
      fromVersion,
      toVersion,
      byCollection: migrationByCollection,
    },
  }
}
