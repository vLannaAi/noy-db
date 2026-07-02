# User preferences

> A reference shape for the per-principal `_users/<keyringId>` envelope. The shape lives at the **app layer** — hub commits only to `userId === keyringId` and the storage location.

The runnable verification of this recipe is `showcases/src/recipe-user-preferences.recipe.test.ts`. The full service documentation is at [`docs/services/user-envelope.md`](../services/user-envelope.md).

## When to reach for this

You have a multi-user vault and want each user to get their own profile + preferences (display name, avatar, locale, theme) that follow them across devices via the team/sync engine. You want admin pre-fill at invite time, you want clean cross-principal reads ("Bob's display name in the team list"), and you want the hub to enforce that **only Bob can write Bob's profile** — even an owner cannot.

## Reference shape

```ts
interface UserShape {
  profile?: {
    displayName?: string
    avatarRef?: string  // ref into the vault's blob-set; not a URL
    locale?: string     // BCP 47
    timeZone?: string   // IANA
  }
  preferences?: {
    theme?: 'light' | 'dark' | 'system'
    locale?: string     // UI override; falls back to profile.locale
  }
  app?: {
    // Per-app extensions. Opaque to hub.
    signature?: string
    perClientCurrency?: Record<string, string>
  }
}
```

This interface is **app-defined**. Hub never imports it. Apps copy this shape, extend it, contract it, or replace it. Integrations (`@noy-db/in-vue`, `@noy-db/in-react`, etc.) operate on the generic `UserEnvelope<T>`.

## Reading and writing

```ts
// Initial write — full shape.
await vault.user.updateMe<UserShape>({
  profile: { displayName: 'Vicio', locale: 'it-IT' },
  preferences: { theme: 'dark' },
})

// updateMe deep-merges. Partial patches preserve unmentioned fields.
await vault.user.updateMe<UserShape>({
  preferences: { theme: 'light' }, // profile.* untouched
})

// setMe replaces (no merge).
await vault.user.setMe<UserShape>({
  profile: { displayName: 'Vicio2' },
})

// Read your own envelope (never gated).
const me = await vault.user.me<UserShape>()
console.log(me?.data.profile?.displayName)

// Read a teammate (gated by view-team-profiles).
const bob = await vault.user.get<UserShape>('bob')

// List all visible envelopes (gated by view-team-profiles; with
// `enabled: false` returns only [me]).
const everyone = await vault.user.list<UserShape>()
```

## Device-local state — keep it OUT of the vault

Anything stored in the vault syncs across devices. Device-local state (last-opened-collection id, table column widths, scroll position, "don't show this onboarding tip again") is by definition **not cross-device** — keep it in `localStorage` at the app layer, **not** in the user envelope.

```ts
// Cross-device state → vault.user.*
await vault.user.updateMe<UserShape>({ preferences: { theme: 'dark' } })

// This-device state → localStorage
window.localStorage.setItem(
  'lastOpenedCollectionId',
  'invoices',
)
```

Mixing the two in one envelope creates surprises ("why did my column widths sync to my phone?"). The recipe test pins this pattern with a mock localStorage.

## Admin pre-fill at grant time

```ts
await db.grant('demo', {
  userId: 'bob',
  displayName: 'Bob',
  role: 'viewer',
  passphrase: 'bob-pass-2026',
  initialProfile: {
    profile: { displayName: 'Bob the Auditor', locale: 'fr-FR' },
    preferences: { theme: 'dark' },
  } satisfies UserShape,
})
```

Bootstrap-only: once Bob activates and writes his own envelope, the own-only write rule prevents further admin edits. Admins cannot edit teammate profiles after activation — that's structural, not policy-controlled.

## Reactive bindings (Vue / React / Svelte)

```ts
// Vue 3 + Pinia composable (sketch)
import { ref, onUnmounted } from 'vue'
import { vault } from './vault'

export function useUserEnvelope() {
  const me = ref<UserShape | null>(null)
  const live = vault.user.live<UserShape>(vault.userId)
  // Initial fetch
  vault.user.me<UserShape>().then((env) => { me.value = env?.data ?? null })
  // Live updates on local writes
  const unsub = live.subscribe((env) => { me.value = env?.data ?? null })
  onUnmounted(() => { live.stop(); unsub() })
  return { me }
}
```

The actual rendered Nuxt page lands in a follow-up release. The recipe shows the API surface; the playground page wires it to forms and avatars.

## Presence integration

When announcing presence on a collection, the app sources `displayName` from its own user envelope and includes it in the presence payload `P`:

```ts
const me = await vault.user.me<UserShape>()
collection.presence().update({
  displayName: me?.data.profile?.displayName,
  editingRecordId: 'invoice-42',
})
```

Presence subscribers receive `PresencePeer<typeof presencePayload>` and render `peer.payload.displayName`. Hub stays payload-agnostic — it does NOT introspect the user envelope to populate presence.

## See also

- `docs/services/user-envelope.md` — full service reference
- `showcases/src/70-user-envelope.showcase.test.ts` — Hub API end-to-end
- `showcases/src/recipe-user-preferences.recipe.test.ts` — runnable form of this recipe
