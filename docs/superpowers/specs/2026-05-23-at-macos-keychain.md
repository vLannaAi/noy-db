# `@noy-db/at-macos-keychain` + envelope alignment

> Per-issue spec for **#191** (`feat(at-macos-keychain): macOS Keychain
> sealing key provider`). Grounded in [the at-* sealing dimension
> foundation doc](./2026-05-23-sealing-at-dimension-foundation.md).
> Folds in a small hub envelope alignment (no behavior change) and an
> at-env pid-stability test so all three land in one PR.

## 0. Status

- Date: 2026-05-23
- Tracks: #191 (primary), #14 (managed-mode umbrella, closed), #186 (hub
  abstraction, closed), #187 (at-env, closed).
- Out of scope: all other `at-*` providers (#188–#190 cloud KMS,
  #192–#193 desktop, #194 webauthn-prf), recovery dispatch (#196),
  managed-mode policy enforcement (#195), bundle delivery (#197),
  partition extraction (#198, #199).
- Architectural backdrop: foundation doc §11 (deep-dive on sealing
  primitives). Key references:
  - §11.2 capability matrix — `at-macos-keychain` is **self-targeted
    only** (rows A+B; no C/D). No `RecipientSealer` impl.
  - §11.4 — `SealingKeyProvider` interface stays the only contract
    needed for this scope; `RecipientSealer` is for handover-capable
    providers (deferred).
  - §11.9.1 — `pid` format is semver-frozen per provider package once
    shipped; golden-string test locks the format.

## 1. Goal

Ship `@noy-db/at-macos-keychain` as the second concrete `at-*` provider
after `at-env`. The desktop / per-user surface in the §11.3 matrix.

Boundary with the env-based provider (excerpt from at-env's README,
also documented in the foundation doc §2 threat-model table):

| Provider | Threat model fit | Anti-fit |
|---|---|---|
| `at-env` | Container / K8s / Heroku / Doppler — platform-managed secret | Laptops / shared dev machines where other users can `echo $NOYDB_SEALING_KEY` |
| `at-macos-keychain` | Desktop apps on macOS — binds the sealing key to the user's login keychain | Server/container deployments (no Keychain there) |

The two providers cover the **two cleanest single-tenant deployments**:
server-managed-secret and macOS-user-managed-secret. They share an
identical AES-GCM-in-JS sealing pipeline; they differ only in *where
the 32-byte key lives*.

## 2. Package layout

```
packages/
└── at-macos-keychain/
    ├── README.md                     # threat-model section per §2 table; setup
    ├── package.json                  # @napi-rs/keyring as peer-dep
    ├── tsconfig.json
    ├── tsup.config.ts
    ├── vitest.config.ts
    ├── src/
    │   └── index.ts                  # macosKeychainSealingProvider(opts)
    └── __tests__/
        ├── at-macos-keychain.test.ts # contract tests (env-gated darwin-only)
        └── pid-stability.test.ts     # golden-string lock per §11.9.1
```

Mirror the at-env structure for consistency. One file, focused
implementation, env-gated integration tests against the real Keychain.

### Manifest pins

- `name`: `@noy-db/at-macos-keychain`
- `version`: matches lockstep with the workspace (current: `0.1.0-pre.15`+1
  at ship time)
- `peerDependencies`: `@noy-db/hub: workspace:*`, `@napi-rs/keyring`
- `devDependencies`: `@noy-db/hub`, `@noy-db/to-memory`, `@napi-rs/keyring`,
  `@types/node`
- `engines.node`: `>=18.0.0` (same as at-env — Web Crypto required)
- `os` field in package.json: `["darwin"]` to signal native support
  (NOT a hard install gate — `@napi-rs/keyring` itself handles platform
  dispatch; this is documentation)
- `keywords`: include `noy-db`, `at-macos-keychain`, `sealing-key-provider`,
  `managed-passphrase`, `macos`, `keychain`, `aes-256-gcm`

## 3. API

### 3.1 Exported function

```ts
import type { SealingKeyProvider } from '@noy-db/hub'

export interface MacosKeychainSealingProviderOptions {
  /**
   * Keychain service identifier — typically your app's bundle id
   * (e.g., 'com.acme.app'). Forms half of the lookup key.
   */
  readonly service: string

  /**
   * Per-user account identifier inside the service — typically the
   * user's email or stable user id (e.g., 'alice@acme.example'). Forms
   * the other half of the lookup key.
   */
  readonly account: string

