/**
 * on-password against the published `SlotRewrapCeremony` contract.
 *
 * The package's own suite covers what is specific to passwords — strength
 * rules, the legacy wrap-KEK refusal, the salt round-trip. This runs the half
 * every method shares, so a third-party ceremony answers the same questions.
 */
import { runCeremonyConformanceTests } from '@noy-db/test-ceremony-conformance'
import type { KeyringAuthenticator, UnlockedKeyring, EnrollAuthenticatorOptions } from '@noy-db/hub'
import {
  enrollPasswordAuthenticator,
  passwordSlotRewrapCeremony,
  unwrapDeksWithPassword,
} from '../src/index.js'

const PASSWORD = 'strong-password-2026'

async function keyringWithDeks(): Promise<UnlockedKeyring> {
  const subtle = globalThis.crypto.subtle
  const gen = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return {
    userId: 'alice',
    displayName: 'alice',
    role: 'owner',
    permissions: {},
    deks: new Map([['invoices', await gen()], ['clients', await gen()]]),
    kek: null,
    salt: new Uint8Array(32),
    authenticators: [],
  }
}

function slotFromOptions(opts: EnrollAuthenticatorOptions): KeyringAuthenticator {
  if (opts.wrapKind !== 'deks') throw new Error('expected a wrap-DEKs slot')
  return {
    id: opts.id,
    method: opts.method,
    enrolled_at: new Date().toISOString(),
    enrolled_via_tier: opts.enrolled_via_tier ?? 1,
    wrapKind: 'deks',
    wrapped_deks: opts.wrapped_deks,
    iv: opts.iv,
    meta: opts.meta,
  }
}

runCeremonyConformanceTests('on-password', {
  method: 'password',
  ceremony: () => passwordSlotRewrapCeremony(PASSWORD),

  oldSlot: async () =>
    slotFromOptions(await enrollPasswordAuthenticator(await keyringWithDeks(), { password: PASSWORD })),

  // A real method name, not a hand-typed `method: 'nope'` — the guard exists
  // to stop a slot-type SWAP during rotation, and the plausible swap is
  // between two methods that both exist.
  //
  // Kept at `wrapKind: 'deks'` on purpose. The first version of this fixture
  // used a wrap-KEK webauthn slot, and deleting the method guard from the
  // ceremony left the suite GREEN — the wrapKind guard was rejecting it
  // instead. One difference at a time, or the case proves nothing.
  wrongMethodSlot: async () => {
    const opts = await enrollPasswordAuthenticator(await keyringWithDeks(), { password: PASSWORD })
    return { ...slotFromOptions(opts), method: 'webauthn' }
  },

  // Freshness IS verifiable here: the same password opens the new wrap.
  unwrap: async (opts) => unwrapDeksWithPassword(slotFromOptions(opts), PASSWORD),
})
