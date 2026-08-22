# @noy-db/at-macos-keychain

**macOS Keychain sealing key provider for noy-db [managed-secret mode](https://github.com/vLannaAi/noy-db/issues/14).**

Desktop-app provider in the `at-*` family. Binds the sealing key to the user's macOS login Keychain — accessible only to processes running as the same user, optionally gated by Touch ID via Keychain Access UI.

The user never sees or types a secret. The 32-byte AES-256-GCM key lives in the Keychain; the vault opens only when the same OS user (and optionally same biometric) is present.

## Install

```bash
pnpm add @noy-db/hub @noy-db/at-macos-keychain @napi-rs/keyring
# or: npm install @noy-db/hub @noy-db/at-macos-keychain @napi-rs/keyring
```

`@napi-rs/keyring` is a peer dependency — it ships the native binding to the macOS Security framework via `SecItem*` calls. Install it alongside this package.

## Setup

```ts
import { createNoydb } from '@noy-db/hub'
import { atMacosKeychain } from '@noy-db/at-macos-keychain'

const db = await createNoydb({
  store,
  user: 'alice',
  secretMode: 'managed',
  sealingKey: atMacosKeychain({
    service: 'com.acme.app',          // your app's bundle id
    account: 'alice@acme.example',    // per-user keychain item
  }),
})

const vault = db.vault('acme')
// First open: provider generates a fresh 32-byte AES-256 key, stores it
// in the Keychain, hub uses it to seal a random secret. Subsequent
// opens (this process or any future process running as alice on this
// Mac) retrieve the same key, unseal transparently. No secret
// prompt ever appears.
```

## When to use this provider

- ✅ Desktop apps where the user expects "I'm logged into my Mac, the vault should be available."
- ✅ Apps where `at-env` is unsuitable — laptops or shared dev machines where other users with shell access can `echo $NOYDB_SEALING_KEY` and exfiltrate the key.
- ✅ Apps that want optional Touch ID upgrade (see "Touch ID" below) without writing platform-specific UI code.

## When NOT to use this provider

- ❌ Server-side / containerized deployments — there is no Keychain in a container. Use [`@noy-db/at-env`](../at-env) or `@noy-db/at-aws-kms` (when it ships).
- ❌ Browser apps — Keychain is a native OS feature; not exposed to browser sandboxes. Use `@noy-db/at-webauthn-prf` (when it ships).
- ❌ Cross-machine handover (where a SaaS hands a customer their bundle to open on their laptop). Keychain entries don't leave a Mac (except via iCloud Keychain sync between the same user's devices); this provider can't seal *for* an arbitrary recipient. Use a handover-capable cloud-KMS provider (`@noy-db/at-aws-kms` asymmetric, when it ships).

## Provider id format

```
macos-keychain:<service>/<account>
```

E.g., `macos-keychain:com.acme.app/alice@acme.example`. This format is **frozen** per the [sealing pid stability rule](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/sealing-pid-stability.md) — once shipped, it never changes. The hub uses it as the dispatch key when reading an existing `_meta/sealed-secret` envelope.

## Touch ID

macOS lets users add Touch ID gating to a Keychain entry via **Keychain Access.app → search for the entry → right-click → Get Info → Access Control → Confirm before allowing access → "Ask for Touch ID"**. This is a one-time user-controlled action; this package does not gate it programmatically.

After the user enables Touch ID on the entry, every subsequent `seal`/`unseal` call surfaces the system Touch ID prompt. The provider's API surface does not change; the gating is transparent.

## Threat model

The Keychain entry IS the security boundary. Strength is bounded by:

- **macOS user-account isolation.** Processes running as a different OS user cannot read the entry. App Sandboxing (App Store apps) further restricts; unsandboxed apps must trust co-resident processes.
- **Login keychain lock state.** When the user's login keychain is locked, reads surface a prompt or fail. Apps needing operation while locked should implement explicit unlock UX.
- **Optional Touch ID per entry.** Users add this via Keychain Access UI as described above.

**Does NOT protect against:**
- Malware running as the same user with Keychain access.
- A physically present attacker who knows the user's login password and can unlock the keychain.
- macOS itself being compromised below the Keychain Services layer.

Note the family-level property: `at-*` providers are the one **non-zero-knowledge**
part of noy-db. A host you control can decrypt the scoped slice it unseals. That
is the point of the family, and it is a real reduction in the guarantee the rest
of the project makes.

## API

```ts
function atMacosKeychain(opts: {
  service: string                  // your app bundle id / namespace
  account: string                  // per-user identifier
  entry?: KeychainEntry            // internal test injection — leave undefined in production
}): NoydbSealer
```

Returns a [`NoydbSealer`](../hub/src/port/at/index.ts) — importable as `@noy-db/hub/at` — the contract `@noy-db/hub`'s managed-secret mode consumes.

Throws at construction when `service` or `account` is empty, or when running on a non-darwin platform without a test stub.

The provider exposes only `NoydbSealer` — not `RecipientSealer`. It is **self-targeted only**: it can seal and unseal locally, but cannot seal for an arbitrary recipient (no public-half to publish). Bundle-handover delivery to arbitrary recipients requires a handover-capable cloud-KMS provider.

## Key lifecycle

- **First call ever for a given `(service, account)`**: generates a fresh 32-byte AES-256 key via `crypto.getRandomValues`, base64-encodes it, stores in the Keychain. The `seal`/`unseal` operation then proceeds using that key.
- **Subsequent calls (same process or any future process under the same OS user)**: read the stored base64, decode, import as a `CryptoKey`, perform AES-256-GCM.
- **Different `(service, account)` → different Keychain entry → different key**. Sealed outputs from one pair cannot be unsealed by another.
- **Cache**: the imported `CryptoKey` is cached for the lifetime of the provider instance. Long-running processes do not pay a Keychain round-trip per seal/unseal.

If a vault is being retired, call `entry.deletePassword()` directly on `@napi-rs/keyring`. This package does not wrap that — the Keychain entry's lifecycle is decoupled from the vault's lifecycle, and the explicit `@napi-rs/keyring` call is the cleanest way to do it.

## Testing

For platform-independent unit tests, inject a memory-backed entry via the `entry` option:

```ts
import { atMacosKeychain, type KeychainEntry } from '@noy-db/at-macos-keychain'

function memoryEntry(): KeychainEntry {
  let stored: string | null = null
  return {
    getPassword: () => stored,
    setPassword: (v) => { stored = v },
    deletePassword: () => { const had = stored !== null; stored = null; return had },
  }
}

const provider = atMacosKeychain({
  service: 'com.acme.test',
  account: 'test',
  entry: memoryEntry(),
})
```

The injected entry bypasses the real Keychain entirely. The seal/unseal AES-GCM pipeline is fully exercised; only the OS-Keychain integration is stubbed.

For real-Keychain integration tests on darwin CI runners, leave `entry` undefined and ensure each test uses a unique `service` (e.g., `com.noydb.test-${randomUUID()}`) with cleanup in `afterEach` (`entry.deletePassword()`). Otherwise Keychain entries leak across runs.

## Related

- [`@noy-db/at-env`](../at-env) — env-var sealing for server / container deployments.
- [`@noy-db/hub`](../hub) — the database core that consumes `NoydbSealer`.
- [Sealing pid stability rule](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/sealing-pid-stability.md)

## License

MIT
