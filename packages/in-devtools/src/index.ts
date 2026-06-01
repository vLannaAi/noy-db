import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectorNoydb } from './types.js'
import { listVaults, snapshot } from './snapshot.js'

export function createInspector(noydb: InspectorNoydb): Inspector {
  return {
    listVaults: () => listVaults(noydb),
    snapshot: (vault: Vault) => snapshot(vault),
    // records / subscribe / pendingWrites added in later tasks.
  } as Inspector
}

export type {
  Inspector,
  VaultInfo,
  InspectorSnapshot,
  InspectorCollection,
  RecordPage,
  InspectorWriteEvent,
  PendingWrites,
} from './types.js'
