/**
 * #199 P1 — `exportMyAccessibleData`: a non-owner user exports the scope they
 * can decrypt as a portable, re-keyed `.noydb` bundle. Non-destructive and
 * **always allowed** (the "data sovereignty by construction" property of
 * sealing-at-dimension §11.11 — the firm cannot deny it) but **audited**.
 *
 * Reuses the existing bundle machinery: the access boundary is the caller's DEK
 * set (operator/client → `keyring.permissions`; owner/admin/viewer → all), so a
 * record outside the caller's keys can never enter the bundle. Re-keying to a
 * new owner reuses `writeNoydbBundle`'s `exportPassphrase` shorthand.
 */
import type { Vault } from '../vault.js'
import { writeNoydbBundle } from './bundle.js'

export interface ExportAccessibleOptions {
  /**
   * Re-key the bundle so it is independently openable by a new owner with this
   * passphrase (the receiving firm / the client themselves). Omit to inherit
   * the source keyring (personal backup).
   */
  readonly reKey?: { readonly passphrase: string }
  /** Narrow the export to a subset of the caller's accessible collections. */
  readonly scope?: { readonly collections?: readonly string[] }
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
}

/**
 * Produce a re-keyed, access-scoped `.noydb` bundle of the caller's accessible
 * data. Appends a tamper-evident audit entry (`reason: 'user-export:<userId>'`).
 */
export async function exportAccessibleData(
  vault: Vault,
  opts: ExportAccessibleOptions = {},
): Promise<Uint8Array> {
  const { keyring } = vault._introspectState()

  // Access boundary: operator/client are scoped to their granted collections;
  // owner/admin/viewer see everything (allowlist left undefined). A sub-scope
  // intersects the granted set.
  let collections: string[] | undefined
  if (keyring.role === 'operator' || keyring.role === 'client') {
    collections = Object.keys(keyring.permissions)
  }
  if (opts.scope?.collections) {
    const allow = new Set(opts.scope.collections)
    collections = (collections ?? [...opts.scope.collections]).filter((c) => allow.has(c))
  }

  const bytes = await writeNoydbBundle(vault, {
    compression: opts.compression ?? 'auto',
    ...(collections !== undefined ? { collections } : {}),
    ...(opts.reKey ? { exportPassphrase: opts.reKey.passphrase } : {}),
  })

  // §11.11 audit — non-destructive, always-allowed export. No-op when the vault
  // has no history/ledger strategy (avoids minting a phantom _ledger DEK).
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle',
    collection: '',
    id: '',
    version: 0,
    actor: keyring.userId,
    payloadHash: '',
    reason: `user-export:${keyring.userId}`,
  })

  return bytes
}
