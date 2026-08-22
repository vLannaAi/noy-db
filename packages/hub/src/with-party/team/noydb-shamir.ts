/**
 * String-level Shamir provider injected into hub for `profile: 'shamir'`
 * recovery. Keeps hub free of any `@noy-db/on-shamir` import — hub never
 * sees `RawShare` or the share codecs. Implemented by
 * `shamirRecoveryProvider()` from `@noy-db/on-shamir`.
 */
export interface NoydbShamir {
  /** Split `secret` into `n` base32 share strings; any `k` recombine it. */
  splitToShares(secret: Uint8Array, k: number, n: number): string[]
  /**
   * Recombine `k`+ share strings into the secret. MUST throw on malformed,
   * truncated, insufficient, or mismatched shares.
   */
  combineShares(shares: readonly string[]): Uint8Array
}
