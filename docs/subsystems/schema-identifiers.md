# Schema identifiers — stable field IDs + generation↔content-hash binding

Two identity gaps blocked honest schema-evolution tooling (#946): a field had no identity
independent of its name, and "which schema is generation N" was unanswerable from published
reads. Both are closed additively on the existing `_schemas/<collection>` envelope and the
existing vault-wide schema fence — no new reserved-collection layout, no new store contract.

## Field-ID model

Every top-level field in a persisted schema gets an opaque, permanent `id`:

- **Minted from randomness only** — `crypto.getRandomValues(12 bytes)` encoded as a 20-character
  base32url token (`with-shape/persisted-schemas/field-ids.ts`). No timestamp, no name-derivation:
  a name-derived id would change on rename, defeating the point.
- **Minted lazily, once** — the first time a collection persists its schema
  (`persistJsonSchema: true`), every top-level property gets a fresh id.
- **Persisted as a name-keyed map** — `PersistedSchemaEnvelope.fieldIds?: Record<string, string>`
  (field name → id), stored alongside `jsonSchema`/`hash` in the same encrypted
  `_schemas/<collection>` record. Absent on a legacy (pre-#946) envelope and on a stub envelope
  with no derivable field set.
- **Preserved by name across re-derivation** — re-persisting the same schema (or persisting after
  an unrelated change) carries forward `fieldIds[name]` for every name still present; only a
  genuinely new name mints a fresh id (`resolveFieldIds`, mirroring the classified/satellite
  marker-preservation pattern at `register.ts`).
- **Carried across a rename** — `computeSchemaDelta` (`with-shape/schema-update/delta.ts`) detects
  an unambiguous 1:1 rename pairing (a removed name and an added name whose canonicalized
  subschemas match, with no other candidate sharing that shape) and reports it as
  `SchemaDelta.renamed: readonly { from, to }[]`. `resolveFieldIds` accepts that list and looks the
  id up under the OLD name for the new one — the id moves with the field, the name is just its
  current label.

### describe() surfaces the id

`DescribedField.id?: string` carries the resolved id into both `describe()` overloads:

- **Sync `describe()`** never touches the store, so it always passes `fieldIds: undefined` —
  every field's `id` is `undefined`. This is not a bug: the sync path has no persisted state to
  read the id from.
- **Async `describeAsync()`** resolves the persisted-schema `fieldIds` map via
  `resolveDescribeFieldIds()` (silent-degrades to `{}` — no ids — on any failure: no DEK, no
  persisted envelope yet, or an envelope with no `fieldIds`) and threads it through
  `buildDescription`'s `BuildDescriptionInput.fieldIds`. A collection that has never opted into
  `persistJsonSchema` therefore also describes every field with `id: undefined`.

`collection.ts`'s two `describe()` bodies stay under their line ceiling by threading the id
resolution through a helper (`resolveDescribeFieldIds`) rather than inlining lookup logic at the
call site.

## Generation ↔ content-hash binding

The vault-wide schema-fence generation counter (`FenceDoc.currentSchemaVersion`, at
`_meta/schema-fence`) is now bound to the schema-set content hash that was live at that
generation:

- `FenceDoc.schemaHash?: string` — the `PersistedSchemaEnvelope.hash` most recently persisted
  while the vault sat at `currentSchemaVersion`.
- `PersistedSchemaEnvelope.generation?: number` — mirrors `currentSchemaVersion` as of that
  envelope's most recent write.

Together, "generation N = which schema content hash" is answerable from published reads alone:
`vault.schemaFenceState()` returns the fence (including `schemaHash`), and `loadPersistedSchema`
returns the envelope (including `generation`) — no internal state needed. Both fields are
optional: a fresh vault (generation 0, nothing persisted yet) or a fence/envelope written before
#946 simply omits them; `isFenceDoc`'s back-compat parsing tolerates the missing key.

### The lazy-stamp caveat

The envelope's `generation`/hash and the fence's `schemaHash` are stamped by
`persistSchemaIfNeeded` (`with-shape/persisted-schemas/register.ts`) — the same "derive → hash →
skip-or-write" cycle that has always run on the next ordinary schema write. **They do not update
instantly at cutover completion.** A `coordinatedCutover` finishes its drain barrier and advances
`currentSchemaVersion` immediately, but the envelope's `generation` field and the fence's
`schemaHash` only catch up on the next "allow" write through `persistSchemaIfNeeded` (typically the
very next collection registration/open, since that's what calls it) — this is pre-existing
`register.ts` source-of-truth behavior, not a new race introduced by #946, and is documented here
explicitly so a reader isn't surprised by a brief window where `currentSchemaVersion` has already
advanced but the envelope/fence hash pairing hasn't been re-stamped yet.

`register.ts` also re-reads the fence document immediately before stamping `schemaHash` (rather
than reusing an earlier snapshot) to narrow — not eliminate — the window against a concurrent
cutover on a different collection advancing the fence in between.

## Per-collection generation — rejected (locked maintainer decision)

#946's acceptance criteria asked us to evaluate per-collection schema generation as an
alternative to the vault-wide counter. **Rejected for this issue; generation stays vault-wide**
(the existing single `_meta/schema-fence` counter, `FenceDoc.currentSchemaVersion`).

Rationale: the actual requirement — binding a generation number to a concrete schema-content hash
— is fully satisfied at vault granularity; generation N already pins the vault's schema-set hash
via `schemaHash`. Moving to per-collection generation would be a materially larger migration of
the fence model itself (a new per-collection counter, per-collection drain-barrier semantics, and
a new companion record shape), with no requirement in this issue that demands it. That migration
is better folded into #941's schema-manifest engine consolidation, which is already re-designing
how schema state is addressed and read — revisit there if the manifest engine needs finer-grained
generation tracking.

## Guard interaction — additiveOnly() / lockSchema()

A rename is still blocked by both schema-update guards, even though `computeSchemaDelta`
classifies a pure rename as `kind: 'additive'` and reports the pairing under `SchemaDelta.renamed`:

- **`additiveOnly()`** rejects whenever `renamed` is non-empty, via the same
  `NonAdditiveSchemaChangeError` path as any other non-additive change — forcing a
  `coordinatedCutover()` (or `blindUpdate()`) strategy to actually admit the rename.
- **`lockSchema({ fields })`** treats a renamed pair's `from` AND `to` names as both "touching"
  those fields — a rename away from a locked name, or onto one, still violates the lock. A blanket
  `lockSchema()` (no `fields`) already blocked any rename before this, since a pure rename's `kind`
  is never `'none'`.

Why: the rename detection and the field-id carry are a *label change with identity preservation*,
not a data migration. `SchemaDelta.renamed` on its own performs no transform of existing record
values under the old key. Only `coordinatedCutover` (via its `TransformFn`) actually migrates
data. If `additiveOnly()`/`lockSchema()` treated a rename as freely admissible, a caller could
"rename" a field with neither guard tripping and neither strategy running a migration — silently
orphaning every existing record's value under the old key. The id-carry through
`resolveFieldIds`/`describe()` is therefore only meaningful on the integration path that already
performs (or explicitly opts out of) a migration — `coordinatedCutover` (gated by neither guard)
or `blindUpdate()` (explicit opt-out) — never as a way to bypass the guards that exist precisely to
demand one.

## The #941 seam

`fieldIds`, `generation` (on the envelope) and `schemaHash` (on the fence) are plain record-shape
fields on `with-shape/persisted-schemas/types.ts` and `with-shape/schema-update/fence.ts` —
designed so #941's schema-manifest engine can lift them unchanged into its manifest read/fence/open
path. #946 does not introduce a new reserved-collection scheme; it continues to use
`_schemas/<collection>` via the existing `storage.ts` accessors, leaving the manifest-layout
question entirely to #941.

## Back-compat

Every new field is optional and additive:

- A pre-#946 persisted schema envelope (no `fieldIds`/`generation`) loads and describes fine —
  `id` is simply absent from every `DescribedField`.
- A pre-#946 fence document (no `schemaHash`) loads fine — `isFenceDoc` treats the key as
  optional.
- IDs are minted lazily on the first write/persist after upgrade; nothing needs an explicit
  migration step.
