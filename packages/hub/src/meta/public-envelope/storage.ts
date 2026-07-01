/**
 * Persistence helpers for `_meta/public-envelope`. Mirrors the
 * bypass-AES pattern used by `_meta/handle` and `_meta/policy` —
 * the document is plaintext JSON, the envelope's `_iv` field is
 * left empty.
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import type { PublicEnvelope } from './types.js'
import { isPublicEnvelope } from './schema.js'

/** Reserved id for the vault-level public envelope record. */
export const PUBLIC_ENVELOPE_RECORD_ID = 'public-envelope'

/**
 * Read the public envelope from `_meta/public-envelope`. Returns
 * `undefined` when no envelope has been persisted (fresh vault, or
 * a vault written before the feature was enabled). Tolerates
 * corrupted documents — a JSON parse failure surfaces as `undefined`,
 * not a thrown error, mirroring `_meta/handle`'s contract.
 */
export async function loadPublicEnvelope(
  store: NoydbStore,
  vault: string,
): Promise<PublicEnvelope | undefined> {
  const envelope = await store.get(vault, '_meta', PUBLIC_ENVELOPE_RECORD_ID)
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isPublicEnvelope(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Persist the public envelope. Idempotent — overwrites any prior write. */
export async function savePublicEnvelope(
  store: NoydbStore,
  vault: string,
  envelope: PublicEnvelope,
): Promise<void> {
  const wireEnvelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(envelope),
  }
  await store.put(vault, '_meta', PUBLIC_ENVELOPE_RECORD_ID, wireEnvelope)
}

/**
 * Public, no-key reader. Plain function, not a method on `Noydb` —
 * the whole point is it works without an authenticated session, so
 * a UI can show "Acme 2026 Tax Records" before unlocking.
 *
 * Resolves any `name` / `description` locale map through the supplied
 * `locale` (when provided). Omitting `locale` returns the raw
 * envelope, which a multilingual picker can render as it pleases.
 */
export async function readPublicEnvelope(
  store: NoydbStore,
  vault: string,
  opts: { readonly locale?: string } = {},
): Promise<PublicEnvelope | undefined> {
  const raw = await loadPublicEnvelope(store, vault)
  if (!raw) return undefined
  if (opts.locale === undefined) return raw
  return resolveLocale(raw, opts.locale)
}

/**
 * Resolve the locale-map fields (`name`, `description`) of a public
 * envelope to plain strings for the requested locale, falling back
 * through `defaultLocale` and then any available translation.
 *
 * @internal
 */
export function resolveLocale(
  envelope: PublicEnvelope,
  locale: string,
): PublicEnvelope {
  return {
    ...envelope,
    ...(envelope.name !== undefined ? { name: pickLocale(envelope.name, locale, envelope.defaultLocale) } : {}),
    ...(envelope.description !== undefined ? { description: pickLocale(envelope.description, locale, envelope.defaultLocale) } : {}),
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
 *   2. `defaultLocale` (when supplied on the envelope).
 *   3. First non-empty value in the map.
 *   4. Empty string (only if every translation is empty — pathological).
 *
 * This deviation is documented in `docs/subsystems/public-envelope.md`.
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
