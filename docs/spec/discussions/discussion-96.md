# Discussion #96 — Reader: ship as CLI extension + browser extension (not PWA)

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/96

---

Once the `.noydb` container format and a Drive adapter exist (sibling discussions), the remaining UX piece is: **what happens when a user wants to open a `.noydb` file?**

This discussion proposes shipping the reader as **two extensions, not a PWA**:

1. **`@noy-db/cli`** — a CLI extension for desktop / server / scripting use.
2. **`@noy-db/extension-chrome`** (and equivalent for other browser engines) — a browser extension that bundles the reader UI and intercepts `.noydb` file links.

Why two extensions instead of a hosted PWA: PWAs have inconsistent file-handling support across browsers (Chromium-only File Handling API, no Firefox/Safari), require hosting infrastructure, and create a single point of compromise for the reader UX. Extensions install once, run locally, and have consistent file-association behavior across the platforms users actually have.

## 1. CLI reader (`@noy-db/cli`)

Extends the existing CLI plan from `ROADMAP.md:448` (`init`, `open`, `dump`, `load`, `verify`). The reader-specific commands:

```bash
# Inspect a bundle without decrypting (header only — handle, format version, body size).
noydb inspect 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb

# Open interactively. Prompts for passphrase, opens a REPL against the compartment.
noydb open 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb

# Open and run a query non-interactively (passphrase from $NOYDB_PASSPHRASE or stdin).
noydb open file.noydb --query 'invoices.where(amount > 1000)'

# Mount as a writable in-memory compartment, sync changes back on close.
noydb open file.noydb --rw
```

The CLI reader is the **canonical** reader implementation. The browser extension consumes the same `@noy-db/core` `readNoydbBundle()` primitive — there is no separate browser-only code path for opening a bundle.

Distribution: published to npm as `@noy-db/cli` with a `noydb` bin. Single binary build for offline distribution via `pkg` or `bun build --compile`. The single-binary build is critical for the "give the auditor a USB stick with a `.noydb` file and a `noydb` binary" use case.

## 2. Browser extension reader (`@noy-db/extension-chrome`)

A WebExtension (Manifest V3) that:

