# Pod redirect — the Redirect record

The **Redirect record** (#944) is one signed "this moved, go there" pointer, used in four places the manifest-set case analysis found needed the same shape: a redirect pod (a pod whose only content is a pointer to another pod/location), a store's route tombstone (a decommissioned store's "moved to …" record), a manifest re-point, and a fleet-member reference (klum-side). Rather than four ad-hoc pointer formats, `@noy-db/hub/pod` ships one: `Redirect`, `signRedirect`/`verifyRedirect` to mint and check it, `readPodRedirect` to read it off a pod's header, and `followRedirects` to walk a chain of them.

## The record

```ts
export interface Redirect {
  readonly v: 1
  readonly target: string
  readonly reason: 'moved' | 'release' | 'tombstone' | 'repoint'
  readonly issuedBy: string // keyId (16-hex) of the signer
  readonly sig: string      // base64url Ed25519 over the record minus `sig`
}
```

`target` is a locator string or URL. The forthcoming #945 `Locator` type isn't built yet, so `target` stays a plain string for now — see [Redirect vs Locator](#redirect-vs-locator) below for why this isn't the same concept.

Minimum-disclosure: the record is kept to exactly these five fields — no timestamps, no identities beyond the signer's `keyId` fingerprint. A redirect target is disclosure-appropriate by design (a redirect's whole purpose is to point somewhere), so there's nothing else worth withholding.

### Record-level signature — fail-closed, not "unverified"

`signRedirect(signer, { target, reason })` signs a new record through the same convention `pod-signature.md` describes for the pod header itself (`signRecord`/`verifyRecord`, canonical JSON, Ed25519). `verifyRedirect(record, trustedKeys)` checks it against a caller-supplied `keyId → publicKeyB64` map.

Unlike the pod header — where an unsigned pod is legitimately `unsigned` (legacy v1 pods exist, and `{ sign: false }` is a supported opt-out) — a Redirect has **no legacy install base**. It is a brand-new record type, so:

- An absent or malformed `sig` is **invalid**, full stop — not "unverified," not a degraded-trust state to pass through.
- An `issuedBy` that isn't in the caller's `trustedKeys` is treated identically to a forged signature: unusable for following. There is no separate "untrusted but structurally fine" outcome the way `verifyPodHeader` has `untrusted`.

This is a deliberate asymmetry from the pod-header signature, which does support a legacy unsigned state. A Redirect never does.

## Why the plaintext header, not the encrypted body

The Redirect record rides in the pod's plaintext header (`NoydbPodHeader.redirect`), the same allowlisted-header-key mechanism `pod-header-fields.md`-era work (#942/#943) established for `species`, `engineRange`, and friends — not inside the encrypted body.

**Design decision, deliberately deviating from #944's literal issue text** ("the body carries this record"): the issue's own acceptance criteria and Relations section require pre-auth following by a connection-pod open flow, the Studio-side Landing dispatcher, and a static page — none of which can reach an encrypted body. Header placement is the only design that satisfies the stated consumers.

The reason is structural, not stylistic: every consumer this record exists for has to follow it **before** authentication.

- A **dispatcher** or the Studio-side Landing page routes a request to the right pod *before* any unlock has happened.
- A **connection-pod open flow** needs to know it's been redirected before it has a key to decrypt anything with.
- A **static page** (no store, no enclave, no vault) needs to resolve a redirect chain using nothing but the bytes it was handed and WebCrypto.

