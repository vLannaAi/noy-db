/**
 * **@noy-db/test-format-conformance** — the `as-*` export/import gate,
 * published as an executable suite.
 *
 * The `as-*` family is the one place plaintext leaves the vault. Every export
 * is gated by `vault.assertCanExport(tier, format)` before producing anything,
 * and that call is the whole security boundary: a projection that skips it
 * hands out decrypted records to a caller the vault would have refused. The
 * import side is `vault.assertCanImport`, gating what may be planned INTO a
 * vault.
 *
 * ## Two entry-point shapes, one contract
 *
 * The 0.7 line inverted four formats: the entry point moved from a function
 * taking the vault as an ARGUMENT (`toString(vault, opts)`) to a METHOD ON the
 * vault (`vault.export(asCsv(), {})`). Both shapes carry the same obligation,
 * and this kit checks both with one mechanism — see the next section, because
 * getting that mechanism wrong is precisely how this kit went blind once.
 *
 * ## Gated is not the property. Gated BEFORE decrypting is.
 *
 * A gate called after `exportStream` has already run is a gate that refuses
 * the caller and decrypts anyway. So the suite asserts BOTH:
 *
 *   - every entry point REJECTS when the gate denies — and rejects with THIS
 *     KIT'S OWN ERROR, so the refusal is attributable to the gate rather than
 *     to a miswired fixture throwing something else; and
 *   - it rejects having read NOTHING — `exportStream` is never called.
 *
 * The second is the one a delegation refactor breaks silently: move the gate
 * downstream and every existing test still passes.
 *
 * ## Why the kit PATCHES THE INSTANCE, and no longer proxies it (#1209)
 *
 * The first version wrapped the vault in a `Proxy` whose `get` trap replaced
 * `assertCanExport`, forwarding calls with `value.apply(target, args)`. That
 * works when the entry point takes the vault as an argument — the package
 * calls `proxy.assertCanExport(...)` and the trap fires. It CANNOT work for a
 * method on the vault: `vault.export` runs with `this` bound to the real
 * object (`apply(receiver, …)` is not an option — `Vault` has private fields,
 * and a Proxy receiver breaks private-field access), so the gate it consults
 * is the unproxied one and the denial is silently bypassed. Both assertions
 * passed vacuously; nothing turned red.
 *
 * Patching own properties onto the REAL instance intercepts both shapes,
 * because property lookup happens at call time and an own property shadows the
 * prototype method — including for hub's own INTERNAL delegation
 * (`exportJSON()` calls `this.exportStream(...)`, which the Proxy never saw
 * and the patch does). Private fields keep working because it IS the real
 * object. The patch mutates the fixture's vault, which is why `vault()` must
 * build a fresh one per case — a requirement the fixture already carries.
 *
 * If hub ever routes its gate around `vault.assertCanExport` (say, by inlining
 * the capability check), this mechanism fails LOUD — the ungated call
 * succeeds, the denial test goes red — not silent. That is the acceptable
 * failure direction.
 *
 * ## What is observed, and what deliberately is not
 *
 * `exportStream` is the decrypting PRIMITIVE, and the only method recorded.
 * `vault.export` / `vault.import` are NOT recorded: under the inverted shape
 * they are the entry points themselves (and `download`/`write` call
 * `vault.export` internally), so recording them would fail every correct
 * inverted format spuriously. The first version also recorded a `snapshot`
 * method that `Vault` does not have — a guessed identifier, which is a query
 * that cannot falsify. The list is now exactly the primitives that exist.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest'
import type { Vault, ExportFormat } from '@noy-db/hub'

/** One plaintext-producing entry point, named as a consumer would call it. */
export interface FormatEntryPoint {
  /** Shown in the test title, e.g. `'toString'` or `'vault.export'`. */
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
   * point that mutates it cannot leak into the next assertion — and because
   * the kit PATCHES the instance it is handed, reuse would leak the patch.
   *
   * For a format using the inverted shape (`vault.export(...)`), the vault
   * must be created with `formatsStrategy: withFormats()` — without it the
   * CAN-export guard fails with `FormatsNotEnabledError` before proving
   * anything about the fixture's grants.
   */
  vault(): Promise<Vault>
  /**
   * EVERY plaintext-producing export entry point — not a representative one.
   * A format with four exports and one listed here reports a green suite for
   * the three nobody checked.
   */
  readonly exports: ReadonlyArray<FormatEntryPoint>
  /**
   * Import entry points (`vault.import(...)`, legacy `fromString`), gated by
   * `assertCanImport`. Optional because not every format decodes — but a
   * format that ships a `decode` and declares no imports here is reporting a
   * green suite for a gate nobody checked, and the suite says so out loud.
   *
   * The fixture's vault must hold an `importCapability` grant for the format,
   * or the denial case is unfalsifiable: the refusal arrives from the missing
   * grant rather than from the kit's denial, and nothing distinguishes that
   * from a working gate.
   */
  readonly imports?: ReadonlyArray<FormatEntryPoint>
  /**
   * The on-disk write path, if the package has one. It must refuse without
   * `acknowledgeRisks: true`; pass a call that OMITS the flag.
   *
   * The vault this receives is the fixture's own — NOT a denying one — and it
   * must be export-CAPABLE. A vault that would refuse the export anyway makes
   * the case unfalsifiable: the refusal arrives from the gate upstream and the
   * acknowledgement is never reached. That is not hypothetical; it is what the
   * first version of this kit did, and deleting the acknowledgement guard from
   * as-csv left the suite green.
   */
  writeWithoutAcknowledgement?: (vault: Vault, path: string) => Promise<unknown>
}

