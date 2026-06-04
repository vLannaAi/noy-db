import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectorNoydb, InspectorMeter } from './types.js'
import { listVaults, snapshot } from './snapshot.js'
import { records } from './records.js'
import { subscribe, subscribeConflicts, pendingWrites } from './events.js'
import { meterSnapshot } from './meter.js'

export function createInspector(noydb: InspectorNoydb, opts?: { meter?: InspectorMeter }): Inspector {
  return {
    listVaults: () => listVaults(noydb),
    snapshot: (vault: Vault) => snapshot(vault),
    records: (vault, collection, opts) => records(vault, collection, opts),
    subscribe: (handler) => subscribe(noydb, handler),
    subscribeConflicts: (handler) => subscribeConflicts(noydb, handler),
    pendingWrites: () => pendingWrites(noydb),
    meterSnapshot: () => meterSnapshot(opts?.meter),
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
  InspectorMeter,
} from './types.js'
