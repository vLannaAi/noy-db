/**
 * The i18n `ViaBinding` — wires the i18n engine (auto-translate/script
 * enforcement/validation/densify on write; locale + dict-label presentation
 * on read) into the kernel's generic Via port. Mirrors
 * `shape/via-money/binding.ts`'s #553 static-link pattern.
 *
 * DORMANT (#623 Task 7): `i18nBinding()`/`linkI18nVia()` exist and are
 * unit-tested here, but no kernel call site constructs `this.via` from an
 * i18n collection's config yet — `collection.ts`/`vault.ts` still run the
 * hand-wired put/read paths this file's bodies were moved/adapted from
 * (`_putInternal` 1826-1945, `applyLocaleToRecord` 4184-4301). Task 8 wires
 * the compile entry (the cutover) and removes the hand-wired paths.
 *
 * `i18nText()`, `dictKey()`, `staticDict()` each call {@link linkI18nVia}
 * first — the same #553 pattern `money()` uses.
 */
import type { ViaBinding, ViaWriteCtx, ViaReadCtx } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
import type { I18nTextDescriptor } from './core.js'
import { stripI18nFilled } from './core.js'
import type { DictKeyDescriptor, StaticDictDescriptor } from './dictionary.js'
import type { I18nStrategy } from '../../port/with/i18n-strategy.js'
import { isStaticDictDescriptor } from '../../port/with/i18n-strategy.js'
import { resolvePolicy, type Layer } from './policy.js'
import { getAtPath, setAtPathInPlace } from '../../kernel/paths.js'
import { TranslatorNotConfiguredError, LocaleNotSpecifiedError } from '../../kernel/errors.js'

/**
 * Config a collection's i18n declarations resolve to — the binding's
 * construction input. Fields are loosely typed (`unknown`) at this seam
 * because the kernel's `ViaBinder` contract is opaque-config-in; the
 * concrete i18n types are applied inside the binding's own functions.
 */
export interface I18nViaConfig {
  i18nFields?: Record<string, unknown>          // I18nTextDescriptor map
  dictKeyFields?: Record<string, unknown>       // DictKeyDescriptor | StaticDictDescriptor map
  i18nDensifyFields?: Record<string, unknown>   // I18nTextDescriptor subset (densifyOnWrite: true)
  strategy: unknown                              // I18nStrategy (real or NO_I18N)
  defaultLocale?: string
  autoTranslateHook?: (...args: unknown[]) => Promise<string>
  dictLabelResolver?: (...args: unknown[]) => Promise<string | undefined>
  i18nPutValidator?: (record: unknown) => void   // the vault-built closure (unchanged wiring)
  collectionName: string
}

// ─── write pipeline ─────────────────────────────────────────────────────

/**
 * Auto-translate missing i18nText translations. Runs BEFORE i18n
 * validation so translated values satisfy the required-locale constraint.
 * Throws `TranslatorNotConfiguredError` when a field has
 * `autoTranslate: true` but no hook was configured. Mutates `record`
 * in place (mirrors `collection.ts:1830-1874`).
 */
async function runI18nAutoTranslate(
  record: Record<string, unknown>,
  i18nFields: Record<string, I18nTextDescriptor>,
  cfg: I18nViaConfig,
): Promise<void> {
  for (const [field, descriptor] of Object.entries(i18nFields)) {
    if (!descriptor.options.autoTranslate) continue
    // getAtPath returns [] for array-wildcard paths — auto-translate on
    // 'contacts[].field' style paths is not supported; skip silently.
    const leafValues = getAtPath(record, field)
    if (leafValues.length !== 1) continue
    const value = leafValues[0]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const map = value as Record<string, string>
    // Determine which locales need translation. For 'all', translate all
    // declared languages that are missing. For 'any', only translate if
    // none are present. For string[], translate the listed required ones.
    const { languages, required } = descriptor.options
    const missing: string[] = languages.filter(
      (lang) => !(lang in map) || map[lang] === '',
    )
    if (missing.length === 0) continue
    // Find a source locale (first present non-empty value)
    const sourceLocale = languages.find((l) => l in map && map[l] !== '')
    if (!sourceLocale) continue
    if (!cfg.autoTranslateHook) {
      throw new TranslatorNotConfiguredError(field, cfg.collectionName)
    }
    // Only translate locales that are actually needed
    const toTranslate =
      required === 'any'
        ? [] // 'any' is already satisfied since sourceLocale exists
        : required === 'all'
          ? missing
          : missing.filter((l) => required.includes(l))
    const translated = { ...map }
    for (const targetLocale of toTranslate) {
      translated[targetLocale] = await cfg.autoTranslateHook(
        map[sourceLocale]!,
        sourceLocale,
        targetLocale,
        field,
        cfg.collectionName,
      )
    }
    setAtPathInPlace(record, field, translated)
  }
}

