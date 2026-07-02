# public-envelope

> **Owner-curated plaintext metadata, readable before vault unlock or bundle decryption.**
>
> **Status:** design (locked 2026-05-04). Implementation pending.
> **Cluster:** meta
> **Cross-cuts:** `@noy-db/hub` core (vault + bundle format), `@noy-db/hub/i18n` (locale resolution), every storage adapter (read path).
> **Tracking:** issue TBD (`v0.1.0-pre.6` or later).

## Overview

NOYDB's invariant is that storage backends only ever see ciphertext. The flip side of that guarantee is a UX problem: when a user finds a `.noydb` file on a USB stick, or sees a list of vaults in a multi-tenant picker, there is **nothing readable** — every label, name, and timestamp is encrypted under a key the user must first present.

The `public-envelope` service narrows that gap with a deliberate, opt-in plaintext label. The developer enables the feature in `NoydbOptions`; the owner sets the values per-vault. The result is a small, owner-curated metadata document that travels with the vault on disk and inside `.noydb` bundles, readable **without any key material**.

The feature is intentionally a *label*, not an *audit surface*. It carries name, description, icon, and creation/update timestamps. It does **not** carry record counts, user counts, user lists, or any field whose value an active adversary would derive over time. Every published field is one the owner positively decided to leak — defense in depth, not breadth.

## What's in scope (v1)

Static, owner-curated fields:

| Field | Type | Notes |
|---|---|---|
| `name` | `string \| I18nTextDescriptor` | Vault display name. i18n-enabled per the hub's `i18nText` pattern. |
| `description` | `string \| I18nTextDescriptor` | Free-form one or two sentences. i18n-enabled. |
| `icon` | `string` | Base64 data URL (`data:image/png;base64,…` or `data:image/svg+xml;base64,…`). External URLs (`http://`, `https://`) NOT supported in v1 — must be inline `data:` URL. Capped at 256 KB of encoded data-URL string length (≈ 192 KB decoded image). SVG and PNG only at v1. |
| `createdAt` | ISO-8601 string | Auto-set on first envelope write; immutable thereafter. |
| `updatedAt` | ISO-8601 string | Auto-updated on every `setPublicEnvelope` call. |
| `version` | `number` | Monotonic counter; increments on every write. Cache-invalidation aid. |
| `defaultLocale` | BCP-47 string | Hint for renderers when the i18n descriptor doesn't cover the user's locale. |

## What's out of scope (v1)

These belong to a separate, opt-in extension if a real consumer asks:

- Record counts, per-collection record counts.
- User counts, user lists, role distribution.
- Last-accessed-at, last-modified-at (any value that updates on every write — write amplification + freshness lie).
- HMAC / signature for integrity (see "Threat model" — v1 is plaintext untrusted-hint).
- Embedded preview snippets (e.g. "first three records").

## Schema

```ts
import type { I18nTextDescriptor } from '@noy-db/hub'

/** Persisted shape — both `_meta/public-envelope` and bundle header carry this. */
export interface PublicEnvelope {
  readonly _noydb_public: 1
  readonly version: number
  readonly name?: string | I18nTextDescriptor
  readonly description?: string | I18nTextDescriptor
  readonly icon?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly defaultLocale?: string
}

/** Build-time schema — the developer turns the feature on and constrains it. */
export interface PublicEnvelopeSchema {
  /** Allowed field names. Defaults to every field above. */
  readonly fields?: ReadonlyArray<keyof PublicEnvelope>
  /** Maximum icon size — measured as the length of the data-URL string (encoded). Default 256 * 1024. */
  readonly maxIconBytes?: number
  /** Allowed icon MIME types. Default ['image/png', 'image/svg+xml']. */
  readonly iconMimeTypes?: ReadonlyArray<string>
  /** Maximum length of `name` / `description` per locale. Default 200. */
  readonly maxStringChars?: number
}
```

## Storage layout

| Layer | Path | Format |
|---|---|---|
| Vault on disk | `_meta/public-envelope` | Plaintext envelope (`_iv: ''`, `_data: JSON.stringify(envelope)`). Mirror of `_meta/handle` and `_meta/policy`. |
| `.noydb` bundle header | `header.publicEnvelope` | Inline JSON object inside the existing minimum-disclosure header. |

The bundle header parser's allowlist (currently `formatVersion / handle / bodyBytes / bodySha256`) gains one entry — `publicEnvelope` — and a typed validator for it. Every other unknown key still rejects at parse time.

When `vault.dump()` writes a bundle, the current `_meta/public-envelope` is snapshotted into the header. When `readNoydbBundleHeader()` runs, the envelope is returned alongside the existing header fields — without decrypting the body.

## API

