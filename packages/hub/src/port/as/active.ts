/**
 * `withFormats()` — the service that consumes the `as-*` port.
 *
 * Everything with a correctness or security consequence lives here rather
 * than in each format: the capability gate, the vault read, and redaction.
 * A {@link NoydbFormat} receives records and returns bytes.
 *
 * That is the whole point of the inversion (ADR 0004). The conformance kit it
 * replaces could only check implementors who ran it; a format that cannot
 * reach a vault is gated whether its author cooperated or not.
 *
 * @module
 */
import type { NoydbFormat, ImportPlan } from './types.js'
import type {
  FormatsStrategy,
  FormatsContext,
  FormatExportOptions,
  FormatImportOptions,
} from '../with/formats-strategy.js'
import type { ExportChunk } from '../../kernel/types.js'
import type { Vault } from '../../kernel/vault.js'
import type { ImportPolicy } from './types.js'
import { applyListProjection } from '../../with-shape/introspection/index.js'
import type { CollectionDescription, ListProjectionOptions } from '../../with-shape/introspection/index.js'
import { ValidationError } from '../../kernel/errors.js'

/** Apply the redaction projection hub owns, so a format never asks for it. */
function redactChunk(
  chunk: ExportChunk,
  ctx: FormatsContext,
  redact: FormatExportOptions['redact'],
): ExportChunk {
  if (redact === undefined) return chunk
  const described = ctx.describe(chunk.collection) as CollectionDescription | undefined
  if (!described) {
    throw new Error(
      `vault.export: redaction was requested but '${chunk.collection}' has no description to redact against. ` +
        'Open the collection with its classifiedFields / fieldMeta options first.',
    )
  }
  const opts: ListProjectionOptions | undefined =
    redact === true ? undefined : { sensitivity: redact.sensitivity as never }
  const records = chunk.records.map((r) =>
    applyListProjection(described, r as Record<string, unknown>, opts),
  )
  return { ...chunk, records: records as typeof chunk.records }
}

/**
 * Derive the narrow, format-facing capability from the vault.
 *
 * Lives here rather than on `Vault` because `kernel-surface` said so, and it
 * was right: this is service capability, not spine. The spine keeps two
 * delegating methods and nothing else.
 */
function contextFor(vault: Vault): FormatsContext {
  return {
    assertCanExport: (tier, format) => {
      if (tier === 'bundle') vault.assertCanExport('bundle')
      else vault.assertCanExport('plaintext', format as never)
    },
    assertCanImport: (tier, format) => {
      if (tier === 'bundle') vault.assertCanImport('bundle')
      else vault.assertCanImport('plaintext', format as never)
    },
    chunks: (collections) =>
      vault.exportStream({ granularity: 'collection', ...(collections ? { collections } : {}) }),
    // NOT swallowed. A caller who asked for redaction and silently got
    // unredacted output is the exact failure this port exists to remove — a
    // security duty that fails quiet. If the description cannot be read, the
    // export fails instead.
    describe: (collection) => vault.collection(collection).describe() as never,
    plan: async (records, policy: ImportPolicy, formatId: string, idKey?: string) => {
      const { diffVault } = await import('../../with-cargo/vault-diff.js')
      const plan = await diffVault(vault, records as never, idKey ? { idKey } : {})
      return {
        plan,
        policy,
        // The apply walk every as-* package had independently: added always,
        // modified unless insert-only, deleted only on replace — in one
        // transaction so a partial failure rolls back. Owned once, here.
        apply: async () => {
          await vault.noydb.transaction((tx) => {
            const txVault = tx.vault(vault.name)
            const reason = `import:${formatId}`
            for (const e of plan.added) {
              txVault.collection(e.collection).put(e.id, e.record as never, { reason })
            }
            if (policy !== 'insert-only') {
              for (const e of plan.modified) {
                txVault.collection(e.collection).put(e.id, e.record as never, { reason })
              }
            }
            if (policy === 'replace') {
              for (const e of plan.deleted) txVault.collection(e.collection).delete(e.id)
            }
          })
        },
      }
    },
  }
}

/**
 * Enable `vault.export()` / `vault.import()`.
 *
 * ```ts
 * const db = await createNoydb({ store, user, secret, formatsStrategy: withFormats() })
 * const csv = await vault.export(asCsv(), { collections: ['invoices'] })
 * ```
 */
export function withFormats(): FormatsStrategy {
  return {
    enabled: true,

    async exportWith<Out extends string | Uint8Array>(
      vault: Vault,
      format: NoydbFormat<Out>,
      options: FormatExportOptions = {},
    ): Promise<Out> {
      const ctx = contextFor(vault)
      // FIRST, and before a single record is read. The format is not in scope
      // yet and could not reach the vault if it were.
      if (format.tier === 'bundle') ctx.assertCanExport('bundle')
      else ctx.assertCanExport('plaintext', format.id)

      const chunks: ExportChunk[] = []
      for await (const chunk of ctx.chunks(options.collections)) {
        chunks.push(redactChunk(chunk, ctx, options.redact))
      }
      return format.encode(chunks)
    },

    async importWith<Out extends string | Uint8Array>(
      vault: Vault,
      format: NoydbFormat<Out>,
      input: Out,
      options: FormatImportOptions = {},
    ): Promise<ImportPlan> {
      const ctx = contextFor(vault)
      // Mirrors the export side: the import gate is two-tier as well, and a
      // bundle format importing under the plaintext tier would be a silent
      // downgrade in the other direction.
      if (format.tier === 'bundle') ctx.assertCanImport('bundle')
      else ctx.assertCanImport('plaintext', format.id)
      if (!format.decode) {
        throw new ValidationError(
          `vault.import: the '${format.id}' format is export-only — it declares no decode(). ` +
            'Pick a format that round-trips, or write the records directly.',
        )
      }
      const decoded = await format.decode(input)
      const candidate: Record<string, readonly unknown[]> = {}
      for (const chunk of decoded) {
        const target = chunk.collection || options.collection
        if (!target) {
          throw new ValidationError(
            `vault.import: the '${format.id}' input names no collection and none was supplied. ` +
              'Pass { collection } for formats whose payload is collection-less.',
          )
        }
        candidate[target] = [...(candidate[target] ?? []), ...chunk.records]
      }
      return ctx.plan(candidate, options.policy ?? 'merge', format.id, options.idKey)
    },
  }
}
