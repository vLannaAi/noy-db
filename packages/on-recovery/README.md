# @noy-db/on-recovery

One-time printable recovery codes for noy-db. The **last-resort unlock path** when the primary authentication (secret, WebAuthn, OIDC) is unavailable. Codes are generated once, shown to the user once, printed on paper, stored in a safe. Each code unlocks the vault exactly **one time** and then burns itself.

Part of the `@noy-db/on-*` authentication family. Sibling packages: `on-webauthn`, `on-oidc`, `on-magic-link`, `on-pin`.

## Install

```bash
pnpm add @noy-db/on-recovery
```

## Threat model

**Protects against:**
- Primary authentication becoming unavailable (forgotten secret, lost passkey device, OIDC provider down)
- Code replay — the hub burns each entry on successful recovery

**Does NOT protect against:**
- Physical theft of printed codes — assume paper compromise → call `db.team.rotateRecovery(vault, { profile: 'paper' })` for a fresh sheet (replaces, never appends; gated by the `rotate-recovery` policy gate)
- User enrolling without actually printing — the calling application must enforce this UX

Recovery codes should NEVER be the only unlock method on a vault. Enroll secret / WebAuthn / OIDC first, then recovery codes as a fallback.

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

This package is a **thin code-generator + parser layer over the hub's
`mintPaperRecoveryEntry` primitive**. The crypto lives in the hub, and it
wraps the vault's **DEK set** — never the KEK:

```
wrappingKey = PBKDF2-SHA256(
  password   = normalizeCode(code),
  salt       = perEntryRandomSalt,
  iterations = 600_000,              // matches hub's secret derivation
  length     = 256                   // bits
)

entry = AES-GCM(dekSet, wrappingKey) + salt + codeId + enrolledAt
```

Entries live in the vault's `_meta/recovery-paper` document. On recovery the
hub re-derives the wrapping key from the typed code, unwraps the DEK set, and
re-wraps it under the user's **new** secret.

> **History — why there is no KEK path.** Until `0.1.0-pre.8` this package
> wrapped the KEK directly (`unwrapKEKFromRecovery`, `wrapKEKForRecovery`).
> That required an **extractable KEK**, which the hub's key derivation
> deliberately disallows — the same asymmetry that made `on-password`
> unreachable from a real consumer. All unlock tiers were unified on the
> wrap-DEKs primitive (#26 Path C, #38 Option A), and the KEK-wrapping API
> was removed. Do not look for it; nothing here can hand you a KEK.

## Usage

This package does exactly three things: generate printable codes, parse and
normalize user input, and format normalized codes for display. Storage,
matching, burn-on-use, auditing, and rotation are all **hub** concerns.

### Enrollment (after primary unlock)

```ts
import { generateRecoveryCodeSet } from '@noy-db/on-recovery'

// The DEK set proves possession and is what the codes wrap.
const keyring = await db.team.getKeyring('acme')
const { codes, entries } = await generateRecoveryCodeSet({
  deks: keyring.deks,
  count: 10,          // 8-20 is reasonable; default 10
})

// Show `codes` to the user ONCE — print, download, copy. Do NOT store them.
displayRecoveryCodes(codes)

// Persist `entries` — each holds only salt + wrapped DEK set + codeId,
// safe to store. The hub appends them to `_meta/recovery-paper`.
await db.team.enrollRecovery('acme', { profile: 'paper', entries })
```

### Recovery (when primary auth is unavailable)

`parseRecoveryCode` classifies input **before** any expensive derivation, so
a transcription error never counts against a rate limit:

```ts
import { parseRecoveryCode } from '@noy-db/on-recovery'

const parsed = parseRecoveryCode(userInput)
if (parsed.status === 'invalid-format')   return showError('not a recovery code')
if (parsed.status === 'invalid-checksum') return showError('check for typos')   // transcription, not a guess
```

The recovery itself is one hub call. It finds the matching entry, burns it,
sets the new secret, and by default **auto-rotates the remaining codes** so
the sheet in the safe stays fully usable:

```ts
const { newCodes } = await db.recoverSecret('acme', {
  newSecret,
  recoveryProof: { profile: 'paper', payload: { code: parsed.code } },
})
if (newCodes.length > 0) showCodesToUser(newCodes)   // show-once, same as enrollment
```

### Fresh sheet (lost printout / suspected paper leak)

```ts
const { newCodes } = await db.team.rotateRecovery('acme', { profile: 'paper' })
showCodesToUser(newCodes)
```

Replaces (never appends) the paper sheet in a single envelope write. Under
`STRICT_POLICY` this requires an off-device factor proof, so a stolen
unlocked laptop cannot silently mint a sheet for the attacker.

## API

```ts
// Generate a full enrollment
async function generateRecoveryCodeSet(options: {
  count?: number                 // Default 10, clamped to 1..100
  deks: Map<string, CryptoKey>   // The vault's current DEK set
}): Promise<{
  codes: string[]                // Show to user once, then forget
  entries: PaperRecoveryEntry[]  // Persist via db.team.enrollRecovery
}>

// Parse + normalize user input
function parseRecoveryCode(input: string): ParseResult

type ParseResult =
  | { status: 'valid'; code: string }    // Normalized, checksum verified
  | { status: 'invalid-checksum' }        // Format OK, checksum wrong
  | { status: 'invalid-format' }          // Not a valid code shape

// Re-hyphenate a normalized code for display
function formatRecoveryCode(normalized: string): string
```

`PaperRecoveryEntry` (`{ codeId, enrolledAt, salt, wrapped DEK blob }`) is the
hub's type — this package mints it via the hub and never defines its own.

## Performance

PBKDF2 with 600K iterations takes ~500ms per derive on modern hardware. Generating 10 codes enrolls in ~5 seconds (serial) — acceptable for a one-time enrollment flow; show a loading indicator. Recovery is a single derive per attempt (~500ms).

## License

MIT
