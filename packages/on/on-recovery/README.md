# @noy-db/on-recovery

One-time printable recovery codes for noy-db. The **last-resort unlock path** when the primary authentication (passphrase, WebAuthn, OIDC) is unavailable. Codes are generated once, shown to the user once, printed on paper, stored in a safe. Each code unlocks the vault exactly **one time** and then burns itself.

Part of the `@noy-db/on-*` authentication family. Sibling packages: `on-webauthn`, `on-oidc`, `on-magic-link`, `on-pin`.

## Install

```bash
pnpm add @noy-db/on-recovery
```

## Threat model

**Protects against:**
- Primary authentication becoming unavailable (forgotten passphrase, lost passkey device, OIDC provider down)
- Code replay — each code burns on successful unlock by deleting its keyring entry

**Does NOT protect against:**
- Physical theft of printed codes — assume paper compromise → user calls `revokeAllRecoveryCodes` + re-enrolls
- User enrolling without actually printing — the calling application must enforce this UX

Recovery codes should NEVER be the only unlock method on a vault. Enroll passphrase / WebAuthn / OIDC first, then recovery codes as a fallback.

## Code format

```
XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
```

- **28 characters** total (24 Base32 body + 4 Base32 checksum)
- **120 bits of entropy per code** — infeasible to brute-force
- **RFC 4648 Base32 alphabet** (`A-Z2-7`) — no confusing `0/O`, `1/I/L`, `8/B` pairs
- **4-character checksum** catches single-character transcription errors (≥99.9999% of them)
- **Groups of 4 with hyphens** for eye-tracking when writing down

Input is lenient: whitespace, hyphens, lowercase are all stripped before validation.

## Security model

Each code is processed through:

```
wrappingKey = PBKDF2-SHA256(
  password   = normalizeCode(code),
  salt       = perCodeRandomSalt,   // Stored alongside wrapped KEK
  iterations = 600_000,              // Matches hub's passphrase derivation
  length     = 256                   // bits
)

wrappedKEK = AES-KW(kek, wrappingKey)
```

The `wrappedKEK + salt + codeId` goes into the keyring under a `_recovery_<N>` entry. On unlock, PBKDF2 re-derives the wrapping key from the user-typed code + salt, and AES-KW unwraps the KEK.

## Usage

This package provides the **crypto layer only**. Storage, audit, rate-limiting, and burn-on-use are application-layer concerns handled by hub's keyring + audit-ledger APIs.

### Enrollment (after primary unlock)

```ts
import { generateRecoveryCodeSet } from '@noy-db/on-recovery'

// After the user unlocks with passphrase, offer recovery-code enrollment
const { codes, entries } = await generateRecoveryCodeSet({
  count: 10,        // 8-20 is reasonable; default 10
  kek: currentKEK,  // The vault's currently-unwrapped KEK
})

// Show `codes` to the user ONCE — print, download, copy. Do NOT store them.
displayRecoveryCodes(codes)
downloadRecoveryCodes(codes)

// Persist `entries` to the vault's keyring. Each entry is safe to
// store on disk — it holds only the salt + wrapped KEK + codeId.
for (const entry of entries) {
  await vault.keyring.put(`_recovery_${entry.codeId}`, entry)
}

// Write an audit-ledger entry
await vault.ledger.append({
  type: 'on-recovery:enroll',
  actor: currentUserId,
  codeCount: entries.length,
  timestamp: new Date().toISOString(),
})
```

### Unlock (when primary auth is unavailable)

```ts
import { parseRecoveryCode, unwrapKEKFromRecovery } from '@noy-db/on-recovery'

const parsed = parseRecoveryCode(userInput)

if (parsed.status === 'invalid-format') {
  // User typed junk — show "not a valid recovery code" without counting against rate limit
  return showError('format')
}
if (parsed.status === 'invalid-checksum') {
  // Well-formed but checksum wrong — transcription error, not a guess
  return showError('checksum')
}

// Find which enrolled entry this code matches
const allEntries = await vault.keyring.list({ prefix: '_recovery_' })

for (const entry of allEntries) {
  try {
    const kek = await unwrapKEKFromRecovery(parsed.code, entry)

    // Match! Burn this entry — delete the keyring record so the code
    // can never be replayed.
    await vault.keyring.delete(`_recovery_${entry.codeId}`)

    // Write an audit-ledger entry
    await vault.ledger.append({
      type: 'on-recovery:unlock',
      actor: currentUserId,
      codesRemaining: allEntries.length - 1,
      timestamp: new Date().toISOString(),
    })

    return kek
  } catch {
    // Wrong entry, try next
  }
}

// No matching entry — counts against the host app's rate limit
await vault.ledger.append({
  type: 'on-recovery:unlock-failed',
  actor: currentUserId,
  reason: 'not-found',
  timestamp: new Date().toISOString(),
})
throw new Error('no matching recovery code')
```

### Revocation (after a suspected paper leak)

```ts
// Scan all recovery entries, delete each.
const allEntries = await vault.keyring.list({ prefix: '_recovery_' })
for (const entry of allEntries) {
  await vault.keyring.delete(`_recovery_${entry.codeId}`)
}
// Optionally re-enroll a fresh set.
```

## API

```ts
// Generate a full enrollment
async function generateRecoveryCodeSet(options: {
  count?: number         // Default 10, clamped to 1..100
  kek: CryptoKey         // Currently-unwrapped KEK
}): Promise<{
  codes: string[]        // Show to user once, then forget
  entries: RecoveryCodeEntry[]  // Persist to keyring
}>

// Parse + normalize user input
function parseRecoveryCode(input: string): ParseResult

type ParseResult =
  | { status: 'valid'; code: string }    // Normalized, checksum verified
  | { status: 'invalid-checksum' }        // Format OK, checksum wrong
  | { status: 'invalid-format' }          // Not a valid code shape

// Attempt to unwrap the KEK with a code + an entry; throws on mismatch
async function unwrapKEKFromRecovery(
  code: string,              // The normalized code from parseRecoveryCode
  entry: RecoveryCodeEntry,  // One of the enrolled entries
): Promise<CryptoKey>

// Lower-level helpers (for advanced use cases)
function formatRecoveryCode(normalized: string): string
async function deriveRecoveryWrappingKey(code: string, salt: Uint8Array): Promise<CryptoKey>
async function wrapKEKForRecovery(kek: CryptoKey, code: string, salt: Uint8Array): Promise<Uint8Array>

interface RecoveryCodeEntry {
  codeId: string        // ULID — caller uses this to delete the entry on burn
  salt: string          // Base64
  wrappedKEK: string    // Base64
  enrolledAt: string    // ISO timestamp
}
```

## Performance

PBKDF2 with 600K iterations takes ~500ms per derive on modern hardware. Generating 10 codes enrolls in ~5 seconds (serial) — acceptable for a one-time enrollment flow; show a loading indicator. Unlock is a single derive per attempt (~500ms).

If you need faster enrollment (e.g., a CLI test), you can parallelize via `Promise.all`.

## License

MIT
