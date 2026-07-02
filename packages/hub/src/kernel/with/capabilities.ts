/**
 * Export/import capability gating, lifted off the `Vault` god-object (Phase 5
 * A7 of the microkernel refactoring).
 *
 * Pure predicates over a keyring's `exportCapability` / `importCapability`: the
 * `assert*` variants throw {@link ExportCapabilityError} / {@link ImportCapabilityError}
 * when the invoking keyring is not authorised; the `can*` variants return a
 * boolean for UI affordances. They wrap the role-default resolution in
 * {@link hasExportCapability} / {@link hasImportCapability}. Behaviour is
 * byte-identical to the inline `Vault` methods they replaced — every dependency
 * is the unlocked keyring, passed in. `Vault` keeps the typed (overloaded)
 * public methods and delegates here.
 *
 * Internal — reached through `vault.assertCanExport(...)` etc.
 */
import { ExportCapabilityError, ImportCapabilityError } from '../errors.js'
import { hasExportCapability, hasImportCapability } from '../../with-party/team/keyring.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { ExportFormat } from '../types.js'

/**
 * Authorize an `@noy-db/as-*` export against the keyring's `exportCapability`.
 * Throws `ExportCapabilityError` if the keyring is not authorised.
 *
 * - plaintext tier requires a `format`; defaults to empty for every role.
 * - bundle tier defaults to on for owner/admin, off for others.
 */
export function assertCanExport(keyring: UnlockedKeyring, tier: 'plaintext' | 'bundle', format?: ExportFormat): void {
  if (tier === 'plaintext') {
    if (format === undefined) {
      throw new Error('vault.assertCanExport: plaintext tier requires a format')
    }
    if (!hasExportCapability(keyring, 'plaintext', format)) {
      throw new ExportCapabilityError({
        tier: 'plaintext',
        userId: keyring.userId,
        format,
      })
    }
    return
  }
  if (!hasExportCapability(keyring, 'bundle')) {
    throw new ExportCapabilityError({
      tier: 'bundle',
      userId: keyring.userId,
    })
  }
}

/**
 * Authorize an `@noy-db/as-*` import against the keyring's `importCapability`.
 * Throws `ImportCapabilityError` if the keyring is not authorised.
 *
 * - plaintext tier requires a `format`; default-closed for every role.
 * - bundle tier is default-closed for every role, including owner — import is
 *   more dangerous than export (corrupts vs leaks).
 */
export function assertCanImport(keyring: UnlockedKeyring, tier: 'plaintext' | 'bundle', format?: ExportFormat): void {
  if (tier === 'plaintext') {
    if (format === undefined) {
      throw new Error('vault.assertCanImport: plaintext tier requires a format')
    }
    if (!hasImportCapability(keyring, 'plaintext', format)) {
      throw new ImportCapabilityError({
        tier: 'plaintext',
        userId: keyring.userId,
        format,
      })
    }
    return
  }
  if (!hasImportCapability(keyring, 'bundle')) {
    throw new ImportCapabilityError({
      tier: 'bundle',
      userId: keyring.userId,
    })
  }
}

/**
 * Read-only accessor for the keyring's export capability, with role-based
 * defaults resolved. Useful for UI affordances (grey out the export button if
 * no capability) without throwing.
 */
export function canExport(keyring: UnlockedKeyring, tier: 'plaintext' | 'bundle', format?: ExportFormat): boolean {
  if (tier === 'plaintext') {
    if (format === undefined) return false
    return hasExportCapability(keyring, 'plaintext', format)
  }
  return hasExportCapability(keyring, 'bundle')
}

/**
 * Read-only accessor for the keyring's import capability. UI affordance —
 * returns false in every default-closed case (every role with no explicit
 * `importCapability` grant).
 */
export function canImport(keyring: UnlockedKeyring, tier: 'plaintext' | 'bundle', format?: ExportFormat): boolean {
  if (tier === 'plaintext') {
    if (format === undefined) return false
    return hasImportCapability(keyring, 'plaintext', format)
  }
  return hasImportCapability(keyring, 'bundle')
}
