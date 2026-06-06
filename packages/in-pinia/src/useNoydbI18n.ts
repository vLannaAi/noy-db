/**
 * `useNoydbI18n` — the reactive active-locale for a Pinia/Vue app.
 *
 * A single source of truth that drives opt-in store resolution
 * (`defineNoydbStore({ i18n: 'follow' })`) and the reactive
 * `useI18nField` / `useDictLabel` selectors.
 *
 * **State-only by default.** Every in-pinia reader passes `{ locale }`
 * explicitly on each read, so the reactive `locale` state alone drives
 * all in-pinia resolution — the vault's ambient locale is never needed.
 * `setLocale(l, { syncVault })` additionally calls `vault.setLocale` on
 * the vault(s) you pass, for apps that ALSO do imperative (non-in-pinia)
 * hub reads and want those to follow. Locale-less-vault consumers leave
 * `syncVault` off so the vault stays locale-less.
 *
 * @public
 */
import { defineStore } from 'pinia'
import { ref, watch, type Ref } from 'vue'

/** Minimal vault shape needed to sync an ambient locale. */
export interface LocaleSyncable {
  setLocale(locale: string | undefined): void
}

export interface SetLocaleOptions {
  /**
   * Vault(s) to ALSO update via `vault.setLocale` (opt-in). Omit to keep
   * the operation state-only — the safe default for locale-less vaults.
   */
  readonly syncVault?: LocaleSyncable | readonly LocaleSyncable[]
}

export const useNoydbI18n = defineStore('noydb-i18n', () => {
  const locale = ref<string>('en')
  const fallback = ref<string[]>(['en', 'any'])

  function setLocale(l: string, opts?: SetLocaleOptions): void {
    locale.value = l
    const sync = opts?.syncVault
    if (sync) {
      const vaults = Array.isArray(sync) ? sync : [sync as LocaleSyncable]
      for (const v of vaults) v.setLocale(l)
    }
  }

  function setFallback(chain: string[]): void {
    fallback.value = chain
  }

  /**
   * One-way, state-only follow of an external locale ref (e.g. vue-i18n's
   * `locale`). Never touches a vault. Returns the watch stop handle.
   */
  function bindTo(source: Ref<string>, opts?: { immediate?: boolean }): () => void {
    return watch(
      source,
      (v) => { locale.value = v },
      // sync flush so the mirror propagates immediately (no tick lag) —
      // a locale change should be observable synchronously by dependents.
      { immediate: opts?.immediate ?? true, flush: 'sync' },
    )
  }

  return { locale, fallback, setLocale, setFallback, bindTo }
})
