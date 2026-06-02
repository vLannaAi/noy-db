import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectorNoydb } from './types.js'
import { listVaults, snapshot } from './snapshot.js'
import { records } from './records.js'
import { subscribe, subscribeConflicts, pendingWrites } from './events.js'

export function createInspector(noydb: InspectorNoydb): Inspector {
  return {
    listVaults: () => listVaults(noydb),
    snapshot: (vault: Vault) => snapshot(vault),
    records: (vault, collection, opts) => records(vault, collection, opts),
    subscribe: (handler) => subscribe(noydb, handler),
    subscribeConflicts: (handler) => subscribeConflicts(noydb, handler),
    pendingWrites: () => pendingWrites(noydb),
  }
}

export type {
  Inspector,
  VaultInfo,
  InspectorSnapshot,
  InspectorCollection,
  RecordPage,
  InspectorWriteEvent,
  InspectorWriteConflict,
  PendingWrites,
} from './types.js'
