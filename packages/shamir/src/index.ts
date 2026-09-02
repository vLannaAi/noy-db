/**
 * **@noy-db/shamir** — Shamir Secret Sharing over GF(2^8), byte-wise, and
 * the share codecs. Pure math, zero dependencies.
 *
 * For each byte of the secret, a random polynomial of degree k-1 with the
 * byte as its constant term; each share is that polynomial evaluated at a
 * distinct x. Lagrange interpolation at x=0 recovers the byte. Any K of N
 * shares recombine the secret; fewer than K leak zero bits. The secret can
 * be any length — the math never asks what the bytes are for.
 *
 * ## What this package deliberately is NOT
 *
 * It implements NO hub contract and wraps NO key. The hub-facing unlock
 * method — `shamirRecoveryProvider()` satisfying `@noy-db/hub/on`'s
 * `NoydbShamir`, and the `splitKEK` / `combineKEK` conveniences over a
 * `CryptoKey` — lives in `@noy-db/on-shamir` (noy-db-on), which depends on
 * this package. The moment this package implemented a hub type it would
 * need to import hub, hub's own tests could not depend on it without a
 * build cycle, and the mirrored-interface arrangement this split exists to
 * remove would be back. Same posture as `@noy-db/attestation`: a primitive
 * hub embeds, that reaches into hub nowhere.
 *
 * @packageDocumentation
 */

export {
  gfAdd,
  gfMul,
  gfDiv,
  gfInv,
  gfPolyEval,
  lagrangeInterpolateAtZero,
} from './gf256.js'

export {
  splitSecret,
  combineSecret,
  type RawShare,
} from './shamir.js'

export {
  encodeShareBytes,
  decodeShareBytes,
  encodeShareBase32,
  decodeShareBase32,
  encodeShareJSON,
  decodeShareJSON,
  type ShareJSON,
} from './share-format.js'