```ts
// Developer (build-time)
createNoydb({
  store,
  // shorthand — feature on with default schema:
  publicEnvelope: true,
  // or fine-grained:
  // publicEnvelope: { fields: ['name', 'icon'], maxIconBytes: 64 * 1024 },
})

// Owner (runtime, requires unlocked Noydb)
await db.setPublicEnvelope('acme', {
  name: i18nText({ en: 'Acme 2026 Tax Records', th: 'บันทึกภาษี Acme 2026' }),
  description: 'Q1–Q4 invoices, audit-ready.',
  icon: 'data:image/svg+xml;base64,…',
})

await db.getPublicEnvelope('acme', { locale: 'en' })
// → { name: 'Acme 2026 Tax Records', description: '…', icon: '…', createdAt: '…', … }

// Reader — NO unlock required
import { readPublicEnvelope, readNoydbBundlePublicEnvelope } from '@noy-db/hub'

// From a live store
await readPublicEnvelope(store, 'acme', { locale: 'en' })

// From a bundle byte array
await readNoydbBundlePublicEnvelope(bundleBytes, { locale: 'en' })
```

The two `read*PublicEnvelope` functions are plain exports, not methods on `Noydb` — the whole point is they work without an authenticated session.

The `locale` option resolves any `I18nTextDescriptor` values to plain strings using the hub's existing `applyI18nLocale` helper. Omitting `locale` returns the descriptor untouched, so a renderer that wants every locale (e.g. a multilingual picker) can opt out.

## i18n integration

`name` and `description` accept either a plain string (single-locale labels) or a full `I18nTextDescriptor`:

```ts
// Single-locale
{ name: 'Acme 2026' }

// Multi-locale via the existing i18nText() helper
{ name: i18nText({ en: 'Acme 2026', th: 'Acme 2026 (TH)', de: 'Acme 2026 (DE)' }) }
```

On the read path, callers pass a `locale` and the engine resolves through the public-envelope-specific `pickLocale` helper. The fallback chain is:

1. Exact `locale` match.
2. The envelope's `defaultLocale` (when set).
3. First non-empty translation in the map.
4. Empty string (only if every translation is empty — pathological).

**This deviates deliberately from `resolveI18nText`.** The hub's record-field resolver throws `LocaleNotSpecifiedError` when no translation matches, because record content with no value is a programming error worth surfacing. Label semantics are looser — UIs prefer "show *something* identifiable" over a thrown error that breaks a vault picker. The `pickLocale` helper therefore never throws; consumers that want strict throw-on-missing should call `resolveI18nText` directly.

The schema validator enforces `maxStringChars` per resolved locale — a 200-char cap means each locale's translation is bounded independently, not the JSON-stringified union.

## Receiver-side after `vault.load(bundle)`

Whether `_meta/public-envelope` survives `vault.load(dumpJson)` is **store-dependent** — `Vault.dump()` calls `adapter.loadAll(name)`, and individual stores choose whether to include underscore-prefixed internal collections. Some preserve them; some filter them out the same way they filter `_keyring`.

The bundle header always carries the public envelope as a snapshot for the recipient's pre-unlock UX. The portable, store-independent approach to keeping the label on the destination vault is to re-attach explicitly from the header after `vault.load`:

```ts
const result = await readNoydbBundle(bundleBytes)
await vault.load(result.dumpJson)
if (result.header.publicEnvelope) {
  // The destination vault must have publicEnvelope enabled in its
  // own NoydbOptions for this to succeed.
  const { name, description, icon, defaultLocale } = result.header.publicEnvelope
  await db.setPublicEnvelope(vault.name, {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(defaultLocale !== undefined ? { defaultLocale } : {}),
  })
}
```

This is the same shape as the existing handle reattachment pattern documented on `Vault.getBundleHandle`.

## Threat model

- **Plaintext, untrusted hint.** The store CAN modify the envelope. The hub treats it like an HTTP `Server:` header: a label that helps the user, never a security claim. Renderers that show the label MUST NOT mark it as "verified" or "owner-signed" in v1.
- **Off by default.** Vaults written by hubs without `publicEnvelope` enabled carry no envelope. Reading on those vaults returns `undefined`.
- **Schema-bounded.** If a developer's schema lists only `name` and `icon`, an owner trying to set `description` gets a `ValidationError`. Stops field creep, keeps audit surface predictable.
- **Existence does NOT confirm vault contents.** The envelope can say "Acme Tax Records" while the body is empty or contains anything else. The user-facing UX should make this explicit on first-contact flows.
- **Icon surface.** 256 KB of base64 means roughly 192 KB decoded. Big enough for a logo or photo; small enough that an attacker can't smuggle a payload past size limits. The MIME-type allowlist (`image/png`, `image/svg+xml`) is checked on write — SVGs are NOT sanitized for embedded scripts at the storage layer; renderers MUST treat them as untrusted DOM input.
- **Bundle threat surface is unchanged.** A bundle in cloud storage already exposes its size and `bodySha256` to anyone who can list the file. The public envelope adds owner-curated label fields to that same surface. The body remains encrypted; this isn't a new leakage class, just a wider opt-in surface inside the existing one.