/**
 * Thrown by the kit's denial patch so a refusal is ATTRIBUTABLE to the gate.
 *
 * The denial tests match on this class, not on "it threw". A bare
 * `rejects.toThrow()` passes on any error — a miswired fixture raising
 * `TypeError`, a vault missing `withFormats()` — which is exactly the state a
 * brand-new fixture is most likely to be in. The first version of this kit
 * defined this class for that purpose and then never matched on it.
 */
export class ExportDeniedByConformanceKit extends Error {
  constructor(gate: 'export' | 'import', tier: string, format?: string) {
    super(`conformance: assertCan${gate === 'export' ? 'Export' : 'Import'} denied '${tier}'${format ? ` / '${format}'` : ''}`)
    this.name = 'ExportDeniedByConformanceKit'
  }
}

interface Observation {
  decryptCalls: string[]
}

/**
 * Patch a REAL vault in place: both gates deny with the kit's own error, and
 * the decrypting primitive is recorded. Returns the same instance.
 *
 * Own-property assignment shadows the prototype methods, so the patch fires
 * for the argument shape (`toString(vault)` → `vault.assertCanExport(...)`),
 * the inverted shape (`vault.export(...)` → `contextFor(this)` → property
 * lookup at call time), and hub's internal delegation (`exportJSON()` →
 * `this.exportStream(...)`).
 */
function denyGates(vault: Vault, tier: string, format: string | undefined, seen: Observation): Vault {
  const v = vault as unknown as Record<string, unknown>
  v['assertCanExport'] = () => {
    throw new ExportDeniedByConformanceKit('export', tier, format)
  }
  v['assertCanImport'] = () => {
    throw new ExportDeniedByConformanceKit('import', tier, format)
  }
  const realStream = (vault.exportStream as (...a: unknown[]) => unknown).bind(vault)
  v['exportStream'] = (...args: unknown[]) => {
    seen.decryptCalls.push('exportStream')
    return realStream(...args)
  }
  return vault
}

/**
 * Run the shared `as-*` gate contract against one format.
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

    for (const entry of fixture.exports) {
      it(`${entry.name}: SUCCEEDS on an ungated vault — otherwise its refusal below is free`, async () => {
        // Per ENTRY, not only exports[0]: a refusal is only evidence when the
        // same call would otherwise succeed, and each entry point can be
        // miswired independently. A fixture whose `format` tag does not match
        // what the package passes — or which forgets the exportCapability
        // grant, or omits `formatsStrategy: withFormats()` on an inverted
        // vault — makes the denial pass by refusing for the wrong reason.
        const vault = await fixture.vault()
        // `toSatisfy(() => true)`, not `toBeDefined()`: `download`/`write`
        // return Promise<void>, and their resolved value is legitimately
        // undefined. The assertion is "it RESOLVES" — the guard is about the
        // call not refusing, not about what it returns. (Found the moment this
        // guard went per-entry; the old exports[0]-only guard happened to
        // always land on a value-returning entry.)
        await expect(
          entry.run(vault),
          `${entry.name} failed on an ungated vault — check the \`format\` tag, the exportCapability grant, and (for vault.export entries) formatsStrategy: withFormats()`,
        ).resolves.toSatisfy(() => true)
      })

      it(`${entry.name}: REFUSES when assertCanExport denies — with the KIT'S error`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        // Matched on the class: a bare toThrow() passes on ANY error, which
        // makes a miswired fixture indistinguishable from a working gate.
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
      })

      it(`${entry.name}: refuses BEFORE reading any record`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
        // The property that a delegation refactor breaks silently: a gate
        // moved downstream still refuses the caller, having already decrypted.
        expect(
          seen.decryptCalls,
          `${entry.name} read records before the export gate refused`,
        ).toEqual([])
      })
    }

    const importEntries = fixture.imports ?? []
    const importTitle = importEntries.length
      ? null
      : 'imports: SKIPPED — fixture declares none, so the assertCanImport gate is UNVERIFIED here'
    if (importTitle) {
      it(importTitle, () => {
        // Passes loudly. A format that ships a `decode` and declares no import
        // entries is leaving a gate unchecked, and the output should say so
        // rather than staying quiet — a documented absence, not a hole.
        expect(importEntries).toEqual([])
      })
    }

    for (const entry of importEntries) {
      it(`${entry.name}: SUCCEEDS on an ungated vault — otherwise its refusal below is free`, async () => {
        // Same falsifiability requirement as the export side: without an
        // importCapability grant the denial case refuses for the wrong reason.
        const vault = await fixture.vault()
        await expect(
          entry.run(vault),
          `${entry.name} failed on an ungated vault — check the importCapability grant`,
        ).resolves.toSatisfy(() => true)
      })

      it(`${entry.name}: REFUSES when assertCanImport denies — with the KIT'S error`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
      })

      it(`${entry.name}: refuses BEFORE reading any record`, async () => {
        // Import planning READS the vault to diff against it (`diffVault`
        // routes through `exportStream`), so a gate moved after the plan
        // decrypts before refusing — the same silent break as the export side.
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
        expect(
          seen.decryptCalls,
          `${entry.name} read records before the import gate refused`,
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
