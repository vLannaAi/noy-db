# Issue #136 — feat(yjs): @noy-db/yjs — Yjs Y.Doc interop for rich-text fields

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature

---

## Summary

New package `@noy-db/yjs` that wraps a Yjs `Y.Doc` inside a NOYDB record. Enables collaborative rich-text editing on `i18nText` or plain `Record<string, string>` fields while the envelope stays encrypted at rest.

## Design

```ts
import { yText } from '@noy-db/yjs'

const notes = company.collection<Note>('notes', {
  crdt: 'yjs',
  yFields: {
    body: yText(),   // Y.Text — rich text, TipTap/ProseMirror compatible
  },
})

// Get the Y.Doc for a record
const ydoc = await notes.getYDoc('note-1')
ydoc.getText('body').insert(0, 'Hello world')

// Put persists the encoded Yjs state as the encrypted envelope payload
await notes.putYDoc('note-1', ydoc)
```

## Constraints

- The encrypted envelope wraps the binary Yjs state (`Y.encodeStateAsUpdate`), not the resolved text snapshot
- `collection.get(id)` returns the resolved snapshot; `getYDoc(id)` returns the full Y.Doc
- Awareness / cursor state uses the presence channel (separate issue)
- Peer dep: `yjs >= 13`

## Related

- CRDT mode issue (prerequisite — `crdt: 'yjs'` option)
- Presence issue (cursors in Yjs use the presence channel)
