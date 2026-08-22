# @noy-db/test-ceremony-conformance

The `SlotRewrapCeremony` contract, published as an executable suite.

```ts
import { runCeremonyConformanceTests } from '@noy-db/test-ceremony-conformance'

runCeremonyConformanceTests('my-method', {
  method: 'my-method',
  ceremony: () => myRewrapCeremony(secret),
  oldSlot: () => makeMySlot(),
  wrongMethodSlot: async () => ({ ...(await makeMySlot()), method: 'password' }),
  unwrap: (opts) => openMyWrap(opts),   // optional — absence is REPORTED
})
```

## What it checks

When `rotateSecret` preserves a tier-2 slot it hands each ceremony a
`SlotRewrapContext` and takes back `EnrollAuthenticatorOptions`, which hub
persists atomically with the rotation. Six properties are the same for every
method:

1. the slot **id** survives
2. the **method** survives
3. the **effective wrap kind** survives
4. a slot belonging to **another method is refused**
5. a refusal **does not mutate** the context it was handed
6. the wrap holds **`ctx.newDeks`**, not the stale set

Method-specific behaviour stays in the package — PRF vs rawId fallback,
password strength rules, credential cancellation. A conformance kit that grew
those would stop being portable to a method nobody has written yet.

## Two fixture rules that are not decoration

**`wrongMethodSlot` must differ from `oldSlot` in `method` alone.** Enforced,
and learned the hard way: the first version of the on-password fixture used a
wrap-KEK slot for the refusal case, so deleting the method guard from the
ceremony left the suite **green** — the `wrapKind` guard was rejecting it
instead. Two differences means the case proves only that *something* refused.

**`unwrap` is optional, and its absence is reported in the test name.** A kit
that silently skipped its most valuable case would be the green-run-with-a-
red-job-inside, in test form.

## Why two bindings, not one

`on-password` and `on-webauthn` both run it, and the second is what made the
first correct.

Case 3 originally asserted `out.wrapKind` directly. It passed against
`on-password`, which **must** set that field. `wrapKind` is `?: 'kek'` on the
wrap-KEK variant, so `on-webauthn` legally omits it — and the kit called that
a failure. **A conformance suite written against one implementation encodes
that implementation's incidental shape as the contract.**

The same pass corrected a naming trap worth knowing: `wrapKind: 'kek'` names
the *field the slot stores* (`wrapped_kek`), not the wrapped material. A
WebAuthn slot wraps the keyring payload carrying `ctx.newDeks`, exactly as the
wrap-DEKs path does. Reading freshness off the `wrapKind` name gets it
backwards.

## Mutation-checked

Both bindings, against real defects introduced into real ceremonies:

| mutation | on-password | on-webauthn |
|---|---|---|
| slot id not preserved | 1 fails | 1 fails |
| method guard deleted | 2 fail | 2 fail |
| wraps the wrong keys | 1 fails | — |

The method-guard row is the one that matters: it fails **only** because the
refusal fixture differs in one field. Before that rule it passed.
