# Sealed bundle delivery — `autoPassphrases` + `sealedPassphrases` (#197 slice 1)

> Per-issue spec for #197 slice 1. Extends `writeNoydbBundle` /
> `readNoydbBundle` so bundles can carry auto-unlock material: either
> plaintext per-user passphrases (public-by-design demos) or
> per-user sealed envelopes (under a `SealingKeyProvider`).
>
> Slice 1 is **self-target only** — the sender's provider seals, and
> the recipient must hold a provider with a matching `pid` to unseal.
> Recipient-target sealing (arbitrary-recipient via asymmetric KMS)
> requires the `RecipientSealer` interface and is deferred per
> foundation doc §11.4.

## 0. Status

- Date: 2026-05-23
- Tracks: #197 (slice 1 — self-target only)
- Out of scope: `RecipientSealer` interface (asymmetric / cross-account
  cloud-KMS handover), per-collection sealed access (sub-collection ACL),
  resealing across providers at receive time.
- Builds on: `SealingKeyProvider` v1 (#186), `SealedEnvelope` wire format
  (#191 envelope alignment), the existing `writeNoydbBundle` /
  `readNoydbBundle` pipeline (foundation §12.2 bundle taxonomy).

## 1. Goal

Replace the per-app `_meta/demo-hints` workaround with a blessed
primitive. Two profiles:

### 1.1 Auto-passphrase (unsealed) — public demo

```ts
const bundleBytes = await writeNoydbBundle(vault, {
  autoPassphrases: {
    policy: 'public-by-design',   // mandatory opt-in marker
    perUser: {
      'demo-customer': 'demo-passphrase-1234',
      'demo-prospect': 'demo-passphrase-5678',
    },
  },
})

// Recipient side — no provider needed:
const { dumpJson, autoUnlock } = await readNoydbBundle(bundleBytes)
if (autoUnlock?.kind === 'unsealed') {
  const pass = autoUnlock.perUser['demo-customer']
  // Pass to createNoydb({ secret: pass, ... }) for an auto-login flow.
}
```

The `policy: 'public-by-design'` discriminant is a mandatory opt-in
marker. A careless `writeNoydbBundle({ autoPassphrases: { perUser } })`
without the marker is rejected at validation. This is the safety net
that prevents accidental "auto-unlock for everyone" against a
production vault.

### 1.2 Sealed passphrase + auto-password — self-target delivery

```ts
const provider = macosKeychainSealingProvider({
  service: 'com.acme.app',
  account: 'alice@acme.example',
})

const bundleBytes = await writeNoydbBundle(vault, {
  sealedPassphrases: {
    mode: 'self-target',          // §11.4 — sender seals, recipient holds matching provider
    provider,
    perUser: {
      'alice': 'alice-passphrase-here',
    },
  },
})

// Recipient side — recipient has the same provider (e.g., same iCloud
// Keychain entry synced to their Mac, same MDM-provisioned bundle id):
const { dumpJson, autoUnlock } = await readNoydbBundle(bundleBytes, {
  sealingProviders: [
    macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice@acme.example',
    }),
  ],
})
if (autoUnlock?.kind === 'sealed') {
  const pass = autoUnlock.perUser['alice']  // already-unsealed plaintext
  // Use with createNoydb({ secret: pass, ... }) for zero-prompt open.
}
```

The recipient's provider must:
- Implement `SealingKeyProvider`.
- Have a `.id` (= `pid`) that matches the writer's provider's `pid` —
  otherwise `unseal` would fail with `BundleSealMismatchError` per
  §11.9.4. Fail-closed unless `attemptUnsealAcrossProviders: true`
  is set (recipient-side opt-in).

## 2. Wire format

### 2.1 Header extension

Add one optional field to `NoydbBundleHeader`:

```ts
interface NoydbBundleHeader {
  // ...existing fields (formatVersion, handle, bodyBytes, bodySha256, publicEnvelope)...

  /**
   * When present, the bundle body contains auto-unlock material under
   * the `_autoUnlock` key inside the wrapped dump JSON.
   *
   * - `'unsealed'` — plaintext per-user passphrases (demo / public).
   * - `'sealed'`   — per-user sealed envelopes; recipient needs a
   *                  matching `SealingKeyProvider` to unseal.
   *
   * Absent → body is a raw `vault.dump()` JSON string (back-compat).
   */
  readonly autoUnlock?: 'unsealed' | 'sealed'
}
```

The header allowlist (`ALLOWED_HEADER_KEYS`) grows to include
`autoUnlock`. Bundles written by pre-#197 hubs (without this field)
read fine on #197 hubs; bundles written by #197 hubs WITH the field
are rejected by pre-#197 hubs (their allowlist excludes it). This
asymmetry is acceptable — recipient hubs must upgrade to consume
#197-style bundles.

### 2.2 Body wrapping

When `autoUnlock` is set, the body decompresses to:

```ts
type WrappedBody =
  | string  // legacy: raw vault.dump() JSON (when autoUnlock undefined)
  | {       // #197: structured wrapper (when autoUnlock present)
      readonly _noydb_bundle_body: 1
      readonly dump: string  // vault.dump() output
      readonly _autoUnlock: AutoUnlockBlob
    }
```

Reader logic:
1. Parse decompressed bytes as UTF-8 → string.
2. If header's `autoUnlock` is undefined: treat the string as the raw
   dump JSON; pass to `vault.load()`.
3. If header's `autoUnlock` is set: parse string as JSON object, extract
   `dump` (passed to `vault.load()`) and `_autoUnlock` (returned to
   caller as the `autoUnlock` field).

The `_noydb_bundle_body: 1` discriminator inside the wrapper guards
against future format drift.

### 2.3 `AutoUnlockBlob` shape

```ts
type AutoUnlockBlob =
  | { kind: 'unsealed'; perUser: Record<string, string> }
  | { kind: 'sealed'; perUser: Record<string, SealedEntry> }

interface SealedEntry {
  readonly pid: string                // matches the producing provider's `.id`
  readonly sealed: string             // base64-encoded sealed bytes
  readonly alg: 'aes-256-gcm'         // for forward-compat, locked to one alg in slice 1
  readonly hint?: Record<string, unknown>  // optional, provider-specific (KMS key alias, etc.)
}
```

Note: `SealedEntry` is **almost** the §11.1 `SealedEnvelope` shape,
without the `v` field (the wrapper's `_noydb_bundle_body: 1` already
provides versioning). Keeping it close lets a future migration unify
the two.

## 3. Write-side API

```ts
interface WriteNoydbBundleOptions {
  // ...existing options...

  /**
   * Unsealed auto-passphrase map. Public-by-design — anyone holding
   * the bundle bytes can read these plaintext credentials. Use for
   * demo data delivery, sample vaults, prospect onboarding.
   *
   * The `policy: 'public-by-design'` marker is mandatory; omitting it
   * is a validation error. This is the safety net against a careless
   * `autoPassphrases: { perUser }` call against a production vault.
   *
   * Mutually exclusive with `sealedPassphrases`.
   */
  readonly autoPassphrases?: {
    readonly policy: 'public-by-design'
    readonly perUser: Record<string, string>
  }

  /**
   * Sealed per-user passphrase map. The hub seals each user's
   * passphrase under the supplied `provider` and embeds the sealed
   * envelopes in the bundle. The recipient must hold a provider with
   * a matching `pid` to unseal.
   *
   * `mode: 'self-target'` is the only mode supported in slice 1
   * (foundation §11.4). Other modes (e.g., 'recipient-target' via
   * `RecipientSealer`) will join as additional discriminant values
   * when their machinery ships.
   *
   * Mutually exclusive with `autoPassphrases`.
   */
  readonly sealedPassphrases?: {
    readonly mode: 'self-target'
    readonly provider: SealingKeyProvider
    readonly perUser: Record<string, string>  // plaintext passphrases to be sealed
  }
}
```

Validation (write-side):

| Condition | Error |
|---|---|
| Both `autoPassphrases` and `sealedPassphrases` set | `ValidationError` — mutually exclusive |
| `autoPassphrases` without `policy: 'public-by-design'` | `ValidationError` — explicit opt-in required |
| `autoPassphrases.perUser` is empty | `ValidationError` — at least one user required |
| `sealedPassphrases.perUser` is empty | `ValidationError` — at least one user required |
| `sealedPassphrases.provider` is undefined | `ValidationError` — provider required |
| `sealedPassphrases.mode` is anything other than `'self-target'` | `ValidationError` — only mode supported in slice 1 |

## 4. Read-side API

```ts
interface ReadNoydbBundleOptions {
  /**
   * Recipient-side sealing providers used to unseal `sealedPassphrases`.
   * The reader picks the one whose `.id` matches each entry's `pid`.
   * Multiple providers may be supplied (different users may seal under
   * different provider identities).
   *
   * When unset and the bundle carries sealed envelopes, the
   * `autoUnlock.perUser` map in the result remains the SEALED entries
   * (no auto-unsealing happens; caller can still inspect and unseal
   * elsewhere).
   */
  readonly sealingProviders?: readonly SealingKeyProvider[]

  /**
   * Opt-in trial mode for unsealing — when `pid` doesn't match a
   * registered provider, try each provider whose alg matches the
   * envelope. Default `false` (strict-pid dispatch per §11.9.2).
   */
  readonly attemptUnsealAcrossProviders?: boolean
}

interface ReadNoydbBundleResult {
  readonly dumpJson: string
  readonly handle: string
  /**
   * Auto-unlock material extracted from the body. Present only when
   * the header's `autoUnlock` flag was set. After unsealing (when
   * applicable), `perUser` values are plaintext passphrases ready to
   * pass to `createNoydb({ secret })`.
   */
  readonly autoUnlock?: {
    readonly kind: 'unsealed' | 'sealed'
    readonly perUser: Record<string, string>  // already-unsealed plaintext
  }
}
```

Read flow:

1. Parse + validate header (existing path).
2. Decompress body bytes → string.
3. If `header.autoUnlock` is undefined: return `{ dumpJson: bodyString }`.
4. Else: parse body as JSON wrapper. Extract `dump` and `_autoUnlock`.
5. If `_autoUnlock.kind === 'unsealed'`: `autoUnlock = { kind: 'unsealed', perUser: blob.perUser }`.
6. If `_autoUnlock.kind === 'sealed'`:
   - Index `sealingProviders` by `pid`.
   - For each `(userId, entry)` in `blob.perUser`:
     - Find provider with matching `pid` (or via trial mode).
     - If found: unseal → plaintext passphrase.
     - If not found AND strict (default): throw `BundleSealMismatchError` with `pid` + actionable resolutions (per §11.9.4).
   - Return `autoUnlock = { kind: 'sealed', perUser: unsealedMap }`.

## 5. `readNoydbBundleHeader` extension

```ts
const header = await readNoydbBundleHeader(bundleBytes)
console.log(header.autoUnlock)  // 'unsealed' | 'sealed' | undefined
```

No new method; just exposes the field that's now in the header.
This is what cloud listing UIs use to display "Auto-unlock: this
bundle opens itself" warning before any download.

## 6. Errors

| Error | Cause | Trigger |
|---|---|---|
| `ValidationError` | Write-side opts violation | See §3 table |
| `BundleSealMismatchError` (NEW) | Sealed entry's `pid` doesn't match any registered provider on read | Read-side, when sealedPassphrases present and no provider matches |
| `BundleIntegrityError` (existing) | Body sha256 mismatch | Unchanged |

`BundleSealMismatchError` message follows the §11.9.4 template — names the failing `pid` and lists three actionable resolutions:

```
BundleSealMismatchError: bundle carries sealed passphrase for user "alice" under
  provider "macos-keychain:com.acme.app/alice@acme.example",
but no registered provider matches that pid.

Resolutions:
  1. Configure a provider matching the pid and retry import.
  2. Pass `attemptUnsealAcrossProviders: true` to try each registered
     provider regardless of pid (extra credential prompts may surface).
  3. Inspect the bundle without unsealing — pass no `sealingProviders`
     to receive the sealed entries unmodified for offline analysis.
```

## 7. Tests

`packages/hub/__tests__/bundle/auto-unlock.test.ts`:

- **Unsealed round-trip**: write with `autoPassphrases` + `policy: 'public-by-design'`; read; recipient extracts plaintext.
- **Unsealed without policy marker**: `ValidationError` at write time.
- **Mutual exclusion**: setting both `autoPassphrases` and `sealedPassphrases` rejected.
- **Empty perUser**: rejected at write.
- **Sealed self-target round-trip** (via `MemorySealingKeyProvider`): write seals, read with same-pid provider unseals to plaintext.
- **Sealed with mismatched provider**: read throws `BundleSealMismatchError` with the actionable message shape.
- **Sealed with no providers supplied**: read returns sealed entries as-is (no auto-unseal); caller inspects.
- **Header-only flag visible pre-decompression**: `readNoydbBundleHeader` returns `autoUnlock: 'sealed'` without reading the body.
- **Back-compat**: bundles written without `autoUnlock` (pre-#197 shape) still read correctly.
- **`attemptUnsealAcrossProviders` opt-in**: when set, mismatched pid succeeds if an alg-compatible provider unseals.
- **`bundleKind` interaction**: header schema accepts `autoUnlock` alongside `publicEnvelope`; both round-trip.

## 8. PR boundary

One PR containing:

- `packages/hub/src/bundle/format.ts` — extend `NoydbBundleHeader` with
  optional `autoUnlock`, update validator + allowlist.
- `packages/hub/src/bundle/bundle.ts` — write-side wrapping logic, read-side
  unwrapping + unseal dispatch, types for AutoUnlockBlob / SealedEntry.
- `packages/hub/src/errors.ts` — `BundleSealMismatchError`.
- `packages/hub/__tests__/bundle/auto-unlock.test.ts` (NEW).
- `packages/hub/src/index.ts` — exports.

Approximate diff: ~400–600 LOC, 1 new test file.

## 9. Acceptance

- [ ] `writeNoydbBundle({ autoPassphrases: { policy, perUser } })` writes a bundle with header `autoUnlock: 'unsealed'` and body containing the wrapped dump + `_autoUnlock` blob.
- [ ] `writeNoydbBundle({ sealedPassphrases: { mode: 'self-target', provider, perUser } })` writes a bundle with header `autoUnlock: 'sealed'` and body containing per-user sealed envelopes.
- [ ] `readNoydbBundle(bytes)` on a #197 bundle returns `{ dumpJson, autoUnlock?: { kind, perUser } }`.
- [ ] `readNoydbBundle(bytes, { sealingProviders })` auto-unseals when provider pid matches.
- [ ] `readNoydbBundleHeader` exposes the `autoUnlock` flag without decompressing the body.
- [ ] Mismatched-provider read throws `BundleSealMismatchError` with the actionable message.
- [ ] All existing bundle tests (#21-with-bundle showcase + bundle.test.ts) continue to pass — back-compat preserved.
- [ ] Full hub regression passes.
- [ ] Typecheck + lint clean.

## 10. Out of scope

- **`RecipientSealer` interface + recipient-target sealing** — defer
  to #197 slice 2 / `at-aws-kms` etc.
- **Per-collection sealed sub-collections** — "this bundle exposes a
  sealed sub-collection (e.g., public price list)" is listed in
  #197's motivation but requires `bundlePolicies` API; separate issue.
- **Re-seal at receive** — recipient might want to immediately re-seal
  under their OWN provider after open (§11.6 default policy). Out of
  scope here; the bundle just delivers; downstream rotation flow
  handles it.
- **`bundleKind`** in the header — added by #198 (partition extraction)
  per foundation §12.4. Not needed for #197 alone.

---

Cross-references:

- Foundation: `2026-05-23-sealing-at-dimension-foundation.md`
  (§11.1 SealedEnvelope, §11.3 use-case modes, §11.4 RecipientSealer,
  §11.9.4 BundleSealMismatchError, §12.4 BundlePublicHeader)
- Issue: #197
- Sibling: #198 (partition extraction; composes with #197 via
  sealed-carried bundles), #199 (client portability; same composition)
- Dependencies: `SealingKeyProvider` (#186 shipped),
  `at-env` / `at-macos-keychain` (concrete providers in workspace)