/**
 * i18nText script enforcement — runs AFTER auto-translate (so generated
 * values are checked too). Throws `ScriptViolationError` (from inside
 * `strategy.enforceScript`) under the default 'reject'; 'filter' strips
 * disallowed chars in place; 'warn' leaves the value unchanged. Mirrors
 * `collection.ts:1896-1927`.
 */
function runI18nScriptEnforcement(
  record: Record<string, unknown>,
  i18nFields: Record<string, I18nTextDescriptor>,
  strategy: I18nStrategy,
  exemptFills: Map<string, Set<string>> | undefined,
  ctx: ViaWriteCtx,
  cfg: I18nViaConfig,
): void {
  for (const [field, descriptor] of Object.entries(i18nFields)) {
    if (!descriptor.options.script) continue
    for (const leaf of getAtPath(record, field)) {
      if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) continue
      const leafMap = leaf as Record<string, unknown>
      const { value: cleaned, warnings } = strategy.enforceScript(
        leafMap,
        field,
        descriptor,
        exemptFills?.get(field),
      )
      if (cleaned !== leafMap) Object.assign(leafMap, cleaned)
      // enforceScript only returns warnings under 'warn'/'filter' ('reject'
      // throws first), so this guard never fires — it makes that invariant
      // explicit and keeps `mode` off the optional-undefined type.
      const mode = descriptor.options.onScriptViolation
      if (mode === 'warn' || mode === 'filter') {
        for (const w of warnings) {
          // `ViaWriteCtx` carries no vault identity yet — Task 8 finishes
          // wiring this event's payload once the binding is on the compile
          // path; `collection` is what's available today via cfg.
          ctx.emit('i18n:script-violation', {
            collection: cfg.collectionName,
            id: ctx.id,
            mode,
            warning: w,
          })
        }
      }
    }
  }
}

/**
 * `encodeWrite` — translate → script → validate → densify, in the EXACT
 * order `_putInternal` runs them today (seam-map Part 2, stages 7-11).
 */
async function runI18nWriteStages(
  record: Record<string, unknown>,
  ctx: ViaWriteCtx,
  cfg: I18nViaConfig,
): Promise<Record<string, unknown>> {
  const i18nFields = cfg.i18nFields as Record<string, I18nTextDescriptor> | undefined
  const i18nDensifyFields = cfg.i18nDensifyFields as Record<string, I18nTextDescriptor> | undefined
  const strategy = cfg.strategy as I18nStrategy

  // 1. Auto-translate.
  if (i18nFields) {
    await runI18nAutoTranslate(record, i18nFields, cfg)
  }

  // 2. densifyOnWrite: read prior fills so a round-tripped derived copy is
  // exempt from script enforcement and can be refreshed. Read once here,
  // reused by densify() below. `ctx.prior()` is a stub returning null until
  // Task 8 wires the real prior-record read.
  let densifyPrior: Record<string, unknown> | undefined
  let exemptFills: Map<string, Set<string>> | undefined
  if (i18nDensifyFields) {
    densifyPrior = (await ctx.prior()) ?? undefined
    exemptFills = strategy.computeExemptFills(densifyPrior, record, i18nDensifyFields)
  }

  // 3. Script enforcement.
  if (i18nFields) {
    runI18nScriptEnforcement(record, i18nFields, strategy, exemptFills, ctx, cfg)
  }

  // 4. i18nText validation — AFTER auto-translate + script so the record is
  // trustworthy. Throws MissingTranslationError when required translations
  // are absent. The vault-built closure (unchanged wiring).
  cfg.i18nPutValidator?.(record)

  // 5. Eager-fill empty slots + record provenance. Runs AFTER the authored
  // gates (required + script) so only authored slots are validated.
  if (i18nDensifyFields) {
    strategy.densify(record, densifyPrior, i18nDensifyFields)
  }

  return record
}

