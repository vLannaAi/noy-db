# Issue #152 — feat(extension): @noy-db/extension-chrome — drag-and-drop .noydb reader

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-10

- **Milestone:** none
- **Labels:** type: feature

---

Split from #102.

## Target package

`@noy-db/extension-chrome` — new Chromium extension (Manifest v3).

## Scope

- **File association** — intercepts `.noydb` file links via `chrome.runtime.onMessageExternal` + file-drop handler on a built-in page.
- **Drag-and-drop reader page** — user drops a `.noydb` file, enters passphrase, gets an in-browser read-only view of the vault and collections.
- **No file upload, ever** — file is read locally via `FileReader`, decrypted in-memory, never touches the network.
- **No host permissions** — manifest declares no host permissions.
- **Chromium-first** — Firefox/Safari ports tracked separately if demand materializes.
- **Shared core** — same `readNoydbBundle()` primitive as the CLI. Extension bundles `@noy-db/hub` + minimal Vue/vanilla UI.

## Non-goals (v1)

- No edit mode — read-only. Edit mode can follow when core primitives are stable.
- No hosted PWA — rationale in discussion #96.
- No Firefox/Safari ports.

## Acceptance

- [ ] Manifest v3, no host permissions
- [ ] `FileReader`-based decryption — no network I/O in reader code path (enforced by test + manifest review)
- [ ] Drag-and-drop opens passphrase prompt → vault/collection tree view
- [ ] Shared reader logic lives in `@noy-db/hub`, not duplicated
- [ ] Changeset for `@noy-db/extension-chrome`
- [ ] Docs: `docs/reader.md` (extension section)

## Related

- #100 — `.noydb` container format (blocks this)
- #102 — original combined issue (closed, split here + CLI reader issue)
- Discussion #96 — PWA-vs-extension rationale
