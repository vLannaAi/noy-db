import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectableContainer, InspectorMeter } from './types.js'
import { listVaults, snapshot } from './snapshot.js'
import { records } from './records.js'
import { subscribe, subscribeConflicts, pendingWrites } from './events.js'
import { meterSnapshot } from './meter.js'

export function createInspector(container: InspectableContainer, opts?: { meter?: InspectorMeter }): Inspector {
  return {
    listVaults: () => listVaults(container),
    snapshot: (vault: Vault) => snapshot(vault),
    records: (vault, collection, opts) => records(vault, collection, opts),
    subscribe: (handler) => subscribe(container, handler),
    subscribeConflicts: (handler) => subscribeConflicts(container, handler),
    pendingWrites: () => pendingWrites(container),
    meterSnapshot: () => meterSnapshot(opts?.meter),
  }
}

export type {
  Inspector,
  InspectableContainer,
  VaultInfo,
  InspectorSnapshot,
  InspectorCollection,
  RecordPage,
  InspectorWriteEvent,
  InspectorWriteConflict,
  PendingWrites,
  InspectorMeter,
} from './types.js'
