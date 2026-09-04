/**
 * Bounded-size sketches for the coverage sensor (#1363).
 *
 * ⚠️ THE WHOLE POINT OF A SKETCH HERE IS WHAT IT CANNOT DO. Coverage state
 * answers *"how much of this corpus has this principal seen"*, and the exact
 * answer — the id set — is a SECOND COPY OF THE SENSITIVE SET. A sensor built
 * to notice bulk extraction would then be the best single artefact to extract.
 * So no structure in this module retains a record id, and none can be
 * enumerated back into one: HyperLogLog keeps per-register leading-zero ranks,
 * Bloom keeps bits. Both are lossy on purpose, and the accuracy that costs is
 * the price of the property (`no-record-ids.test.ts` pins it).
 *
 * @module
 */

/** 32-bit FNV-1a. Not cryptographic — a sketch only needs good dispersion. */
function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Final avalanche (murmur3 fmix32) — FNV alone disperses low bits poorly,
  // and HLL reads the TOP bits for the register index.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

// ─── HyperLogLog — distinct ids ever decrypted ────────────────────────────

/**
 * HyperLogLog over `2^precision` one-byte registers.
 *
 * ⭐ SIZING IS THE OPEN QUESTION THIS FEATURE SHIPS WITH, not a settled
 * default. At the scale the design anticipates (~1k records, ~30 principals)
 * the estimator runs entirely in its LINEAR-COUNTING range, where accuracy is
 * a function of load factor rather than of HLL's asymptotic 1.04/√m. So the
 * default is chosen by MEASUREMENT, not theory — `__tests__/coverage/sketch.test.ts`
 * pins the error band this implementation actually produces:
 *
 * | distinct ids | p=10 (1 KiB) | p=12 (4 KiB) | **p=14 (16 KiB, default)** |
 * |---:|---:|---:|---:|
 * | 100    | 3.00% | 1.00% | **0.00%** |
 * | 1 000  | 2.90% | 0.50% | **0.40%** |
 * | 10 000 | 2.34% | 5.62% | **0.96%** |
 * | 50 000 | 2.31% | 1.70% | **1.52%** |
 *
 * (p=12's 5.62% at 10 000 is the linear-counting/raw-estimator crossover, and
 * is exactly why the default is not chosen from the memory column.)
 * 16 KiB is per `(principal, vault, collection)` — a ~30-principal deployment
 * with a handful of bulk-declared collections stays in the low megabytes.
 * `precision` is configurable for a deployment whose corpus is a different
 * order of magnitude.
 *
 * ⛔ An exact per-collection bitmap would be smaller AND exact at that scale.
 * It is not shipped because it leaks ids: bit *i* set means "record *i* was
 * read", which is the second copy this module exists to avoid. Revisit only
 * against a real dataset, and only with that trade stated.
 */
export class HyperLogLog {
  readonly precision: number
  private readonly registers: Uint8Array

  constructor(precision = 14) {
    if (!Number.isInteger(precision) || precision < 4 || precision > 16) {
      throw new RangeError(`HyperLogLog precision must be an integer in [4,16], got ${precision}`)
    }
    this.precision = precision
    this.registers = new Uint8Array(1 << precision)
  }

  add(id: string): void {
    const h = fnv1a(id)
    const idx = h >>> (32 - this.precision)
    // Rank = 1 + leading zeros of the remaining bits (bounded by the width).
    const rest = (h << this.precision) >>> 0
    const rank = rest === 0 ? 32 - this.precision + 1 : Math.clz32(rest) + 1
    if (rank > this.registers[idx]!) this.registers[idx] = rank
  }

  /** Estimated distinct count. */
  count(): number {
    const m = this.registers.length
    let zeros = 0
    let sum = 0
    for (let i = 0; i < m; i++) {
      const r = this.registers[i]!
      if (r === 0) zeros++
      sum += 2 ** -r
    }
    const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m)
    const raw = (alpha * m * m) / sum
    // Small-range correction: linear counting, which is where a ~1k corpus
    // lives. This is the branch the pilot's scale actually exercises.
    if (raw <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros))
    return Math.round(raw)
  }

  /** Serializable state — registers only. No id, no id-derived key. */
  toJSON(): { readonly p: number; readonly r: string } {
    let bin = ''
    for (const b of this.registers) bin += String.fromCharCode(b)
    return { p: this.precision, r: btoa(bin) }
  }

  static fromJSON(state: { readonly p: number; readonly r: string }): HyperLogLog {
    const hll = new HyperLogLog(state.p)
    const bin = atob(state.r)
    for (let i = 0; i < hll.registers.length && i < bin.length; i++) {
      hll.registers[i] = bin.charCodeAt(i)
    }
    return hll
  }
}

// ─── Bloom — novelty within one window ────────────────────────────────────

/**
 * Bloom filter for *novelty per window* — "have I seen this id in this
 * window?". False positives under-report novelty (a novel read is scored as a
 * repeat), which is the safe direction for a sensor that must not cry wolf;
 * false negatives are impossible.
 */
export class BloomFilter {
  readonly bits: number
  readonly hashes: number
  private readonly words: Uint32Array

  constructor(bits = 1 << 14, hashes = 7) {
    if (!Number.isInteger(bits) || bits < 64) throw new RangeError(`Bloom bits must be >= 64, got ${bits}`)
    if (!Number.isInteger(hashes) || hashes < 1 || hashes > 16) {
      throw new RangeError(`Bloom hashes must be in [1,16], got ${hashes}`)
    }
    this.bits = bits
    this.hashes = hashes
    this.words = new Uint32Array(Math.ceil(bits / 32))
  }

  /** Set the id's bits; returns true when the id was NOT already present. */
  addIfAbsent(id: string): boolean {
    const h1 = fnv1a(id)
    const h2 = fnv1a(id, 0x9e3779b1) | 1
    let novel = false
    for (let i = 0; i < this.hashes; i++) {
      const bit = (h1 + Math.imul(i, h2)) >>> 0
      const pos = bit % this.bits
      const w = pos >>> 5
      const mask = 1 << (pos & 31)
      if ((this.words[w]! & mask) === 0) {
        this.words[w] = this.words[w]! | mask
        novel = true
      }
    }
    return novel
  }

  clear(): void {
    this.words.fill(0)
  }
}
