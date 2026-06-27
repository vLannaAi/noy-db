# @noy-db/on-shamir

**k-of-n Shamir Secret Sharing** of the vault KEK for multi-party unlock. Any **K** of **N** enrolled shares recombines the KEK; fewer than K leaks zero bits.

The defining feature is **composability** — each share can itself be protected by any other `@noy-db/on-*` method. Share 1 behind a WebAuthn passkey, share 2 behind an OIDC login, share 3 printed on paper in a corporate safe. Fractional trust across different authentication modes.

Part of the `@noy-db/on-*` authentication family.

## Install

```bash
pnpm add @noy-db/on-shamir
```

## Use cases

- *"Any 2 of 3 admins must authorise unlocking the audit vault."*
- *"CFO + COO consent required to unlock the CEO vault during vacation."*
- *"3-of-5 board escrow — the vault survives any 2 resignations."*
- *"Executive key is split across a passkey + OIDC + paper backup — any 2 of 3 unlock."*

## Threat model

**Protects against:**
- Up to K-1 colluding share holders (mathematically — fewer than K shares reveals zero bits of the KEK)
- Loss of up to N-K shares (remaining K shares still reconstruct)

**Does NOT protect against:**
- K colluding share holders (by design — that's the threshold contract)
- Device compromise of the combining machine during reconstruction (the KEK is briefly in memory; if that machine is malicious, no library-level hedge helps)
- Side-channel attacks on the Lagrange interpolation (not constant-time by design — the threat model assumes a trusted combine-device)

## Math

Shamir Secret Sharing over GF(2^8), byte-wise. For each byte of the KEK:

1. Construct a random polynomial of degree k-1 whose constant term is the KEK byte.
2. Each share is the polynomial evaluated at a distinct x-coordinate (1..255; x=0 reserved because it would reveal the byte).
3. Lagrange interpolation at x=0 given any K points recovers the byte.

Implemented in ~120 LoC of pure TypeScript (`gf256.ts` + `shamir.ts`). Zero cryptographic dependencies — just Web Crypto's `getRandomValues` for randomness and `subtle.importKey` to rehydrate the reconstructed KEK.

Reduction polynomial: x^8 + x^4 + x^3 + x + 1 (0x11b, same as AES).

## Usage

### Enroll — after primary unlock

```ts
import { splitKEK, encodeShareBase32 } from '@noy-db/on-shamir'

const shares = await splitKEK(currentKEK, { k: 2, n: 3 })

// Each share is now a RawShare structure. Serialise for distribution:
const shareStrings = shares.map(encodeShareBase32)
// Example: 'SHAMIR_S1_K2N3__AKHT-P4L7-...'

// Distribute via any on-* method:
//   shareStrings[0] → store under a WebAuthn-protected keyring entry
//   shareStrings[1] → store under an OIDC-protected keyring entry
//   shareStrings[2] → print on paper, put in the corporate safe
```

### Unlock — collect K shares and combine

```ts
import { combineKEK, decodeShareBase32 } from '@noy-db/on-shamir'

// Unlock each share via its own on-* method (not shown — uses whichever
// on-webauthn / on-oidc / on-recovery / on-magic-link the holder chose).
const shareA = decodeShareBase32(shareStringFromCFO)
const shareB = decodeShareBase32(shareStringFromCOO)

// Combine — returns a non-extractable KEK ready to use
const kek = await combineKEK([shareA, shareB])
```

### Low-level — for custom integrations

```ts
import { splitSecret, combineSecret } from '@noy-db/on-shamir'

const shares = splitSecret(new Uint8Array(secretBytes), 2, 3)
const recovered = combineSecret([shares[0], shares[1]])
// recovered is a Uint8Array — you handle its lifecycle
```

JSON form — store shares inside other on-* keyring entries:

```ts
import { encodeShareJSON, decodeShareJSON } from '@noy-db/on-shamir'

const json = encodeShareJSON(shares[0])
// { v: 1, x: 1, k: 2, n: 3, y: '<base64>' }
await keyring.put('_recovery_share_1', json)
```

## API

```ts
// High-level — wraps a CryptoKey
async function splitKEK(kek: CryptoKey, options: { k: number; n: number }): Promise<RawShare[]>
async function combineKEK(shares: readonly RawShare[]): Promise<CryptoKey>

// Low-level — operates on raw bytes
function splitSecret(
  secret: Uint8Array,
  k: number,
  n: number,
  randomBytes?: (count: number) => Uint8Array,  // Injectable for tests
): RawShare[]
function combineSecret(shares: readonly RawShare[]): Uint8Array

// Serialisation
function encodeShareBytes(share: RawShare): Uint8Array
function decodeShareBytes(bytes: Uint8Array): RawShare

function encodeShareBase32(share: RawShare): string
function decodeShareBase32(input: string): RawShare

function encodeShareJSON(share: RawShare): ShareJSON
function decodeShareJSON(json: ShareJSON): RawShare

interface RawShare {
  x: number          // 1..255
  y: Uint8Array      // One byte per secret byte
  k: number          // Threshold
  n: number          // Total
}

// GF(2^8) arithmetic — exported for composition / auditing
function gfAdd(a: number, b: number): number
function gfMul(a: number, b: number): number
function gfInv(a: number): number
function gfDiv(a: number, b: number): number
function gfPolyEval(coeffs: readonly number[], x: number): number
function lagrangeInterpolateAtZero(points: readonly [number, number][]): number
```

## Share format

Binary (6-byte header + y-bytes):

```
offset  size  field
0       1     version (= 1)
1       1     x-coordinate (1..255)
2       1     k (threshold)
3       1     n (total)
4       2     byteLength (big-endian uint16)
6+      L     y-bytes (L = byteLength)
```

For a 32-byte KEK: 38 bytes total per share.

Base32 form includes a human-readable prefix (`SHAMIR_S{x}_K{k}N{n}__`) followed by the payload in groups of 4:

```
SHAMIR_S2_K2N3__AKHT-P4L7-KDFG-H3JX-M8E...
```

The prefix is stripped by the decoder — metadata is recovered from the binary header. Consumer tools can show the prefix to the user for at-a-glance share identification without trusting it.

## Composability recipe — Shamir + any on-* method

```ts
import { splitKEK, encodeShareJSON } from '@noy-db/on-shamir'
import { createMagicLinkToken } from '@noy-db/on-magic-link'
// Plus whichever other on-* packages you use

const shares = await splitKEK(currentKEK, { k: 2, n: 3 })

// Share 1 — passkey
await webAuthn.enrollWithPayload(ceoPasskey, encodeShareJSON(shares[0]))

// Share 2 — magic link to an auditor's email
const link = createMagicLinkToken('escrow-vault', { ttlMs: 30 * 24 * 60 * 60 * 1000 })
await emailAuditor(link, encodeShareJSON(shares[1]))

// Share 3 — paper backup
console.log('Corporate-safe backup:', encodeShareBase32(shares[2]))
```

## Performance

GF(2^8) operations are table-lookup O(1) — all micro-operations run in nanoseconds. Splitting a 32-byte KEK into 3 shares takes sub-millisecond. Combining likewise. Web Crypto's `importKey` on the reconstructed KEK is the dominant cost (~1ms).

## License

MIT
