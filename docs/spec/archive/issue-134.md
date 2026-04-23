# Issue #134 — feat(core): presence and live cursors — encrypted ephemeral channel keyed by collection DEK

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature, area: core

---

## Summary

Real-time awareness of who else is viewing/editing a collection, without exposing identities to the adapter.

## Design

The presence channel is an **encrypted ephemeral channel** keyed by an HKDF derivation of the collection DEK + `presence` label. This means:
- The adapter never learns which users are in the room
- Presence payloads are encrypted under the same key
- Channel key rotates on DEK rotation (revoked users can't listen)

```ts
const presence = company.collection('invoices').presence()

// Announce yourself (sets your cursor/status)
presence.update({ userId: session.userId, path: 'invoices/inv-123', action: 'editing' })

// Subscribe to others
presence.subscribe((peers) => {
  // peers: Array<{ userId, path, action, lastSeen }>
  renderCursors(peers)
})

presence.stop()
```

## Adapter requirements

Adapters that support presence implement `subscribe(channel, onMessage)` and `publish(channel, payload)`. Falls back to polling for adapters without pub/sub.

## Related

- Requires active sync session
- Yjs interop issue (CRDT for shared editing) complements this
