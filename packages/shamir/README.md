# @noy-db/shamir

Shamir Secret Sharing over GF(2^8), byte-wise, plus the share codecs. **Pure math, zero
dependencies, no hub contract.**

```ts
import { splitSecret, combineSecret, encodeShareBase32, decodeShareBase32 } from '@noy-db/shamir'

const secret = crypto.getRandomValues(new Uint8Array(32))
const shares = splitSecret(secret, 2, 3).map(encodeShareBase32)   // any 2 of 3 recombine
const back = combineSecret([decodeShareBase32(shares[0]!), decodeShareBase32(shares[2]!)])
```

## Where this sits

This is the primitive. The **unlock method** built on it — `shamirRecoveryProvider()` for
`createNoydb({ shamirRecovery })`, and `splitKEK` / `combineKEK` over a `CryptoKey` — is
`@noy-db/on-shamir`, in the `on-*` family. If you are enrolling Shamir recovery on a vault, install
that; if you are composing threshold sharing into something else, install this.

The split exists so hub's own recovery tests can exercise the real math without depending on a
package that implements hub's contract (a build cycle), and so `on-shamir` can import that contract
instead of mirroring it. Same posture as `@noy-db/attestation`.

## Threat model

Protects against up to K−1 colluding share holders (mathematically — fewer than K shares reveal
zero bits) and loss of up to N−K shares. Does not protect against K colluding holders (the
threshold contract) or compromise of the machine combining the shares.

## Share format

Base32 string: `SHAMIR_S<x>_K<k>N<n>__<base32 groups>`. Binary: 6-byte header (magic, x, k, n,
y-length) + y-bytes. JSON: `{ x, y: base64, k, n }`. All three round-trip; `decode*` throws on
malformed, truncated, or mismatched input.
