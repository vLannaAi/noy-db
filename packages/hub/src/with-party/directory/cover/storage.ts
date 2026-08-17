/**
 * Persistence helpers for `_meta/public-envelope` — the cover's
 * frozen wire location. Mirrors the bypass-AES pattern used by
 * `_meta/handle` and `_meta/policy` — the document is plaintext
 * JSON, the envelope's `_iv` field is left empty.
 *
 * @module
 */
import { buildRecordEnvelope } from '../../../kernel/enclave/index.js'
import type { NoydbStore } from '../../../kernel/types.js'
import type { Cover } from './types.js'
import { isCover } from './schema.js'

/**
 * Reserved id for the vault-level cover record. The VALUE is frozen
 * wire format — the record predates the #799 rename and stays at
 * `_meta/public-envelope` so existing vaults need no migration.
 */
export const COVER_RECORD_ID = 'public-envelope'

/**
 * Read the cover from `_meta/public-envelope`. Returns `undefined`
 * when no cover has been persisted (fresh vault, or a vault written
 * before the feature was enabled). Tolerates corrupted documents —
 * a JSON parse failure surfaces as `undefined`, not a thrown error,
 * mirroring `_meta/handle`'s contract.
 */
export async function loadCover(
  store: NoydbStore,
  vault: string,
): Promise<Cover | undefined> {
  const envelope = await store.get(vault, '_meta', COVER_RECORD_ID)
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isCover(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Persist the cover. Idempotent — overwrites any prior write. */
export async function saveCover(
  store: NoydbStore,
  vault: string,
  cover: Cover,
): Promise<void> {
  const wireEnvelope = buildRecordEnvelope(
    { collection: '_meta', id: COVER_RECORD_ID, version: 1 },
    { iv: '', data: JSON.stringify(cover) },
  )
  await store.put(vault, '_meta', COVER_RECORD_ID, wireEnvelope)
}

/**
 * Public, no-key reader. Plain function, not a method on `Noydb` —
 * the whole point is it works without an authenticated session, so
 * a UI can show "Acme 2026 Tax Records" before unlocking.
 *
 * Resolves any `name` / `description` locale map through the supplied
 * `locale` (when provided). Omitting `locale` returns the raw
 * cover, which a multilingual picker can render as it pleases.
 */
export async function readCover(
  store: NoydbStore,
  vault: string,
  opts: { readonly locale?: string } = {},
): Promise<Cover | undefined> {
  const raw = await loadCover(store, vault)
  if (!raw) return undefined
  if (opts.locale === undefined) return raw
  return resolveLocale(raw, opts.locale)
}

/**
 * Resolve the locale-map fields (`name`, `description`) of a cover
 * to plain strings for the requested locale, falling back through
 * `defaultLocale` and then any available translation.
 *
 * @internal
 */
export function resolveLocale(
  cover: Cover,
  locale: string,
): Cover {
  return {
    ...cover,
    ...(cover.name !== undefined ? { name: pickLocale(cover.name, locale, cover.defaultLocale) } : {}),
    ...(cover.description !== undefined ? { description: pickLocale(cover.description, locale, cover.defaultLocale) } : {}),
  }
}

/**
 * Resolve a `string | { [locale]: string }` value to a string for a
 * given locale. Exported so the bundle reader can reuse it without
 * duplicating the fallback chain.
 *
 * **Looser than `resolveI18nText`** — the hub's record-field resolver
 * throws `LocaleNotSpecifiedError` when no translation matches, but
 * label semantics deliberately prefer "show *something*" over
 * throwing. The fallback chain is:
 *   1. Exact `locale` match.
 *   2. `defaultLocale` (when supplied on the cover).
 *   3. First non-empty value in the map.
 *   4. Empty string (only if every translation is empty — pathological).
 *
 * This deviation is documented in `https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md`.
 */
export function pickLocale(
  value: string | Record<string, string>,
  locale: string,
  defaultLocale: string | undefined,
): string {
  if (typeof value === 'string') return value
  if (value[locale] !== undefined && value[locale] !== '') return value[locale]
  if (defaultLocale && value[defaultLocale] !== undefined && value[defaultLocale] !== '') {
    return value[defaultLocale]
  }
  for (const v of Object.values(value)) {
    if (v !== '') return v
  }
  return ''
}
