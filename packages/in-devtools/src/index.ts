import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectorNoydb } from './types.js'
import { listVaults, snapshot } from './snapshot.js'
import { records } from './records.js'

export function createInspector(noydb: InspectorNoydb): Inspector {
  return {
    listVaults: () => listVaults(noydb),
    snapshot: (vault: Vault) => snapshot(vault),
    records: (vault, collection, opts) => records(vault, collection, opts),
    // subscribe / pendingWrites added in the next task.
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
