/**
 * The roster epoch: minting and comparison (#1097).
 *
 * ## What this closes, and what it does not
 *
 * A roster tag authenticates the roster's CONTENTS. It makes no claim about
 * being CURRENT, and that gap is reachable without forging anything: there is
 * no role-change API, so narrowing a user's standing means calling `grant`
 * again with a lower role, and the keyring write overwrites in place. The
 * previous, broader file was legitimately minted by this vault. A store that
 * kept a copy re-serves it; the KEK unwraps, the canary checks out, the tag
 * verifies, and the replayed file restores the higher role — usably, not
 * cosmetically.
 *
 * The ROTATION half of #1097 already shipped: rotating the collections a
 * narrowing drops restores the bound ADR 0003 assumed, so the old file's DEKs
 * no longer open anything written since. That converts live access back into
 * stale access. It cannot touch the role, because role gates capabilities
 * rather than keys.
 *
 * ## Why the epoch needs a second channel
 *
 * An epoch stored beside the roster is not an anchor: a store rewinding the
 * roster rewinds the epoch with it. It becomes an anchor only when the reader
 * holds an expected value that arrived by a channel the store does not carry.
 * Hub owns the epoch and the comparison; **who carries the expectation is
 * deliberately not hub's business**, because hub cannot know which channel a
 * deployment trusts.
 *
 * Candidates considered and REJECTED for that anchor, recorded so they are not
 * re-derived:
 *
 *   - **Time.** Defeats long rewinds and is useless against fresh ones — and a
 *     narrowing replay is entirely the fresh case.
 *   - **The vault head.** Circular: head buckets are read with a
 *     keyring-issued DEK, and a rewound roster renders as the benign
 *     `no-expectations` verdict.
 *
 * @module
 */

import { KeyringTamperedError } from '../../kernel/errors.js'

/**
 * Refuse a keyring whose roster epoch is older than the caller expects.
 *
 * OPT-IN: with no `expected` this is a no-op, and the caller is exactly as
 * exposed as before. Deliberate — a deployment with no second channel has
 * nothing to compare against, and inventing a comparison would be worse than
 * declining to make one.
 *
 * ⚠️ **An absent epoch is UNKNOWN, never zero.** Every keyring written before
 * the epoch existed has none, and those are precisely the files a replay would
 * serve. Treating absence as `0` would accept all of them and defeat the
 * mechanism while appearing to work. Same rule as `NOYDB_ENVELOPE_GENERATION`,
 * and the same reason: absence is a statement about the WRITER, not the value.
 *
 * `found > expected` is ACCEPTED. The expectation is a FLOOR, not an equality:
 * an out-of-band anchor is minted at a moment in time and the roster may
 * legitimately have moved on. Requiring equality would refuse healthy vaults
 * after any grant or revoke, which is the fastest way to get a security check
 * switched off.
 */
export function assertRosterEpochCurrent(
  found: number | undefined,
  expected: number | undefined,
  userId: string,
): void {
  if (expected === undefined) return
  if (found === undefined) {
    throw new KeyringTamperedError({ userId, reason: 'roster-epoch-absent' })
  }
  if (!Number.isFinite(found) || found < expected) {
    throw new KeyringTamperedError({ userId, reason: 'roster-epoch-rewound' })
  }
}

/**
 * The next epoch for a roster write — monotonic, never silently restarting.
 *
 * A write that reused or lowered an epoch would mint a file the comparison
 * above cannot distinguish from a replay, so this is the only sanctioned way
 * to produce one. `undefined` in — a file that predates the mechanism, or a
 * brand-new keyring — starts the line at 1 rather than 0, so that "has an
 * epoch" is never confusable with falsy.
 */
export function nextRosterEpoch(current: number | undefined): number {
  return Number.isFinite(current) ? (current as number) + 1 : 1
}
