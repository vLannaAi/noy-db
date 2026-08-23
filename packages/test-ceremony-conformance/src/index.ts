/**
 * **@noy-db/test-ceremony-conformance** — the `SlotRewrapCeremony` contract,
 * published as an executable suite.
 *
 * A `rotateSecret` that preserves a tier-2 slot hands each ceremony a
 * {@link SlotRewrapContext} and takes back `EnrollAuthenticatorOptions`, which
 * hub then persists atomically with the rotation. Everything hub validates
 * about that return value — and everything a ceremony must refuse — is the
 * same for every method. This is that shared half, so `on-password`,
 * `on-webauthn` and any third-party method answer the same questions.
 *
 * ## Why the fixture is not just a ceremony
 *
 * Two of the six properties are **unobservable from a single ceremony**:
 *
 *  - **Refusal.** "Rejects a slot of another method" needs a slot of another
 *    method. A ceremony handed only its own slots always succeeds, and a
 *    suite that only ever passes it valid input reports nothing about the
 *    guard hub relies on to prevent a slot-type swap mid-rotation.
 *  - **Freshness.** "Wrapped `ctx.newDeks`, not the old set" needs the wrap
 *    to be OPENED again, which only the method can do.
 *
 * So `wrongMethodSlot` is REQUIRED and `unwrap` is optional-but-reported: a
 * kit that quietly skipped its most valuable case would be the "green run
 * with a red job inside" in test form. When `unwrap` is absent the suite says
 * so in the test name, so a reader sees the hole in the output rather than
 * inferring coverage from a row count.
 *
 * ## What this suite does NOT cover
 *
 * Method-specific behaviour stays in the package: PRF vs rawId fallback,
 * password strength rules, credential cancellation. Those are real and tested
 * where they live. A conformance kit that grew them would stop being portable
 * to a method nobody has written yet.
 *
 * ## Why this binds `/on` rather than the root barrel
 *
 * Five types, and before `/on` existed they were scattered: three on `/team`,
 * and `KeyringAuthenticator` / `EnclaveKey` reachable only from the whole
 * library root. A third-party unlock method had to import all of
 * `@noy-db/hub` to name the signature of one ceremony.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest'
import type {
  SlotRewrapCeremony,
  SlotRewrapContext,
  KeyringAuthenticator,
  EnrollAuthenticatorOptions,
  EnclaveKey,
} from '@noy-db/hub/on'

/** Everything an implementation must supply to be checked against the contract. */
export interface CeremonyFixture {
  /** The method this ceremony handles — must equal what it preserves. */
  readonly method: string
  /**
   * A ready-to-run ceremony. Called once per case, so an implementation that
   * captures a secret in a closure (all shipped ones do) is not shared
   * between cases.
   */
  ceremony(): SlotRewrapCeremony
  /** A slot this ceremony accepts: right `method`, right `wrapKind`. */
  oldSlot(): Promise<KeyringAuthenticator> | KeyringAuthenticator
  /**
   * A slot this ceremony must REFUSE, differing from {@link oldSlot} in
   * `method` and NOTHING ELSE — same `wrapKind` in particular.
   *
   * Required, because refusal cannot be observed from a ceremony's own slots.
   * The single-difference rule is enforced below and was learned the hard
   * way: a fixture whose wrong-method slot ALSO had a different `wrapKind`
   * still threw, from the wrapKind guard, so deleting the method check
   * changed nothing and the suite stayed green. Two differences means the
   * case proves only that *something* rejected it.
   */
  wrongMethodSlot(): Promise<KeyringAuthenticator> | KeyringAuthenticator
  /**
   * Re-open what the returned options wrapped, so the suite can prove the
   * ceremony used `ctx.newDeks` rather than carrying the stale set forward.
   * Only the method can do this, so it is optional — and its absence is
   * REPORTED in the test name rather than passed over.
   */
  unwrap?(options: EnrollAuthenticatorOptions): Promise<Map<string, EnclaveKey>>
}

async function makeKey(): Promise<EnclaveKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]) as Promise<EnclaveKey>
}

/** A context with a FRESH DEK set, which is the whole point of a rewrap. */
async function makeContext(oldSlot: KeyringAuthenticator): Promise<SlotRewrapContext> {
  const newDeks = new Map<string, EnclaveKey>([
    ['invoices', await makeKey()],
    ['clients', await makeKey()],
  ])
  return { newKek: await makeKey(), newDeks, oldSlot }
}

