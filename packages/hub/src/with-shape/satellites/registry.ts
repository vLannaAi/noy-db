import { SatelliteConfigError } from '../../kernel/errors.js'
import type { SatelliteSpec } from './types.js'

export class SatelliteRegistry {
  private readonly byBase = new Map<string, SatelliteSpec>()
  private readonly bySat = new Map<string, SatelliteSpec>()
  private readonly byJoin = new Map<string, SatelliteSpec>()
  private readonly poisoned = new Map<string, string>()
  private readonly locks = new Map<string, Promise<unknown>>()

  register(spec: SatelliteSpec): void {
    if (this.byBase.has(spec.base)) {
      throw new SatelliteConfigError(`R-S10: base "${spec.base}" already has satellite "${this.byBase.get(spec.base)!.satellite}" — v1 allows exactly one satellite per base.`)
    }
    // R-S3, order-inverted direction: `spec.satellite` was already declared as
    // a BASE (some other satellite is satelliteOf it) — registering it as a
    // satellite of `spec.base` too would form a satellite-of-satellite chain.
    // The other direction (satelliteOf pointing straight at a satellite) is
    // caught synchronously in validate.ts BEFORE register() is ever called.
    if (this.byBase.has(spec.satellite)) {
      throw new SatelliteConfigError(`R-S3: "${spec.satellite}" is itself registered as a base (of "${this.byBase.get(spec.satellite)!.satellite}") — no satellite-of-satellite chains.`)
    }
    const taken = (n: string) => this.byBase.has(n) || this.bySat.has(n) || this.byJoin.has(n)
    if (spec.joined !== undefined && taken(spec.joined)) {
      throw new SatelliteConfigError(`R-S5: joined name "${spec.joined}" collides with an existing pair member or joined name.`)
    }
    this.byBase.set(spec.base, spec)
    this.bySat.set(spec.satellite, spec)
    if (spec.joined !== undefined) this.byJoin.set(spec.joined, spec)
  }

  satelliteOf(base: string): SatelliteSpec | null { return this.byBase.get(base) ?? null }
  bySatellite(name: string): SatelliteSpec | null { return this.bySat.get(name) ?? null }
  byJoined(name: string): SatelliteSpec | null { return this.byJoin.get(name) ?? null }
  isPairMember(name: string): boolean { return this.byBase.has(name) || this.bySat.has(name) }
  allSpecs(): readonly SatelliteSpec[] { return [...this.byBase.values()] }

  expandNames(names: readonly string[]): string[] {
    const out = new Set(names)
    for (const n of names) {
      const asBase = this.byBase.get(n); if (asBase) out.add(asBase.satellite)
      const asSat = this.bySat.get(n); if (asSat) out.add(asSat.base)
    }
    return [...out]
  }

  poison(satellite: string, reason: string): void { this.poisoned.set(satellite, reason) }
  assertNotPoisoned(satellite: string): void {
    const reason = this.poisoned.get(satellite)
    if (reason !== undefined) throw new SatelliteConfigError(reason)
  }

  /** Per-base async mutex: chains sections on a stored promise tail. */
  async withPairLock<R>(base: string, fn: () => Promise<R>): Promise<R> {
    const tail = this.locks.get(base) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    this.locks.set(base, tail.then(() => gate))
    await tail
    try { return await fn() } finally { release() }
  }
}
