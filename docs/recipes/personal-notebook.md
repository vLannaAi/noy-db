# Recipe 1 — Personal encrypted notebook

> **Audience:** single user, single device, local-only. The simplest possible NOYDB consumer.
> **Bundle:** core only (~6,500 LOC). No history, no blobs, no sync, no joins, no aggregate.
> **Verified by:** [showcases/src/recipe-personal-notebook.recipe.test.ts](../../showcases/src/recipe-personal-notebook.recipe.test.ts)

## What you get

- Zero-knowledge encrypted document storage in the browser (IndexedDB) or on disk (file)
- Typed collections, basic query (`where` / `orderBy` / `limit`), `scan()` for streaming
- Owner role + DEK wrapping (single-user keyring)
- Schema validation via Standard Schema (Zod, Valibot, ArkType, Effect)

## What you don't get (until you opt in)

| You don't have | Opt in via |
|---|---|
| Record version history | `withHistory()` |
| Joins between collections | `withJoins()` (n/a today — see SUBSYSTEMS catalog) |
| Aggregates / `groupBy` | `withAggregate()` |
| File / blob attachments | `withBlobs()` |
| Multi-locale records | `withI18n()` |
| Multi-user grant / revoke | `withTeam()` (always-core single-owner keyring is enough for solo apps) |
| Replication to a remote peer | `withSync()` |

## The whole app

```ts
import { createNoydb } from '@noy-db/hub'
import { idbStore } from '@noy-db/to-browser-idb'

interface Note {
  id: string
  title: string
  body: string
  createdAt: string
}

const db = await createNoydb({
  store: idbStore(),
  user: 'me',
  secret: 'correct-horse-battery-staple', // user-supplied passphrase
})

const vault = await db.openVault('notebook')
const notes = vault.collection<Note>('notes')

// Write
await notes.put('note-1', {
  id: 'note-1',
  title: 'Groceries',
  body: 'eggs, milk',
  createdAt: new Date().toISOString(),
})

// Read by id
const one = await notes.get('note-1')

// Query
const recent = await notes
  .query()
  .orderBy('createdAt', 'desc')
  .limit(10)
  .toArray()

// Stream (works without loading everything into memory)
for await (const n of notes.scan()) {
  console.log(n.title)
}

// Lifecycle
db.close() // wipes KEK + DEKs from memory
```

That's the entire surface area you need for a personal encrypted notebook. Every record on disk is AES-256-GCM ciphertext — IndexedDB sees only the envelope.

## Schema validation (optional, lightweight)

```ts
import { z } from 'zod'

const NoteSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  body: z.string(),
  createdAt: z.string().datetime(),
})

const notes = vault.collection<z.infer<typeof NoteSchema>>('notes', {
  schema: NoteSchema,
})

// Now put() validates before encrypting, get() validates after decrypting.
```

## When this recipe stops being enough

- You want to **see what the note used to say** → upgrade to [accounting-app](./accounting-app.md) (adds `withHistory`)
- You want to **attach files** → upgrade to [accounting-app](./accounting-app.md) (adds `withBlobs`)
- You want **two devices to stay in sync** → upgrade to [realtime-crdt-app](./realtime-crdt-app.md) (adds `withSync` + `withCrdt`)
- You want **fast queries on a million records** → upgrade to [analytics-app](./analytics-app.md) (adds `withIndexing` + `withAggregate`)

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — the full catalog
- [docs/core/01-vault-and-collections.md](../core/01-vault-and-collections.md) (TODO)
- [docs/core/02-encryption.md](../core/02-encryption.md) (TODO)
