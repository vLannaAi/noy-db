import { ref, getCurrentScope, onScopeDispose, type Ref } from 'vue'
import type { Noydb, FenceState } from '@noy-db/hub'
import { useNoydb } from './useNoydb.js'

export interface UseMigrationStateReturn {
  /** Live cutover fence state for the watched vault. */
  readonly fenceState: Ref<FenceState>
  /** Live schema generation counter for the watched vault. */
  readonly schemaVersion: Ref<number>
}

/**
 * Reactive schema-cutover state. Seeds from the current fence on
 * mount, then updates on every `schema:fence-changed` event for `vaultName`
 * (or any vault when omitted). Pass `db` explicitly, or rely on the injected
 * instance (`NoydbPlugin`).
 */
export function useMigrationState(vaultName?: string): UseMigrationStateReturn
export function useMigrationState(db: Noydb, vaultName?: string): UseMigrationStateReturn
export function useMigrationState(
  dbOrVault?: Noydb | string,
  maybeVault?: string,
): UseMigrationStateReturn {
  const db: Noydb = typeof dbOrVault === 'object' ? dbOrVault : useNoydb()
  const vaultName: string | undefined = typeof dbOrVault === 'string' ? dbOrVault : maybeVault

  const fenceState = ref<FenceState>('normal')
  const schemaVersion = ref(0)

  // Seed from the live fence (the event fires on change, not on mount).
  if (vaultName !== undefined) {
    try {
      void db.vault(vaultName).schemaFenceState().then(
        (s) => { fenceState.value = s.fenceState; schemaVersion.value = s.currentSchemaVersion },
        () => { /* no fence yet → keep defaults */ },
      )
    } catch {
      /* db.vault() throws if the vault isn't open yet → keep defaults; events catch up */
    }
  }

  const handler = (e: { vault: string; currentSchemaVersion: number; fenceState: FenceState }) => {
    if (vaultName !== undefined && e.vault !== vaultName) return
    fenceState.value = e.fenceState
    schemaVersion.value = e.currentSchemaVersion
  }
  db.on('schema:fence-changed', handler)

  if (getCurrentScope()) {
    onScopeDispose(() => { db.off('schema:fence-changed', handler) })
  }

  return { fenceState, schemaVersion }
}