// ─── read pipeline ──────────────────────────────────────────────────────

/**
 * `present` — i18nText locale resolution + dictKey/staticDict label
 * resolution + `_i18nFilled` stripping. Adapted from
 * `applyLocaleToRecord`'s i18n+dict+strip portions (`collection.ts:4184-
 * 4301`) — the money-decode portion of that method is a separate binding
 * (`shape/via-money`) and is NOT this function's concern.
 */
async function runI18nPresent(
  record: Record<string, unknown>,
  ctx: ViaReadCtx,
  cfg: I18nViaConfig,
): Promise<Record<string, unknown>> {
  const i18nFields = cfg.i18nFields as Record<string, I18nTextDescriptor> | undefined
  const dictKeyFields = cfg.dictKeyFields as Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  const strategy = cfg.strategy as I18nStrategy
  const hasI18n = i18nFields !== undefined && Object.keys(i18nFields).length > 0
  const hasDict = dictKeyFields !== undefined && Object.keys(dictKeyFields).length > 0
  if (!hasI18n && !hasDict) return record

  const locale = typeof ctx.locale === 'string' ? ctx.locale : undefined
  const fallback = ctx.fallback as string | readonly string[] | undefined
  const layer = ctx.layer as Layer

  let result = record

  // i18nText / dictKey resolution require an active locale — EXCEPT a
  // static dict declaring a `displayLocale`, which resolves its
  // `<field>Label` even under a locale-less read (the hybrid hinge). Only
  // this second gate relaxes, and ONLY for static-display fields — folding
  // `hasI18n` in here would let an i18nText-only collection fall through to
  // applyI18nLocale(…, undefined) on a locale-less read, breaking the
  // raw-{th,en}-map invariant.
  const hasStaticDisplay =
    hasDict &&
    dictKeyFields !== undefined &&
    Object.values(dictKeyFields).some(
      (d) => isStaticDictDescriptor(d) && d.displayLocale !== undefined,
    )

  // Strip the internal densify marker even when no locale is active
  // (applyI18nLocale, which normally strips it, is skipped on this path).
  // Non-mutating: never touches the cached/stored record object.
  if (!locale && !hasStaticDisplay) return stripI18nFilled(result)

  // 1. i18nText resolution — guarded on `locale`, because the relaxed gate
  // above can now be entered with `locale === undefined` (static-display).
  // The layer selects the field's per-layer `onMissing` policy inside
  // applyI18nLocale.
  if (locale && hasI18n && i18nFields) {
    result = strategy.applyI18nLocale(result, i18nFields, locale, fallback, layer)
  }

  // 2. dictKey / staticDict label resolution
  if (hasDict && dictKeyFields && cfg.dictLabelResolver && locale !== 'raw') {
    const withLabels = { ...result }
    const resolver = cfg.dictLabelResolver
    for (const [field, desc] of Object.entries(dictKeyFields)) {
      // dictKey default policy is 'null' (omit/null on miss) — today's
      // behavior — unless the field declares onMissing. 'substitute'
      // walks the declared substitute chain (passed as the resolver's
      // fallback); 'throw' raises LocaleNotSpecifiedError.
      const policy = desc.onMissing ? resolvePolicy(desc.onMissing, layer) : 'null'
      const fieldFallback =
        policy === 'substitute'
          ? (fallback ?? desc.substitute)
          : fallback
      // Per-field effective locale: a static dict falls back to its
      // `displayLocale` when no locale is active (the hybrid hinge); a
      // plain dictKey with no displayLocale gets `undefined` → its
      // <field>Label is omitted on a locale-less read (today's behavior).
      const effLocale =
        locale ??
        (isStaticDictDescriptor(desc) ? desc.displayLocale : undefined)
      // Resolve one key → label | null, honoring the policy. With no
      // effective locale there is nothing to resolve against.
      const resolveKey = async (key: string): Promise<string | null> => {
        if (!effLocale) {
          if (policy === 'throw') {
            throw new LocaleNotSpecifiedError(
              field,
              `dictKey "${field}": no locale active to resolve key "${key}".`,
            )
          }
          return null
        }
        const label = await resolver(desc.name, key, effLocale, fieldFallback)
        if (label === undefined) {
          if (policy === 'throw') {
            throw new LocaleNotSpecifiedError(
              field,
              `dictKey "${field}": no label for key "${key}" in locale "${effLocale}".`,
            )
          }
          return null
        }
        return label
      }

      if (field.includes('[].')) {
        // Wildcard path `arrayKey[].leaf`: add a per-element sibling
        // `<leaf>Label`. Single level + simple leaf.
        const parts = field.split('[].')
        const arrayKey = parts[0]!
        const leaf = parts[1]
        if (!leaf || leaf.includes('.')) continue
        const arr = (withLabels as Record<string, unknown>)[arrayKey]
        if (!Array.isArray(arr)) continue
        const labelKey = `${leaf}Label`
        ;(withLabels as Record<string, unknown>)[arrayKey] = await Promise.all(
          arr.map(async (el) => {
            if (!el || typeof el !== 'object' || Array.isArray(el)) return el
            const k = (el as Record<string, unknown>)[leaf]
            if (typeof k !== 'string') return el
            return { ...(el as Record<string, unknown>), [labelKey]: await resolveKey(k) }
          }),
        )
        continue
      }

      const val = result[field]
      if (Array.isArray(val)) {
        // Array-of-keys → [{ key, label }] pair objects (key preserved).
        withLabels[`${field}Label`] = await Promise.all(
          val.map(async (k) => ({
            key: k,
            label: typeof k === 'string' ? await resolveKey(k) : null,
          })),
        )
      } else if (typeof val === 'string') {
        const label = await resolveKey(val)
        // Scalar under 'null'/default omits the label key (today's
        // behavior); 'substitute' returns a value; 'throw' threw above.
        if (label !== null) withLabels[`${field}Label`] = label
      }
    }
    result = withLabels
  }

  // Final guard: the locale-less static-display path skips
  // applyI18nLocale's strip, so ensure the densify marker never leaks here
  // either. Non-mutating (no-op when absent or already stripped above).
  return stripI18nFilled(result)
}

// ─── introspection ──────────────────────────────────────────────────────

function buildI18nDescribeFragment(cfg: I18nViaConfig): Record<string, unknown> {
  return {
    i18nFields: cfg.i18nFields ? Object.keys(cfg.i18nFields) : [],
    dictKeyFields: cfg.dictKeyFields ? Object.keys(cfg.dictKeyFields) : [],
    ...(cfg.defaultLocale !== undefined ? { defaultLocale: cfg.defaultLocale } : {}),
  }
}

// ─── binding ────────────────────────────────────────────────────────────

export function i18nBinding(cfg: I18nViaConfig): ViaBinding {
  return {
    brand: 'i18n',
    posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
    encodeWrite: async (record, ctx) => runI18nWriteStages(record, ctx, cfg),
    present: async (record, ctx) => runI18nPresent(record, ctx, cfg),
    describeFragment: () => buildI18nDescribeFragment(cfg),
  }
}

export function linkI18nVia(): void {
  installViaBinder('i18n', (c) => i18nBinding(c as I18nViaConfig))
}
