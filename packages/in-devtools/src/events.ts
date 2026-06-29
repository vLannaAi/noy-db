import type { InspectorWriteEvent, InspectorWriteConflict, PendingWrites, InspectableContainer } from './types.js'

export function subscribe(
  noydb: InspectableContainer,
  handler: (event: InspectorWriteEvent) => void,
): () => void {
  return noydb.onAfterWrite(handler)
}

export function pendingWrites(noydb: InspectableContainer): PendingWrites {
  const q = noydb.writeQueue
  return { pending: q.pending, depth: q.depth }
}

export function subscribeConflicts(noydb: InspectableContainer, handler: (c: InspectorWriteConflict) => void): () => void {
  return noydb.onWriteConflict(handler)
}
