/**
 * k-of-n aggregate for matchGroup (§3). Deliberately a full scan that
 * never breaks: per-member results must never influence control flow in
 * a way an observer could time or decompose. Returns ONLY the aggregate.
 * @module
 */
export function evaluateKofN(results: readonly boolean[], min: number): boolean {
  if (!Number.isInteger(min) || min < 1 || min > results.length) {
    throw new Error(
      `evaluateKofN: min ${min} out of range 1..${results.length} — caller bug ` +
      `(matchGroup validates bounds up front, before any PBKDF2)`,
    )
  }
  let count = 0
  for (const r of results) {
    if (r) count += 1 // no short-circuit — collect, never break
  }
  return count >= min
}
