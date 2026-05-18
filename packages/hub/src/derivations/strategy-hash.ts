/**
 * Deterministic hash of a derivation strategy's "shape": source
 * collection, output keys, derive function source. Used to detect
 * strategy drift: a record whose `_derivedFrom.strategyHash` doesn't
 * match the current strategy is considered stale.
 *
 * Web Crypto SHA-256 — no extra deps.
 */
export async function computeStrategyHash(
  source: string,
  outputKeys: readonly string[],
  derive: (...args: any[]) => any,
): Promise<string> {
  const canonical = JSON.stringify({
    source,
    outputs: [...outputKeys].sort(),
    derive: derive.toString(),
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