  /**
   * Optional: pass a pre-constructed @napi-rs/keyring Entry to override
   * the default `new Entry(service, account)` construction. Intended for
   * test injection (memory-backed Entry stub); production callers should
   * leave undefined.
   * @internal
   */
  readonly entry?: KeyringEntry
}

export function macosKeychainSealingProvider(
  opts: MacosKeychainSealingProviderOptions,
): SealingKeyProvider
```

Where `KeyringEntry` is the structural shape:

```ts
interface KeyringEntry {
  getPassword(): string | null   // returns null when entry doesn't exist
  setPassword(value: string): void
  deletePassword(): boolean
}
```

(Defined inline to avoid a hard dep on `@napi-rs/keyring`'s exported
types; the structural match is exact.)

### 3.2 Provider behaviour

`id`: `macos-keychain:${service}/${account}` — exact format frozen
per §11.9.1.

`seal(passphrase: Uint8Array): Promise<Uint8Array>`:

1. Resolve the 32-byte AES key via `getOrCreateKey()` (see §3.3).
2. Generate 12-byte random IV via `crypto.getRandomValues`.
3. `AES-GCM` encrypt the passphrase under the key with the IV. The
   Web Crypto API returns ciphertext + 16-byte tag concatenated.
4. Return `[12-byte IV][ciphertext+tag]` as a `Uint8Array`.

Output layout is **byte-identical to at-env's**. This is intentional:
identical pipeline means the hub envelope (§4 below) doesn't need to
distinguish per-provider on the read path beyond `pid` dispatch.

`unseal(sealed: Uint8Array): Promise<Uint8Array>`:

1. Validate `sealed.length >= 12 + 16` (IV + minimum GCM tag); throw
   informative error otherwise.
2. Split IV from body.
3. Resolve the 32-byte AES key via `getOrCreateKey()`.
4. `AES-GCM` decrypt the body under the key with the IV. Tag mismatch
   surfaces as a Web Crypto exception — let it propagate (hub treats
   any thrown error as "this provider cannot unlock this vault").

### 3.3 Key lifecycle — generate-on-first-use

This is the structural difference from `at-env`:

- `at-env`: the 32-byte key is supplied externally (env var); the
  provider just reads it.
- `at-macos-keychain`: the provider **owns** the key lifecycle —
  reads from Keychain on every operation, generates + stores on
  miss.

Pseudocode:

```ts
async function getOrCreateKey(): Promise<CryptoKey> {
  if (cached) return cached

  const entry = opts.entry ?? new KeyringEntry(opts.service, opts.account)
  let stored = entry.getPassword()  // string | null

  if (stored === null) {
    // First call ever. Generate a fresh 32-byte AES-256 key,
    // base64-encode for Keychain string storage, persist.
    const fresh = new Uint8Array(32)
    crypto.getRandomValues(fresh)
    entry.setPassword(bytesToBase64(fresh))
    stored = entry.getPassword()  // re-read, defensive
    if (stored === null) {
      throw new Error(
        '@noy-db/at-macos-keychain: setPassword succeeded but '
        + 'getPassword returned null. Keychain access denied?',
      )
    }
  }

  const keyBytes = base64ToBytes(stored)
  if (keyBytes.length !== 32) {
    throw new Error(
      `@noy-db/at-macos-keychain: stored key for service="${opts.service}" `
      + `account="${opts.account}" decodes to ${keyBytes.length} bytes; `
      + 'expected 32. The Keychain entry may have been tampered with — '
      + 'delete the entry and reopen the vault to regenerate.',
    )
  }
  cached = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
  return cached
}
```

Behavior:

- **First seal call ever for a given `(service, account)`** generates
  a fresh random key and stores it. Subsequent calls (this process or
  any future process under the same user) retrieve the same key. The
  vault round-trips.
- **Cache scope is per provider instance.** A long-running process
  imports the CryptoKey once; tests get a fresh instance per call so
  Keychain interactions are exercised.
- **No explicit `delete` API on the provider.** If a vault is being
  retired, the consumer calls `entry.deletePassword()` directly on
  `@napi-rs/keyring`. We don't wrap that.

### 3.4 Error surface

| Condition | Error message |
|---|---|
| `service` or `account` empty | `@noy-db/at-macos-keychain: 'service' and 'account' are required, non-empty strings.` |
| Keychain read denied (user denied prompt, sandboxed) | The underlying `@napi-rs/keyring` exception bubbles up — its message is platform-flavored ("Could not access keychain item" etc.); we let it through with no wrapping (over-wrapping obscures real failures). |
| First-write succeeds, immediate re-read returns null | Hard-failure error as in pseudocode (extremely unlikely; defensive). |
| Stored key is not valid base64 / not 32 bytes | Tamper-detection error pointing at the fix (delete the entry). |
| Sealed-bytes length < 28 on unseal | `@noy-db/at-macos-keychain: sealed bytes too short (...). Input is not a valid at-macos-keychain-sealed envelope.` (mirrors at-env's wording) |
| AES-GCM decrypt fails | Web Crypto's exception propagates — typically the message includes "decryption failed" or similar. Hub catches and surfaces as "this provider cannot unlock this vault." |

## 4. Hub envelope alignment

Small no-behavior-change cleanup in
`packages/hub/src/team/managed-passphrase.ts` so the persisted shape
matches §11.1's documented `SealedEnvelope`. **No new hub features**.

### 4.1 Rename + export `SealedEnvelope`

Today:

```ts
interface PersistedShape {
  readonly _noydb_sealed: 1
  readonly providerId: string
  readonly sealed: string // base64
}
```

After:

```ts
/**
 * Wire-format envelope persisted at `_meta/sealed-passphrase` for
 * managed-mode vaults. The provider produces raw sealed bytes via
 * `SealingKeyProvider.seal`; this wrapper carries the dispatch
 * metadata hub needs to pick the right provider on the unseal path.
 *
 * Stability boundary: once shipped, the wire format only grows by
 * adding optional fields. See §11.9.1 of the foundation doc.
 */
