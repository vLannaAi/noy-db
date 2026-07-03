/**
 * Deterministic hash of a derivation strategy's "shape": source
 * collection, declared sibling sources, output keys, derive function
 * source. Used to detect
 * strategy drift: a record whose `_derivedFrom.strategyHash` doesn't
 * match the current strategy is considered stale.
 *
 * Web Crypto SHA-256 — no extra deps.
 */
import { sha256Hex } from '../../kernel/enclave/index.js'

export async function computeStrategyHash(
  source: string,
  outputKeys: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  derive: (...args: any[]) => any,
  sources?: ReadonlyArray<string>,
): Promise<string> {
  const canonical = JSON.stringify({
    source,
    outputs: [...outputKeys].sort(),
    derive: derive.toString(),
    // Declared sibling sources — adding/removing a trigger
    // collection invalidates cached derived records. Omitted when empty
    // so strategies without siblings keep their existing hash.
    ...(sources?.length ? { sources: [...sources].sort() } : {}),
  })
  const bytes = new TextEncoder().encode(canonical)
  return sha256Hex(bytes)
}
