/**
 * **@noy-db/test-format-conformance** — the `as-*` export gate, published as
 * an executable suite.
 *
 * The `as-*` family is the one place plaintext leaves the vault. Each package
 * calls `vault.assertCanExport('plaintext', <format>)` before producing
 * anything, and that call is the whole security boundary: a projection that
 * skips it hands out decrypted records to a caller the vault would have
 * refused.
 *
 * Nothing enforced it. Nine packages had converged on the same shape by
 * convention — `toString`/`toBytes`, `download`, `write` — and convention is
 * what the next format author reads instead of a contract.
 *
 * ## Gated is not the property. Gated BEFORE decrypting is.
 *
 * A gate called after `exportStream` has already run is a gate that refuses
 * the caller and decrypts anyway. So the suite asserts BOTH:
 *
 *   - every export entry point REJECTS when `assertCanExport` throws, and
 *   - it rejects having read NOTHING — `exportStream` is never called.
 *
 * The second is the one a delegation refactor breaks silently: move the gate
 * from `toObject` into `download` and every existing test still passes.
 *
 * ## Why a Proxy and not a fake Vault
 *
 * `Vault` is large, and a hand-written double would drift from it — and worse,
 * would only ever exercise the methods whoever wrote the double thought of.
 * The fixture supplies a REAL vault; the kit wraps it, so an entry point that
 * reaches for some other decrypting method is still observed.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest'
import type { Vault, ExportFormat } from '@noy-db/hub'

/** One plaintext-producing entry point, named as a consumer would call it. */
export interface FormatEntryPoint {
  /** Exported function name, e.g. `'toString'`. Used in the test title. */
  readonly name: string
  /** Call it against the supplied vault. Arguments are the fixture's business. */
  run(vault: Vault): Promise<unknown>
}

/** Everything an `as-*` package must supply to be checked against the gate. */
export interface FormatFixture {
  /**
   * The TIER the package passes to `assertCanExport`. The `as-*` family is
   * two capability classes, not one — discovered by wiring `as-noydb`, which
   * calls `assertCanExport('bundle')` and never mentions plaintext because it
   * emits an encrypted pod. A kit that assumed one tier would have made that
   * fixture describe itself wrongly while still passing.
   */
  readonly tier: 'plaintext' | 'bundle'
  /**
   * The format tag, e.g. `'csv'`. REQUIRED for the plaintext tier and
   * meaningless for `bundle` — hub itself throws when a plaintext check
   * arrives without one, so the pairing is asserted rather than assumed.
   */
  readonly format?: ExportFormat
  /**
   * A REAL vault with at least one record. Built fresh per case, so an entry
   * point that mutates it cannot leak into the next assertion.
   */
  vault(): Promise<Vault>
  /**
   * EVERY entry point that can produce plaintext — not a representative one.
   * A format with four exports and one listed here reports a green suite for
   * the three nobody checked.
   */
  readonly exports: ReadonlyArray<FormatEntryPoint>
  /**
   * The on-disk write path, if the package has one. It must refuse without
   * `acknowledgeRisks: true`; pass a call that OMITS the flag.
   *
   * The vault this receives is the fixture's own — NOT the denying proxy —
   * and it must be export-CAPABLE. A vault that would refuse the export
   * anyway makes the case unfalsifiable: the refusal arrives from the gate
   * upstream and the acknowledgement is never reached. That is not
   * hypothetical; it is what the first version of this kit did, and deleting
   * the acknowledgement guard from as-csv left the suite green.
   */
  writeWithoutAcknowledgement?: (vault: Vault, path: string) => Promise<unknown>
}

/** Thrown by the denying proxy so a refusal is attributable to the gate. */
export class ExportDeniedByConformanceKit extends Error {
  constructor(tier: string, format?: string) {
    super(`conformance: assertCanExport denied '${tier}'${format ? ` / '${format}'` : ''}`)
    this.name = 'ExportDeniedByConformanceKit'
  }
}

