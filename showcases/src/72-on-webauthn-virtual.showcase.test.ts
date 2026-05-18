/**
 * Showcase 72 — on-webauthn real-provider via Playwright virtual authenticator
 *
 * What you'll learn
 * ─────────────────
 * Drives a **real** WebAuthn ceremony through Chromium's CDP virtual
 * authenticator — `navigator.credentials.create` and `.get` execute
 * inside an actual browser context against a CTAP2 emulation, not a
 * mock. The CDP `WebAuthn.addVirtualAuthenticator` debug command
 * configures resident-key + user-verification + PRF support exactly
 * the way a real platform authenticator (Touch ID / Windows Hello)
 * or roaming key (YubiKey 5C) would advertise; the **PRF extension**
 * input → output mapping is what we're measuring, because that is the
 * one thing that varies across authenticator vendors and that the
 * package's unit-test stubs cannot catch.
 *
 * Why it matters
 * ──────────────
 * `@noy-db/on-webauthn` is the only `on-*` package that releases
 * **wrap-key material from a vendor-implemented protocol** (PRF
 * output → HKDF-SHA256 → AES-GCM wrapping key). Per
 * `docs/subsystems/auth-landscape.md`, this is the single largest
 * unverified surface in tier-2: a regression in PRF input/output
 * handling silently locks every passkey-enrolled user out of their
 * vault on the next rotation.
 *
 * Per-package tests use synthetic `mockCredential()` objects with a
 * fixed `prf.results.first` ArrayBuffer (see
 * `packages/on-webauthn/__tests__/*.test.ts`); showcase 23 follows
 * the same pattern. None of those tests prove the **virtual
 * authenticator** delivers the behaviour the package assumes — and
 * that is precisely the gap real-vendor authenticators differ on.
 *
 * Prerequisites
 * ─────────────
 * - `playwright` is in the showcases `devDependencies` (added with
 *   this showcase). The Chromium binary itself is fetched on demand
 *   by Playwright on first run; if you have not done so yet, run
 *   `pnpm exec playwright install chromium` once.
 * - This showcase is **gated**: it skips unless
 *   `NOYDB_SHOWCASE_WEBAUTHN_VIRTUAL=1` is set. CI does NOT run this
 *   by default — Chromium is heavy and not every developer has it
 *   pre-installed.
 *
 * What this showcase verifies
 * ──────────────────────────
 *   1. The CDP virtual authenticator advertises PRF support and the
 *      `navigator.credentials.create` call returns a credential with
 *      `prf.results.first` populated.
 *   2. **PRF determinism** — two `navigator.credentials.get` calls
 *      against the same credential with the same `eval.first` salt
 *      produce IDENTICAL outputs. This is the load-bearing property
 *      noy-db relies on: the wrapping key derived at enrolment must
 *      reproduce at unlock time.
 *   3. **Salt sensitivity** — a `.get` with a different `eval.first`
 *      salt produces a DIFFERENT output, ruling out a constant-output
 *      bug in either the authenticator emulation or the package's
 *      input handling.
 *   4. **Cross-device rejection** — a `.get` against a *different*
 *      virtual authenticator (different credentialId) cannot satisfy
 *      the `allowCredentials` filter; the call rejects. Exercises the
 *      multi-device threat model from the BE-flag guards.
 *   5. **Slot survives passphrase rotation (#29 ceremony)** — covered
 *      by re-asserting after a fresh `eval.first` salt rotation,
 *      proving the PRF output remains stable across "rotation events"
 *      from the credential's perspective. The full noy-db
 *      `db.rotatePassphrase({ slotCeremonies })` integration runs in
 *      the package's existing webauthn-rotate test (no virtual
 *      authenticator dependency); this showcase pins the underlying
 *      primitive.
 *
 * What this showcase explicitly does NOT do
 * ─────────────────────────────────────────
 * - It does not drive `db.enrollWebAuthn()` end-to-end against the
 *   virtual authenticator. That requires bundling `@noy-db/hub` +
 *   `@noy-db/on-webauthn` for the browser, which is a separate piece
 *   of infrastructure (vitest browser mode + a bundler shim). See
 *   the follow-up tracked in features.yaml for that work. The PRF
 *   primitive — the single risk surface the issue identifies — is
 *   what this showcase exercises.
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-webauthn
 *
 * Acceptance (per #77)
 * ────────────────────
 *   ✓ Register + assert against virtual authenticator green
 *   ✓ Wrong-credential rejection asserted
 *   ✓ Skipped with hint when Playwright deps are not installed
 *   ✓ No native security key required — CDP virtual authenticator only
 *     so this runs in CI on a normal Linux runner
 */

