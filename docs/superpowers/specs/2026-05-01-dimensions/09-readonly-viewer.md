# Dimension 09 — Read-only viewer tools

## Purpose

Make `.noydb` bundles **viewable without an app**. A recipient should be able to drag a `.noydb` file into a browser extension or open it via a hosted viewer URL, authenticate, and browse the records — without installing anything app-specific, without writing back, without leaking ciphertext to a server. This is the missing distribution channel for "send someone a snapshot of your vault" use cases (audit hand-off, customer data return, regulatory disclosure, family inheritance scenarios).

## Current state

- `.noydb` bundles can be opened by any application that links `@noy-db/hub` plus a destination store.
- No purpose-built viewer exists.
- The hub does not expose a `readOnly: true` mode that rejects writes at the type level.

## Target state

Two distribution channels for the viewer:
- **A browser extension** (Chrome, Firefox, Safari WebExtension) registered as a file-type handler for `.noydb` (where the OS permits) and accepting drag-drop within its popup. Open and browse offline.
- **A hosted PWA** at a stable URL (e.g., `viewer.noy-db.dev`, served as static assets, no backend). Drag-drop, browse, no upload — the bundle never leaves the user's machine. Auth via passphrase, magic-link share, or recipient-slot capability.

A new core flag `readOnly: true` in `createNoydb()` enforces read-only at the type-system level: no `put`, `delete`, `saveAll` on collections; the type signature itself omits these methods.

## Concrete additions

**Packages:**
- `@noy-db/viewer-ext` — WebExtension package; build outputs Chrome / Firefox / Safari builds
- `@noy-db/viewer-pwa` — installable PWA, static-hosted (free tier: GitHub Pages, Cloudflare Pages, Netlify)
- `@noy-db/viewer-cli` — command-line equivalent for terminal use (lists collections, dumps records as JSON/CSV)
- `@noy-db/viewer-shared` — shared rendering primitives (collection list, record detail, history navigator, period picker, blob preview) consumed by all three

**Core changes:**
- `createNoydb({ readOnly: true })` — type-level write rejection
- `Collection<T>` exposes `readOnly` capability flag readable from UX

**Authentication paths supported in the viewer:**
- Passphrase (always)
- Recipient-slot capability (Dimension 02 — bundle's per-recipient slot with own passphrase)
- Magic-link unlock (existing `on-magic-link`)
- One-shot envelope (Dimension 08 — `withOneShotEnvelope`, server-issued cap)
- UCAN / pre-signed token (Dimension 02 — `on-ucan` / `on-presigned`)
- DID-bound signature verification (Dimension 15 — viewer can verify the source vault was signed by a claimed DID)

**Published-share variant ("monographs" — Notesnook-inspired):**
- `vault.publish({ collection, slice?, public: true | { passphrase } })` — produce a public read-only URL backed by a static-hosted bundle; viewer-pwa serves it. Inspired by Notesnook monographs and the "send a link to a snapshot" pattern.
- Diff renderer in the viewer — show what changed between two snapshots (Datomic / Dolt-inspired).

## Non-goals & tradeoffs

- **No editing, syncing, or exporting.** A viewer that writes is a different product. Export to plaintext (Dimension 03) is gated behind explicit auth tier and warned loudly.
- **No upload to a server.** PWA processes the bundle entirely client-side. The static host never sees plaintext or ciphertext.
- **No persistence in the viewer.** Each session opens fresh; no cached vaults across sessions (privacy default).
- **Not a replacement for a full app.** The viewer renders generically; it doesn't know about app-specific UX (custom field renderers, computed fields with rich semantics). For that, ship a full app.

## Dependencies / sequencing

- Lazy-mode (v0.22 in flight) — viewers must handle bundles >RAM (see-through to `to-file`-style streaming via `loadAll`/`scan`). Without lazy-mode, viewer-pwa OOMs on multi-GB bundles.
- Bundle-handle metadata + history rendering — viewer needs to know what's in the bundle structurally.
- `readOnly: true` core flag — prerequisite for type-safe viewers.
- Recipient-slot UX — Dimension 02's recipient capability flow needs a stable shape before the viewer renders the unlock UI.

## Cross-references

- `features.yaml` → propose new `tools` section parallel to `adapters` / `frameworks`
- Related: Dimension 02 (auth methods supported), Dimension 03 (export from viewer), Dimension 04 (`in-ux-*` shared rendering), Dimension 08 (one-shot capability unlock)
- Spec anchor: new `SUBSYSTEMS.md#viewer` section

## Open questions

- **Browser extension distribution.** Chrome Web Store + Firefox Add-ons + Safari App Store all have review queues. Acceptable timeline?
- **PWA authenticity.** Without a backend, the viewer's static assets must be tamper-evident. Subresource integrity? Signed releases? GitHub-hosted with audit log?
- **File-type registration.** OS-level `.noydb` association is platform-specific. Worth shipping installer scripts, or punt to "drag-drop only"?
- **History rendering.** Hash-chained ledger view is rich; how much UI complexity belongs in the generic viewer vs an app-specific viewer?
- **Cross-locale UX.** Viewer auto-detects browser locale and renders i18n fields appropriately?
- **Print / hand-off.** Can the viewer trigger `as-pdf` (Dimension 03) for printable disclosure? Auth tier gate?
