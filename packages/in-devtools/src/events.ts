import type { InspectorWriteEvent, PendingWrites, InspectorNoydb } from './types.js'

export function subscribe(
  noydb: InspectorNoydb,
  handler: (event: InspectorWriteEvent) => void,
): () => void {
  return noydb.onAfterWrite(handler)
}

export function pendingWrites(noydb: InspectorNoydb): PendingWrites {
  const q = noydb.writeQueue
  return { pending: q.pending, depth: q.depth }
}