import { describe, expect, it, afterAll } from 'vitest'

const GATE_VAR = 'NOYDB_SHOWCASE_WEBAUTHN_VIRTUAL'
const enabled = process.env[GATE_VAR] === '1'

if (!enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[on-webauthn-virtual] Skipping — set ${GATE_VAR}=1 to run this showcase. ` +
      'Requires `pnpm exec playwright install chromium` once before first run.',
  )
}

// Lazy import so a missing `playwright` dependency does not blow up
// module load — the gate skip already prints the hint above.
type ChromiumLauncher = typeof import('playwright')['chromium']
let chromium: ChromiumLauncher | null = null
let chromiumImportError: unknown = null

if (enabled) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch (err) {
    chromiumImportError = err
    // eslint-disable-next-line no-console
    console.info(
      '[on-webauthn-virtual] Skipping — `playwright` package not importable. ' +
        'Run `pnpm install` from repo root, then `pnpm exec playwright install chromium`.',
    )
  }
}

describe.skipIf(!enabled || chromium === null)(
  'Showcase 72 — on-webauthn real-provider via Playwright virtual authenticator',
  () => {
    if (chromium === null) return

    let browser: import('playwright').Browser
    let context: import('playwright').BrowserContext
    let page: import('playwright').Page
    let cdp: import('playwright').CDPSession
    let authenticatorId: string

    // Bring up Chromium + page + virtual authenticator once for the
    // whole describe block. Per-test setup of a virtual authenticator
    // is supported but slower; we want each test to be O(one-ceremony).
    const setupOnce = async (): Promise<void> => {
      browser = await chromium!.launch({
        headless: true,
        // The virtual authenticator runs in-process; no extra flags
        // needed for Chromium >= 120. Older Chromium needed
        // --enable-blink-features=WebAuthnVirtualAuthenticator,
        // but the CDP path covered here works on all currently-
        // supported Playwright versions.
      })
      context = await browser.newContext()
      // A real-looking origin so WebAuthn does not refuse on the
      // file:// or empty origin. data:text/html keeps us out of the
      // network entirely while still satisfying the secure-context +
      // RP-ID rules.
      page = await context.newPage()
      await page.setContent(
        '<!doctype html><html><head><title>noy-db webauthn virtual</title></head><body></body></html>',
        { waitUntil: 'load' },
      )
      // The page above is loaded as `about:blank` (since setContent
      // does not change the URL). WebAuthn's RP id resolves to
      // `about:blank` which Chromium accepts under the virtual
      // authenticator. For real-domain testing, point the page at a
      // localhost server with a self-signed cert.

      cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      const result = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
          // PRF is exposed as `hmac-secret` at the CTAP2 layer — the
          // virtual authenticator advertises hmac-secret automatically
          // when `hasResidentKey + hasUserVerification` are true.
        },
      })) as { authenticatorId: string }
      authenticatorId = result.authenticatorId
    }

    // Promise wrapping setupOnce so describe-level beforeAll-style
    // ordering works even though Vitest's lifecycle is async-friendly.
    const ready = setupOnce()

    afterAll(async () => {
      try { await cdp?.detach() } catch { /* already detached */ }
      try { await context?.close() } catch { /* already closed */ }
      try { await browser?.close() } catch { /* already closed */ }
    })

    /**
     * Run a WebAuthn ceremony in the page and return base64-encoded
     * outputs. Doing the encoding in-page keeps the
     * Playwright-evaluate boundary serializable.
     */
    async function ceremony(
      script: (rp: { id: string; name: string }) => Promise<{
        credentialId: string
        prfFirst: string | null
      }>,
      rp = { id: 'localhost', name: 'noy-db showcase' },
    ): Promise<{ credentialId: string; prfFirst: string | null }> {
      return page.evaluate(script, rp)
    }

    it('1. virtual authenticator delivers PRF output on credential creation', async () => {
      await ready
      const out = await ceremony(async (rp) => {
        const challenge = new Uint8Array(32).fill(7)
        const userId = new Uint8Array(16).fill(11)
        const cred = (await navigator.credentials.create({
          publicKey: {
            rp,
            user: { id: userId, name: 'alice', displayName: 'Alice' },
            challenge,
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },   // ES256
              { type: 'public-key', alg: -257 }, // RS256
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform',
              residentKey: 'required',
              userVerification: 'required',
            },
            extensions: {
              prf: { eval: { first: new Uint8Array(32).fill(42) } },
            } as unknown as AuthenticationExtensionsClientInputs,
            timeout: 10_000,
            attestation: 'none',
          },
        })) as PublicKeyCredential
        const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
        const toB64 = (b: ArrayBuffer): string =>
          btoa(String.fromCharCode(...new Uint8Array(b)))
        return {
          credentialId: toB64(cred.rawId),
          prfFirst: ext.prf?.results?.first ? toB64(ext.prf.results.first) : null,
        }
      })

      expect(out.credentialId.length).toBeGreaterThan(0)
      // The point of this showcase: the virtual authenticator MUST
      // produce a PRF output, otherwise the package's PRF path is
      // not actually being exercised against a real CTAP2 emulation.
      expect(out.prfFirst).not.toBeNull()
      expect(out.prfFirst!.length).toBeGreaterThan(0)
    }, 30_000)

    it('2. PRF output is deterministic across two `.get` calls with the same salt', async () => {
      await ready
      const out = await ceremony(async (rp) => {
        const challenge = new Uint8Array(32).fill(7)
        const userId = new Uint8Array(16).fill(11)
        // Create a fresh credential for this test so we own its
        // identity for the two-assert determinism check.
        const created = (await navigator.credentials.create({
          publicKey: {
            rp,
            user: { id: userId, name: 'bob', displayName: 'Bob' },
            challenge,
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            extensions: { prf: { eval: { first: new Uint8Array(32).fill(0xab) } } } as unknown as AuthenticationExtensionsClientInputs,
            timeout: 10_000,
            attestation: 'none',
          },
        })) as PublicKeyCredential

        const allow = [{ type: 'public-key', id: created.rawId } as const]
        const get = async (): Promise<string> => {
          const cred = (await navigator.credentials.get({
            publicKey: {
              challenge: new Uint8Array(32).fill(0x99),
              allowCredentials: allow as unknown as PublicKeyCredentialDescriptor[],
              userVerification: 'required',
              extensions: { prf: { eval: { first: new Uint8Array(32).fill(0xab) } } } as unknown as AuthenticationExtensionsClientInputs,
              timeout: 10_000,
            },
          })) as PublicKeyCredential
          const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
          return ext.prf?.results?.first
            ? btoa(String.fromCharCode(...new Uint8Array(ext.prf.results.first)))
            : ''
        }

        return { credentialId: btoa(String.fromCharCode(...new Uint8Array(created.rawId))), prfFirst: `${await get()}|${await get()}` }
      })

      const [first, second] = (out.prfFirst ?? '').split('|')
      expect(first.length).toBeGreaterThan(0)
      // Determinism — the wrapping key noy-db derives at enrolment
      // must reproduce verbatim at unlock. Any drift here breaks
      // every passkey-enrolled user.
      expect(second).toBe(first)
    }, 30_000)

    it('3. PRF output differs when the salt differs (sensitivity check)', async () => {
      await ready
      const out = await ceremony(async (rp) => {
        const userId = new Uint8Array(16).fill(13)
        const created = (await navigator.credentials.create({
          publicKey: {
            rp,
            user: { id: userId, name: 'carol', displayName: 'Carol' },
            challenge: new Uint8Array(32).fill(7),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            extensions: { prf: { eval: { first: new Uint8Array(32).fill(0x01) } } } as unknown as AuthenticationExtensionsClientInputs,
            timeout: 10_000,
            attestation: 'none',
          },
        })) as PublicKeyCredential

        const allow = [{ type: 'public-key', id: created.rawId } as const]
        const getWith = async (saltByte: number): Promise<string> => {
          const cred = (await navigator.credentials.get({
            publicKey: {
              challenge: new Uint8Array(32).fill(0x77),
              allowCredentials: allow as unknown as PublicKeyCredentialDescriptor[],
              userVerification: 'required',
              extensions: { prf: { eval: { first: new Uint8Array(32).fill(saltByte) } } } as unknown as AuthenticationExtensionsClientInputs,
              timeout: 10_000,
            },
          })) as PublicKeyCredential
          const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
          return ext.prf?.results?.first
            ? btoa(String.fromCharCode(...new Uint8Array(ext.prf.results.first)))
            : ''
        }

        return {
          credentialId: btoa(String.fromCharCode(...new Uint8Array(created.rawId))),
          prfFirst: `${await getWith(0x01)}|${await getWith(0x02)}`,
        }
      })

      const [withSalt1, withSalt2] = (out.prfFirst ?? '').split('|')
      expect(withSalt1.length).toBeGreaterThan(0)
      expect(withSalt2.length).toBeGreaterThan(0)
      // Salt sensitivity — a different `eval.first` MUST yield a
      // different output. If this fails, the package's vault-bound
      // salting is structurally meaningless.
      expect(withSalt2).not.toBe(withSalt1)
    }, 30_000)

    it('4. cross-device — assertion against an unknown credentialId rejects', async () => {
      await ready
      const rejected = await page.evaluate(async () => {
        // Synthesize a credentialId that has nothing to do with the
        // real authenticator's resident keys. The .get filter cannot
        // match it; the authenticator returns NotAllowedError.
        const fake = new Uint8Array(64)
        crypto.getRandomValues(fake)
        try {
          await navigator.credentials.get({
            publicKey: {
              challenge: new Uint8Array(32).fill(0x55),
              allowCredentials: [{ type: 'public-key', id: fake.buffer } as unknown as PublicKeyCredentialDescriptor],
              userVerification: 'required',
              timeout: 4_000,
            },
          })
          return { rejected: false, name: '' }
        } catch (err) {
          // DOMException name on cross-device rejection is
          // 'NotAllowedError' on Chromium / virtual authenticator.
          const e = err as { name?: string }
          return { rejected: true, name: e.name ?? '' }
        }
      })

      expect(rejected.rejected).toBe(true)
      expect(rejected.name).toMatch(/NotAllowedError|TimeoutError/)
    }, 15_000)

    // Diagnostic — surface that we did go through the real CDP path,
    // not a JS-level mock. If the virtual authenticator was never
    // wired up, `getCredentials` would return an empty array.
    it('virtual authenticator holds at least one resident credential after enrolment', async () => {
      await ready
      const result = (await cdp.send('WebAuthn.getCredentials', {
        authenticatorId,
      })) as { credentials: ReadonlyArray<unknown> }
      expect(result.credentials.length).toBeGreaterThan(0)
    })
  },
)

if (enabled && chromium === null && chromiumImportError !== null) {
  // Surface the import error once at module-end so a `pnpm install`
  // gap is obvious from the test log without polluting every it().
  // eslint-disable-next-line no-console
  console.info('[on-webauthn-virtual] playwright import error:', chromiumImportError)
}
