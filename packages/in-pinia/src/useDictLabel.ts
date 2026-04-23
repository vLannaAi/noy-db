/**
 * `useDictLabel(name, options)` — Vue composable for rendering
 * `dictKey` fields at template time.
 *
 * The i18n boundary pattern has records store a **stable key**; the
 * label lives in a reserved `_dict_<name>` collection and is resolved
 * at render time. Every Vue / Nuxt consumer ends up writing the same
 * wrapper — this composable replaces that boilerplate.
 *
 * ```vue
 * <script setup lang="ts">
 *   import { useDictLabel } from '@noy-db/in-pinia'
 *   const label = useDictLabel('invoiceStatus')
 * </script>
 *
 * <template>
 *   <td v-for="inv in invoices" :key="inv.id">
 *     {{ label(inv.status).value }}
 *   </td>
 * </template>
 * ```
 *
 * ## Reactivity
 *
 * `label(key)` returns a `Ref<string>` that updates when the locale
 * changes (via the passed-in `locale` ref).
 *
 * **Known limitation:** mutations via `vault.dictionary(name).put()`
 * bypass the Collection emitter — the hub's `DictionaryHandle` writes
 * through the adapter directly, so labels cached by this composable
 * won't refresh for those writes until either (a) the locale changes
 * or (b) the caller re-creates the composable. Tracked as a v0.22
 * hub follow-up (route dict writes through the Collection emitter).
 *
 * The underlying fetch is async, so a newly-constructed label starts
 * at its "missing" sentinel (the key itself by default) and updates
 * to the resolved string within one tick.
 *
 * @module
 */

import { ref, shallowRef, watch, type Ref } from 'vue'
import type { Vault } from '@noy-db/hub'
import { resolveNoydb } from './context.js'

export interface UseDictLabelOptions {
  /**
   * Explicit vault. Either a `Vault` instance or its name. When a
   * name is provided the composable calls `db.vault(name)` — which
   * requires the vault to already be open via
   * `await db.openVault(name)` elsewhere.
   *
   * When omitted, uses the currently-active vault on the global
   * Noydb instance set via `setActiveNoydb()`. If no vault is open
   * and none is provided, setup throws.
   */
  readonly vault?: Vault | string

  /**
   * Active locale. Pass a `Ref<string>` for live reactivity
   * (e.g. `useI18n().locale` from vue-i18n, or `useLocale()` from a
   * Nuxt module). A bare string is wrapped in a static ref.
   * Defaults to `'en'`.
   */
  readonly locale?: Ref<string> | string

  /**
   * Fallback locale chain — evaluated in order when the primary
   * locale has no translation. Use `'any'` as the final entry to
   * accept any available locale. Defaults to `['en', 'any']`.
   */
  readonly fallback?: string | readonly string[]

  /**
   * What to render when the key is absent from the dictionary.
   *
   *   - `'key'` (default) — return the key itself. Matches the hub's
   *     stable-key invariant and surfaces typos during development.
   *   - `'empty'` — return `''`. Best for cells where a missing
   *     value should render blank.
   *   - `'placeholder'` — return `⟨missing:{key}⟩` for visible
   *     audit during QA.
   */
  readonly onMissing?: 'key' | 'empty' | 'placeholder'
}

/**
 * Build a reactive label lookup. Returns a factory `(key) => Ref<string>`.
 */
export function useDictLabel(
  dictionaryName: string,
  options: UseDictLabelOptions = {},
): (key: string) => Ref<string> {
  const vault = resolveVault(options.vault)
  const handle = vault.dictionary(dictionaryName)

  const localeRef = normaliseLocale(options.locale)
  const fallback = options.fallback ?? (['en', 'any'] as const)
  const onMissingMode = options.onMissing ?? 'key'
  const missing = (key: string): string =>
    onMissingMode === 'empty'
      ? ''
      : onMissingMode === 'placeholder'
        ? `⟨missing:${key}⟩`
        : key

  const cache = new Map<string, Ref<string>>()

  // Refresh every cached label whenever the dict changes via sync /
  // local mutation. The emitter is per-Noydb; listen at the
  // collection granularity so unrelated mutations don't flush.
  const db = resolveNoydb()
  const dictCollection = `_dict_${dictionaryName}`
  const onChange = (event: { collection: string }): void => {
    if (event.collection !== dictCollection) return
    for (const [key, r] of cache) {
      void refresh(key, r)
    }
  }
  db.on('change', onChange)

  // Refresh every cached label when the locale flips.
  watch(localeRef, () => {
    for (const [key, r] of cache) {
      void refresh(key, r)
    }
  })

  async function refresh(key: string, r: Ref<string>): Promise<void> {
    try {
      const resolved = await handle.resolveLabel(
        key,
        localeRef.value,
        fallback as readonly string[],
      )
      r.value = resolved ?? missing(key)
    } catch {
      r.value = missing(key)
    }
  }

  return (key: string): Ref<string> => {
    let r = cache.get(key)
    if (r) return r
    r = shallowRef(missing(key))
    cache.set(key, r)
    void refresh(key, r)
    return r
  }
}

function resolveVault(source: Vault | string | undefined): Vault {
  const db = resolveNoydb()
  if (source && typeof source !== 'string') return source
  if (typeof source === 'string') {
    return (db as unknown as { vault(name: string): Vault }).vault(source)
  }
  // No vault specified — try the first one the instance has open.
  const anyDb = db as unknown as { vaultCache?: Map<string, Vault> }
  if (anyDb.vaultCache && anyDb.vaultCache.size > 0) {
    return [...anyDb.vaultCache.values()][0]!
  }
  throw new Error(
    '[@noy-db/in-pinia] useDictLabel: no open vault. Pass `{ vault: "name" }` or `await db.openVault(name)` first.',
  )
}

function normaliseLocale(locale: UseDictLabelOptions['locale']): Ref<string> {
  if (locale === undefined) return ref('en')
  if (typeof locale === 'string') return ref(locale)
  return locale
}