/**
 * Run the shared `SlotRewrapCeremony` contract against one implementation.
 *
 * @param name - shown in the suite title, e.g. `'on-password'`.
 */
export function runCeremonyConformanceTests(name: string, fixture: CeremonyFixture): void {
  describe(`${name} — SlotRewrapCeremony conformance`, () => {
    it('1. returns options that preserve the slot id', async () => {
      const slot = await fixture.oldSlot()
      const out = await fixture.ceremony()(await makeContext(slot))
      // Hub validates this itself and throws on mismatch. Asserted here too
      // because a ceremony that gets it wrong should fail in ITS OWN suite,
      // not in a rotation weeks later.
      expect(out.id).toBe(slot.id)
    })

    it('2. returns options that preserve the method', async () => {
      const slot = await fixture.oldSlot()
      const out = await fixture.ceremony()(await makeContext(slot))
      expect(out.method).toBe(slot.method)
      expect(out.method).toBe(fixture.method)
    })

    it('3. returns options that preserve the EFFECTIVE wrap kind', async () => {
      const slot = await fixture.oldSlot()
      const out = await fixture.ceremony()(await makeContext(slot))
      // Compared on the EFFECTIVE value, not the literal field. `wrapKind` is
      // `?: 'kek'` on the wrap-KEK variant and a required `'deks'` on the
      // other, so an absent field legally means 'kek' and hub persists it as
      // such.
      //
      // The first version of this case asserted `out.wrapKind` directly. It
      // passed — because on-password, the only binding at the time, MUST set
      // the field explicitly. Wiring a second implementation is what exposed
      // it: on-webauthn omits it, correctly, and the kit called that a
      // failure. A conformance suite written against one implementation
      // encodes that implementation's incidental shape as the contract.
      //
      // A wrap-KEK slot silently becoming wrap-DEKs (or the reverse) really
      // does change what the slot can unlock — that is the property here, and
      // it survives the correction.
      expect(out.wrapKind ?? 'kek').toBe(slot.wrapKind ?? 'kek')
    })

    it('4. REFUSES a slot belonging to another method', async () => {
      const slot = await fixture.oldSlot()
      const other = await fixture.wrongMethodSlot()
      expect(other.method).not.toBe(fixture.method)
      // The fixture contract, asserted rather than trusted: if the refusal
      // case differs in more than the method, a passing result does not say
      // the METHOD guard works — some other guard may be doing the rejecting.
      expect(
        other.wrapKind,
        'wrongMethodSlot must differ from oldSlot in `method` alone — a second difference lets another guard absorb the case',
      ).toBe(slot.wrapKind)
      await expect(fixture.ceremony()(await makeContext(other))).rejects.toThrow()
    })

    it('5. refuses without mutating the context it was handed', async () => {
      const other = await fixture.wrongMethodSlot()
      const ctx = await makeContext(other)
      const before = [...ctx.newDeks.keys()].sort()
      await expect(fixture.ceremony()(ctx)).rejects.toThrow()
      // A ceremony that half-applies before validating leaves the caller
      // holding a context it cannot safely retry with.
      expect([...ctx.newDeks.keys()].sort()).toEqual(before)
    })

    const freshness = fixture.unwrap
      ? '6. wraps the NEW dek set, not the old one'
      : '6. SKIPPED — no `unwrap` in the fixture, so freshness is UNVERIFIED here'

    it(freshness, async () => {
      const unwrap = fixture.unwrap
      if (!unwrap) {
        // Deliberately passes, loudly. The alternative — omitting the case —
        // makes an unverified property indistinguishable from a verified one.
        expect(unwrap).toBeUndefined()
        return
      }
      const slot = await fixture.oldSlot()
      const ctx = await makeContext(slot)
      const out = await fixture.ceremony()(ctx)
      const wrapped = await unwrap(out)
      expect([...wrapped.keys()].sort()).toEqual([...ctx.newDeks.keys()].sort())
      for (const [collection, expected] of ctx.newDeks) {
        const got = wrapped.get(collection)
        expect(got, `${collection} missing from the rewrapped set`).toBeDefined()
        // Compare the raw bytes: two AES keys are not `===`, and an
        // identity check would pass on any key at all.
        const a = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', expected))
        const b = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', got!))
        expect([...b], `${collection} was wrapped from the wrong key`).toEqual([...a])
      }
    })
  })
}