export interface SealedEnvelope {
  /** Envelope schema version. v1 is the shape shipped in this PR. */
  readonly v: 1
  /** Magic marker for forensics + legacy-shape detection. */
  readonly _noydb_sealed: 1
  /** Matches the producing provider's `.id`. Dispatch key on unseal. */
  readonly pid: string
  /** Sealed bytes from the provider, base64-encoded on the wire. */
  readonly payload: string
}
```

Read path accepts both old and new shapes:

```ts
function parseSealedEnvelope(raw: unknown): SealedEnvelope | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r._noydb_sealed !== 1) return undefined

  // New shape (v1): { v: 1, _noydb_sealed: 1, pid, payload }
  if (r.v === 1 && typeof r.pid === 'string' && typeof r.payload === 'string') {
    return { v: 1, _noydb_sealed: 1, pid: r.pid, payload: r.payload }
  }
  // Legacy shape (pre.14 / pre.15): { _noydb_sealed: 1, providerId, sealed }
  if (typeof r.providerId === 'string' && typeof r.sealed === 'string') {
    return { v: 1, _noydb_sealed: 1, pid: r.providerId, payload: r.sealed }
  }
  return undefined
}
```

Write path always produces v1:

```ts
const persisted: SealedEnvelope = {
  v: 1,
  _noydb_sealed: 1,
  pid: payload.providerId,
  payload: bytesToBase64(payload.sealed),
}
```

### 4.2 Migration semantics

- **Existing vaults sealed under at-env pre.15** carry the legacy shape
  on disk. First open after the upgrade reads via the legacy branch
  → returns plaintext OK → operation succeeds. The legacy envelope
  stays on disk until something rewrites `_meta/sealed-passphrase`
  (e.g., a future cross-provider rotation lands).
- **No forced rewrite.** A read-only dual-shape acceptor is enough;
  forcing a rewrite would change ledger versions unnecessarily.
- **Test gates the dual-shape acceptance** — a fixture envelope with
  the legacy shape unseals successfully under both at-env and the
  new at-macos-keychain (Memory provider for cross-provider correctness).

### 4.3 What's deliberately deferred

- `alg` field — adding it requires picking the alphabet ('aes-256-gcm',
  …) and committing to format. Defer until the first multi-alg
  provider needs it. Adding `alg?` later is backwards-compatible (it's
  optional; readers tolerate its absence).
- `hint` field — purely advisory; defer until first handover-capable
  provider (`at-aws-kms` asymmetric) needs to carry recipient hints.
- `SealedEnvelope` array form (§11.7 Op C multi-provider) — deferred
  per §11.7; v1 envelope being singleton doesn't preclude later array
  promotion.

These deferrals are stated in §4 of the foundation doc; this spec just
inherits them.

## 5. at-env companion changes

Two small additions in the same PR:

### 5.1 pid-stability golden-string test

New file `packages/at-env/__tests__/pid-stability.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { envSealingProvider } from '../src/index.js'