## Implementation outline

```
packages/hub/src/
  meta/
    public-envelope/
      types.ts            # PublicEnvelope, PublicEnvelopeSchema, defaults
      schema.ts           # validate-on-write (size cap, MIME allowlist, length cap)
      storage.ts          # readPublicEnvelope, savePublicEnvelope (mirrors policy/storage.ts)
      i18n.ts             # resolve descriptors to a locale
      index.ts            # barrel
  noydb.ts                # db.setPublicEnvelope / db.getPublicEnvelope methods
  bundle/
    format.ts             # widen header allowlist + validator
    bundle.ts             # snapshot envelope into bundle on write; surface on read
    public-envelope.ts    # readNoydbBundlePublicEnvelope helper

packages/hub/__tests__/
  public-envelope.test.ts # schema validation + i18n resolution + bundle round-trip
  bundle-public-envelope.test.ts  # header parser + minimum-disclosure regression
```

The `meta/public-envelope/` directory is new; it will be a sibling to `policy/`. Reusing the `_meta` envelope-bypass pattern keeps the storage layer dumb.

## Test plan

- Round-trip a `PublicEnvelope` through every store via the conformance test suite (`runStoreConformanceTests`).
- `readPublicEnvelope` returns `undefined` on vaults that have no envelope written.
- Schema validator rejects oversize icons, disallowed MIME types, oversize strings, unknown fields.
- Bundle header parser accepts `publicEnvelope` when present; still rejects every other unknown field (regression on the minimum-disclosure rule).
- `bundle.writeNoydbBundle` snapshots the current `_meta/public-envelope` into the header; `readNoydbBundleHeader` surfaces it without decrypting the body.
- i18n round-trip: write a multi-locale `I18nTextDescriptor`, read with `locale: 'en'` and `locale: 'th'`, both resolve through `applyI18nLocale` correctly.
- **Negative test** — disabling `publicEnvelope` in the developer config makes `db.setPublicEnvelope` throw `ValidationError` and `readPublicEnvelope` return `undefined`.
- **Threat-model test** — manually corrupt the `_meta/public-envelope` envelope's `_data` (simulate a malicious store); reading still returns the corrupted value (explicit contract — untrusted hint), but the corrupted SVG icon is NOT auto-rendered (consumer's responsibility, documented).

## features.yaml entry

```yaml
features:
  - id: public-envelope
    name: Public envelope (owner-curated plaintext metadata)
    package: '@noy-db/hub'
    status: preview
    subsystem_doc: docs/services/public-envelope.md
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'Off by default — developer opts in via NoydbOptions.publicEnvelope.'
      - 'Plaintext untrusted hint — store can modify; treat like an HTTP Server: header.'
      - 'Schema-bounded — only fields the developer allowed are settable.'
      - 'Icon surface capped at 256 KB; PNG/SVG only.'
    related: [bundle, i18n]
```

## Future work (post-v1)

- **HMAC signature under a KEK-derived key** — lets recipients verify "this label was set by an owner who held the KEK at write time," without the hub leaving zero-knowledge. Probably a separate `publicEnvelope.signature` field, gated by a v2 schema bit.
- **Per-locale i18n via dictKey** — instead of an inline `I18nTextDescriptor`, point at a row in a public-readable dictionary collection. Useful only if vault descriptions are very long and shared across many vaults; unlikely.
- **Counts and user lists** — split into a separate `public-summary` service with its own opt-in. Different freshness story (recompute on demand vs snapshot), different threat model (active adversary derives counts over time).
- **Provenance chain** — sign every envelope update with the hub version + author user-id, build a chain. Useful for compliance scenarios; out of scope for label UX.

## References

- [`docs/services/session-tiers.md`](./session-tiers.md) — the tier-1/2/3 model the envelope sits *below* (envelope is readable below tier 1).
- [`docs/services/i18n.md`](./i18n.md) — `i18nText` and `applyI18nLocale` semantics this service reuses.
- [`docs/services/bundle.md`](./bundle.md) — the `.noydb` bundle format whose header allowlist this widens.
- [`SPEC.md`](../../SPEC.md) — primary spec; the zero-knowledge invariant the public envelope deliberately narrows for chosen fields.