1. **Bundles the reader UI** — same Vue components used by `@noy-db/vue`, packaged as the extension's popup / new-tab page.
2. **Registers as a handler for `.noydb` URLs** — when the user clicks a link to a `.noydb` file in any web page (including Drive's UI), the extension intercepts the navigation and opens the bundle in the reader.
3. **Handles local file picks** — drag-and-drop into the extension popup, or right-click → "Open with NOYDB" on a downloaded file.
4. **Handles Drive integration** — uses `chrome.identity.launchWebAuthFlow` for OAuth and downloads the bundle directly through the Drive API (no backend needed). See the Drive adapter discussion for OAuth details.

Manifest sketch:

```json
{
  "manifest_version": 3,
  "name": "NOYDB Reader",
  "permissions": ["identity", "downloads", "storage"],
  "host_permissions": [
    "https://www.googleapis.com/*",
    "https://drive.google.com/*"
  ],
  "content_scripts": [{
    "matches": ["https://drive.google.com/*"],
    "js": ["content/drive-link-interceptor.js"]
  }],
  "action": { "default_popup": "popup.html" }
}
```

The content script on `drive.google.com` watches for `.noydb` file rows in the Drive UI and adds an "Open in NOYDB" action item next to them.

### Browser engine coverage

| Engine | Mechanism | Coverage |
|---|---|---|
| Chrome / Edge / Brave / Opera (Chromium) | Manifest V3 WebExtension | ✅ One build |
| Firefox | Manifest V3 WebExtension (mostly compatible — needs polyfill for `chrome.identity`) | ✅ One build with polyfill |
| Safari | Safari Web Extensions (requires Xcode wrapper, App Store distribution) | ⚠️ Possible but high overhead — defer |
| Android (Firefox / Kiwi / Yandex) | WebExtension support via Firefox for Android | ⚠️ Limited; Kiwi works fully |

For the primary target (Thai Android users with Drive), the realistic install path is:

1. User installs **Firefox for Android** or **Kiwi Browser**.
2. User installs the NOYDB extension from add-ons.mozilla.org.
3. User clicks a `.noydb` file in the Drive web UI from their mobile browser → extension intercepts → reader opens.

This is one extra install step compared to a PWA, but it's the only path that actually works consistently across the engines we care about.

### Native Drive Android app integration

The Drive Android app (`com.google.android.apps.docs`) does **not** route `.noydb` files to web extensions — it routes them to apps registered with an Android intent filter for the MIME type. To fully support clicking a `.noydb` file inside the Drive Android app, we'd need a Capacitor / TWA wrapper around the reader extension that registers an Android intent filter. **Out of scope for v1**, flagged as a follow-up.

For v1, the Android flow is: open Drive in your browser (not the Drive app) → click `.noydb` → extension handles it. Acceptable but not ideal. Document this clearly.

## Extension marketplace conflict check

Before naming the extension `NOYDB Reader`, we need to confirm:

1. **Chrome Web Store** — search for existing extensions named "NOYDB", "noy-db", "Noy DB Reader". As of the current date none are listed (search confirms no hits), but a re-check at publish time is mandatory.
2. **Firefox add-ons (AMO)** — same check.
3. **Trademark / namespace conflict with the unrelated "NOY Backup Utility"** — different name, different ecosystem (desktop installer vs. browser extension). Low risk of confusion as long as we never call our format `.noy`. The `.noydb` rename eliminates the meaningful collision surface.

This check should be re-run as part of the publish checklist for the extension, not just during design.

## Reader UX specifics

The reader is a **single shared component** rendered in three contexts (CLI TTY, browser-extension popup, browser-extension full tab). Key UX rules:

1. **Header preview before passphrase prompt.** Critical UX — the user needs to see "Bundle 01HXG4F5… · NOYDB v1 · 41 MB" before typing anything secret. The `.noydb` format makes this possible by carrying the opaque handle unencrypted. The reader **never** displays a compartment name pre-unlock, because the format doesn't carry one.
2. **Biometric offer is opt-in per device.** A reader on a brand-new device has no WebAuthn credential yet; falls through to passphrase. Once unlocked, the user can register a biometric credential for this handle on this device via the v0.7 session machinery.
3. **Wrong-passphrase UX.** Slow (PBKDF2 at 600K iterations is ~1s on mid-range mobile) and timing-safe. The existing crypto path already handles this; the reader just needs to surface a friendly error.
4. **Never write plaintext to disk.** Reader opens compartment in memory only. If the user chooses "save a local copy," the local copy is another `.noydb` file written by `dump()` — never decrypted JSON.
5. **No telemetry.** The reader is a privacy product. No analytics, no error reporting, no auto-update phone-home beyond the platform's own extension auto-update mechanism.

## Open questions

1. **Should `@noy-db/cli` and `@noy-db/extension-chrome` live in the existing monorepo or separate repos?** Monorepo keeps versioning trivial; separate repos make extension-store reviews independent of core releases. Lean: monorepo, with extensions tagged for separate publishing.
2. **Code signing** for the single-binary CLI build. Required for macOS Gatekeeper and Windows SmartScreen. Adds Apple Developer ID + Microsoft signing certificate as ongoing costs. Decide before first 1.0 publish.
3. **Auto-update for the CLI binary.** Self-update vs. relying on `npm` / package managers. Self-update is convenient but a security surface. Lean: rely on package managers, don't ship self-update.
4. **Extension auto-OAuth.** Should the extension auto-prompt OAuth on first use, or only when the user explicitly tries to open a Drive-hosted bundle? Lean: lazy — first OAuth happens on first Drive open.
5. **Capacitor/TWA wrapper for Android.** Worth scheduling as a v1.x follow-up, or wait for a real consumer ask?

## Out of scope for this discussion

- The `.noydb` format itself — sibling discussion.
- Drive adapter OAuth / sync — sibling discussion.
- Sync scheduling — sibling discussion.
- Native iOS reader (would need Swift + Safari Web Extension wrapper).


> _Comments are not archived here — see the URL for the full thread._