describe('at-env: pid stability', () => {
  it('produces stable id format for a given env var', () => {
    process.env.NOYDB_SEALING_KEY = '<32-byte base64 fixture>'
    const p = envSealingProvider()
    expect(p.id).toBe('env:NOYDB_SEALING_KEY')
  })

  it('produces stable id format for a custom env var', () => {
    process.env.MY_KEY = '<32-byte base64 fixture>'
    const p = envSealingProvider({ envVar: 'MY_KEY' })
    expect(p.id).toBe('env:MY_KEY')
  })
})
```

This test FAILS if anyone changes the `id` format (e.g., to `at-env:...`
or `env-var:...`). Forces deliberate version-bump discussion.

### 5.2 (Optional) README cross-ref

at-env's README already documents threat model; add a one-line
cross-ref at the top pointing at this foundation doc + the new
at-macos-keychain README for adopters who need desktop deployment.

## 6. Testing strategy

### 6.1 at-macos-keychain contract tests

`packages/at-macos-keychain/__tests__/at-macos-keychain.test.ts`. All
env-gated darwin-only — skipped on Linux/Windows CI, skipped if
`NOYDB_AT_MACOS_KEYCHAIN_REAL_TESTS=1` is not set (lets local
contributors run without provoking Keychain prompts).

Each test uses a **unique `service` per test** (e.g.,
`com.noydb.test-${randomUUID()}.${testName}`) + cleanup in `afterEach`
deleting the entry. Belt-and-braces — Keychain entries leaking from
test runs are a real problem otherwise.

Cases:

- **Round-trip**: `seal(bytes)` then `unseal(result)` returns original.
- **Different (service, account) → mutually unsealable**: two
  providers with different config; one's output cannot be unsealed by
  the other (the cached CryptoKey differs).
- **Provider id format locked**: matches `macos-keychain:${service}/${account}`
  exactly (golden-string assertion per §11.9.1).
- **Cross-process determinism**: seal in one provider instance; create
  a fresh provider instance with same `(service, account)`; unseal
  succeeds. Validates Keychain-backed persistence.
- **Tamper-detect on stored key**: deliberately overwrite the Keychain
  entry with non-base64 or wrong-length bytes; subsequent operation
  throws the documented error message.
- **End-to-end managed-mode vault round-trip**: `createNoydb({ store,
  passphraseMode: 'managed', sealingKey: macosKeychainSealingProvider(...) })`
  → write some records → close → reopen with a fresh provider instance
  → records still readable.

### 6.2 Unit tests with injectable `entry` stub

For test isolation, a separate suite uses a memory-backed Entry stub
(implements `getPassword`/`setPassword`/`deletePassword` from a
`Map<string, string>`). Validates the seal/unseal pipeline without
touching the real Keychain. Runs on every CI platform, not env-gated.

This is what `MacosKeychainSealingProviderOptions.entry` enables.

### 6.3 Hub envelope dual-shape test

`packages/hub/__tests__/managed-passphrase-envelope-compat.test.ts`:

- Write a `_meta/sealed-passphrase` record with the **legacy** shape
  `{ _noydb_sealed: 1, providerId, sealed }` directly to a memory store.
- Open the vault under managed mode with a provider whose `.id`
  matches `providerId`.
- Assert: unseal succeeds, vault opens.
- (Then write a new record via `saveSealedPassphrase`; assert the
  on-disk shape is now `{ v: 1, _noydb_sealed: 1, pid, payload }`.)

This is the migration safety net. If it ever breaks, existing pre.15
vaults can't open.

## 7. Showcase

One env-gated showcase at `showcases/<next-number>-at-macos-keychain/`:

- Walks through `createNoydb({ passphraseMode: 'managed', sealingKey:
  macosKeychainSealingProvider({ service: 'com.noydb.showcase', account: 'demo' }) })`
- Writes a few records, closes, reopens, reads them back.
- README explains the threat-model fit (Touch ID can be enabled via
  Keychain Access UI per-entry; document but don't try to gate it
  programmatically — that's macOS UI territory).
- Same env-gated darwin-only execution pattern as the existing
  `to-icloud` showcase.

## 8. Documentation

- `packages/at-macos-keychain/README.md` — package-level docs covering
  setup, threat model (per §2 table), the Keychain-Access-UI Touch ID
  upgrade path, troubleshooting (denied prompts, sandboxing, MDM
  policy implications), and a "When NOT to use" section pointing at
  at-env for servers and the future at-webauthn-prf for browsers.
- Cross-link from at-env's README to the new package.
- `docs/subsystems/sealing-pid-stability.md` — referenced from
  §11.9.1 but doesn't exist yet. Tiny doc (~30 lines) documenting the
  rule once for all `at-*` packages. Land in this PR since at-env
  and at-macos-keychain are the two providers it applies to today.

## 9. PR boundary

One PR containing:

- `packages/at-macos-keychain/**` (new — package, README, src, tests)
- `packages/at-env/__tests__/pid-stability.test.ts` (new — pid lock)
- `packages/hub/src/team/managed-passphrase.ts` (modified — rename
  `PersistedShape → SealedEnvelope`, add `v: 1` field, dual-shape
  reader)
- `packages/hub/__tests__/managed-passphrase-envelope-compat.test.ts`
  (new — migration safety net)
- `showcases/<n>-at-macos-keychain/**` (new — env-gated showcase)
- `docs/subsystems/sealing-pid-stability.md` (new — pid stability rule)
- `bundle-manifest.json` update if package count is tracked
- `pnpm-workspace.yaml` updated for new package
- Lockstep version bump per release workflow memory

Approximate diff: ~600–800 LOC additions, ~30 LOC modifications,
8 new files.

## 10. Acceptance

- [ ] `@noy-db/at-macos-keychain` package builds, types pass,
      lints clean.
- [ ] Provider `id` exactly `macos-keychain:${service}/${account}`;
      golden-string test passes.
- [ ] `seal` / `unseal` round-trip via `@napi-rs/keyring` succeeds
      on darwin (env-gated test).
- [ ] Cross-process determinism: fresh provider instance with same
      `(service, account)` unseals output from previous instance.
- [ ] Different `(service, account)` → mutually unsealable outputs.
- [ ] End-to-end `createNoydb` round-trip succeeds under managed
      mode with `at-macos-keychain` as `sealingKey`.
- [ ] Hub envelope dual-shape compat test passes; existing
      at-env-sealed vaults open without rewrite.
- [ ] at-env pid-stability test passes; format unchanged.
- [ ] showcase runs end-to-end on a darwin CI runner.
- [ ] docs/subsystems/sealing-pid-stability.md ships.
- [ ] No regression in existing 1601 hub tests.

## 11. Open questions for review

- **Q.1** `@napi-rs/keyring` vs alternatives. The #191 issue body
  recommends it; this spec inherits the recommendation. Alternatives
  considered: `node-keytar` (archived, look-but-don't-touch),
  hand-rolled FFI via `koffi` (more work, no cross-platform
  reuse). Lock in `@napi-rs/keyring` unless the user identifies an
  issue.
- **Q.2** Touch ID / per-entry gating. macOS Keychain Access UI can
  add Touch ID prompts per entry; this is a user-driven UI change,
  not programmatic. Should the package expose any API hint for this
  (e.g., a README walkthrough only)? Recommendation: docs only, no
  code surface.
- **Q.3** `os: ["darwin"]` in package.json. Soft signal, not a hard
  install gate. Should we add a runtime check (`process.platform !==
  'darwin'` → throw with a clear "use at-env / at-wincred /
  at-libsecret" message)? Recommendation: yes — fail-loudly on the
  wrong platform.
- **Q.4** Caching strategy. The pseudocode caches the imported
  CryptoKey for the provider instance's lifetime. Alternative: cache
  invalidation on every operation (re-read Keychain each time). The
  latter is paranoid (catches "Keychain entry deleted under our
  feet"), the former is fast (no Keychain round-trip per seal).
  Recommendation: cache for instance lifetime; matches at-env's
  pattern + Keychain access cost is high enough to justify caching.

---

Cross-references:
- Foundation: `2026-05-23-sealing-at-dimension-foundation.md`
  (§11.2, §11.4, §11.9.1, §2 threat-model)
- Issue: #191
- Predecessor: #187 (at-env), #186 (hub SealingKeyProvider)