None of those consumers can decrypt the body. If the Redirect lived in the encrypted body, following it would require exactly the credential the redirect exists to route around. Header placement is the only design that satisfies the stated consumers — `species: 'redirect'` (already a header field since #942) plus `readPodRedirect` is what lets a pod's redirect nature be recognized pre-auth.

`readPodRedirect(bytes): Redirect | undefined` is a pure, synchronous, secret-free read — it mirrors `readPodCover`. It **does not verify** the record; it only extracts and structurally validates the shape. Signature verification is a separate step (`verifyRedirect`) because a parser has no `trustedKeys` to check against. Any caller that intends to *act* on a Redirect — follow it, display it as authoritative, anything beyond "a redirect field is present" — must call `verifyRedirect` (or use `followRedirects`, which does this for you) before trusting it.

## `followRedirects`

```ts
async function followRedirects(
  start: Uint8Array,
  fetcher: (target: string) => Promise<Uint8Array | null>,
  opts: { readonly trustedKeys: Readonly<Record<string, string>>; readonly maxDepth?: number },
): Promise<FollowRedirectsResult>
```

Walks a chain of Redirect records starting from `start`'s pod bytes, HTTP-redirect style:

1. **Verify-before-follow.** At each hop, `readPodRedirect` extracts the record; if there is none, the current bytes are the terminal. If there is one, it is verified against `opts.trustedKeys` *before* it is followed — an untrusted or forged hop never advances the walk.
2. **Capped depth.** `opts.maxDepth` (default **8**, a small fixed constant) bounds how many hops will be followed.
3. **Loop detection.** Every target followed in this chain is tracked; a target seen twice is a loop, not a longer chain.
4. **Hop provenance.** Each followed hop's `{ target, reason, issuedBy }` is accumulated into an ordered `hops` list on the result, so a UI can render "moved from X via Y."
5. **Fetching.** `fetcher(target)` resolves each hop's bytes. A `null` return or a thrown error means that target is unreachable.

Four typed failures, matching the four ways a chain can go wrong:

| Error | `code` | When |
|---|---|---|
| `RedirectBadSignatureError` | `REDIRECT_BAD_SIGNATURE` | A hop's Redirect fails `verifyRedirect` (bad signature, or `issuedBy` not in `trustedKeys`). |
| `RedirectLoopError` | `REDIRECT_LOOP` | A hop's target was already followed earlier in this chain. |
| `RedirectDepthExceededError` | `REDIRECT_DEPTH_EXCEEDED` | More than `maxDepth` hops were followed. |
| `RedirectUnreachableError` | `REDIRECT_UNREACHABLE` | `fetcher` threw or returned `null` for a target. |

The result on success is `{ terminal: Uint8Array; hops: readonly RedirectHop[] }` — the non-redirect pod's bytes, plus the ordered hop list that led there. A `start` that's already terminal (no redirect header field) returns `{ terminal: start, hops: [] }` immediately.

## Tombstone semantics

A **route tombstone** is a Redirect with `reason: 'tombstone'`: the record a decommissioned store leaves behind so that stale connection pods pointed at it fail **forward**, not with a bare connection error.

- **What writes it.** Actually writing a tombstone on decommission is store/connection-pod wiring, out of scope for #944 — this issue defines the record shape, the resolver, and documents the semantics a store implementation is expected to honor. A store being decommissioned is expected to leave a `species: 'redirect'` pod (or a `redirect` header field on its existing connection pod) carrying `{ reason: 'tombstone', target: <new location>, issuedBy, sig }` at the well-known location clients already poll/fetch for that connection.
- **Where it lives.** The same plaintext-header mechanism as any other Redirect — at the location a connection pod already occupies, so no new discovery path is needed. A client that already knows how to fetch the connection pod for a store will, post-decommission, fetch the tombstone instead.
- **Offline clients.** A client that's offline when the tombstone is written has no way to learn about it in real time. It shows the **last-known re-point** from its cached manifest generation — i.e. whatever `Redirect` (if any) was already resolved and cached the last time it successfully reached the store — rather than presenting a bare connection failure. This is why `followRedirects` surfaces the full `hops` list rather than just the terminal: a cached hop list is exactly the "last known re-point" a client can show while offline, and re-resolving on reconnect confirms or updates it.
- **Fail forward, not silent.** The point of the tombstone is that "store is gone" becomes "store moved to X" wherever the record can be reached — never a bare connection error with no forwarding information, for any client that has the record (fresh or cached).

## Redirect vs Locator

**A Redirect says "go elsewhere once." A Locator says "where cargo lives."**

A Redirect is a signed, ephemeral, single-hop pointer: "the thing you were looking for used to be here; now it's there." It has a `reason` (moved / release / tombstone / repoint) because it's documenting an *event* — a change from one location to another. Following one is meant to terminate the redirect relationship, not establish an ongoing one; `followRedirects` walks a *chain* of them precisely because they're expected to compose transiently, not because a Locator-like indirection is the steady state.

A **Locator** (the forthcoming #945 type) is the steady-state answer to "where does this cargo actually live" — an address, not an event. It's the sibling concept a Redirect's `target` field will eventually be typed as (`target` is a plain `string` today specifically because the Locator type doesn't exist yet — a forward seam, noted here rather than blurred away).

Keep the two distinct:

- Don't use a Redirect as a long-lived address — that's what a Locator is for, once it exists.
- Don't expect a Locator to carry a signature or a `reason` — that's a Redirect concept, not a Locator one.
- A snapshot pod's optional "newer version at …" hint is a Redirect (an event: "release moved here"), never a live Locator-style route — this is the line that keeps static artifacts honest about what they're claiming.