interface Observation {
  decryptCalls: string[]
}

/**
 * Wrap a real vault so `assertCanExport` denies, and every method that could
 * yield plaintext records is recorded.
 *
 * `exportStream` is named explicitly because it is the shared read path; the
 * catch-all records any other function property that gets invoked, so an entry
 * point taking a different route is still visible rather than silently
 * unobserved.
 */
function denyingVault(real: Vault, tier: string, format: string | undefined, seen: Observation): Vault {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'assertCanExport') {
        return () => {
          throw new ExportDeniedByConformanceKit(tier, format)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          if (prop === 'exportStream' || prop === 'export' || prop === 'snapshot') {
            seen.decryptCalls.push(prop)
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  }) as Vault
}

/**
 * Run the shared `as-*` export-gate contract against one format.
 *
 * @param name - shown in the suite title, e.g. `'as-csv'`.
 */
export function runFormatConformanceTests(name: string, fixture: FormatFixture): void {
  describe(`${name} — as-* export gate conformance`, () => {
    it('declares a tier, and a format iff the tier needs one', () => {
      // Hub throws on `assertCanExport('plaintext')` with no format, so a
      // fixture in that state describes a call the package cannot be making.
      if (fixture.tier === 'plaintext') {
        expect(fixture.format, 'the plaintext tier requires a format').toBeTruthy()
      } else {
        expect(fixture.format, `the '${fixture.tier}' tier takes no format`).toBeUndefined()
      }
    })

    it('declares at least one export entry point', () => {
      // A fixture with an empty list would pass every case below without
      // running anything — a live suite iterating an empty array.
      expect(fixture.exports.length).toBeGreaterThan(0)
    })

    it('the fixture vault CAN export — otherwise every refusal below is free', async () => {
      // The whole suite tests refusals, and a refusal is only evidence when
      // the same call would otherwise SUCCEED. A fixture whose `format` tag
      // does not match what the package passes to `assertCanExport` — or
      // which forgets the `exportCapability` grant — makes every case below
      // pass by refusing for the wrong reason, and nothing in the output
      // distinguishes that from a working gate.
      const vault = await fixture.vault()
      await expect(
        fixture.exports[0]!.run(vault),
        `${fixture.exports[0]!.name} failed on an ungated vault — check the \`format\` tag and the exportCapability grant`,
      ).resolves.toBeDefined()
    })

    for (const entry of fixture.exports) {
      it(`${entry.name}: REFUSES when assertCanExport denies`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyingVault(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow()
      })

      it(`${entry.name}: refuses BEFORE reading any record`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyingVault(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow()
        // The property that a delegation refactor breaks silently: a gate
        // moved downstream still refuses the caller, having already decrypted.
        expect(
          seen.decryptCalls,
          `${entry.name} read records before the export gate refused`,
        ).toEqual([])
      })
    }

    const writeTitle = fixture.writeWithoutAcknowledgement
      ? 'write: REFUSES without acknowledgeRisks'
      : 'write: SKIPPED — fixture declares no acknowledgement case, so the plaintext-on-disk gate is UNVERIFIED here'

    it(writeTitle, async () => {
      const write = fixture.writeWithoutAcknowledgement
      if (!write) {
        // Passes loudly. Omitting the case would make an unchecked security
        // gate indistinguishable from a checked one in the output.
        expect(write).toBeUndefined()
        return
      }
      const vault = await fixture.vault()
      // Matched on the MESSAGE, not merely on "it threw". `rejects.toThrow()`
      // alone passes when the export gate refuses first — which is exactly
      // what happened here before this line existed, and it made the case
      // unable to fail. The flag name is the one string every such message
      // contains by construction.
      await expect(write(vault, '/tmp/conformance-should-not-exist')).rejects.toThrow(
        /acknowledgeRisks/i,
      )
    })
  })
}
