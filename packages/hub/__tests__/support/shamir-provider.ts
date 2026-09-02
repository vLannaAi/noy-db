/**
 * The hub-side test adapter over `@noy-db/shamir` — hub's recovery tests
 * exercise REAL k-of-n threshold behaviour through it.
 *
 * This is the four-line `NoydbShamir` that `@noy-db/on-shamir` ships as
 * `shamirRecoveryProvider()`, written here rather than imported, on purpose:
 * hub must import `@noy-db/on-shamir` NOWHERE. That package implements hub's
 * `NoydbShamir` contract (so it imports hub, from noy-db-on), and a hub
 * devDependency on it would be the build cycle that kept on-shamir in core
 * for a year and forced it to MIRROR the interface instead of importing it.
 * `@noy-db/shamir` implements no hub contract, so hub can depend on it the
 * way it depends on `@noy-db/attestation` — no mirror, nothing to hold in
 * step. See `HUB_SATELLITE_DEPS` in scripts/check-architecture.mjs.
 *
 * A stub would leave the six tests green while proving nothing about k-of-n;
 * this proves it with the shipped math.
 */
import { splitSecret, combineSecret, encodeShareBase32, decodeShareBase32 } from '@noy-db/shamir'
import type { NoydbShamir } from '../../src/with-party/team/noydb-shamir.js'

export function shamirRecoveryProvider(): NoydbShamir {
  return {
    splitToShares: (secret, k, n) => splitSecret(secret, k, n).map(encodeShareBase32),
    combineShares: (shares) => combineSecret(shares.map(decodeShareBase32)),
  }
}
