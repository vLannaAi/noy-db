/**
 * Showcase 121 — densifyOnWrite + i18n:script-violation event (#435)
 *
 * What you'll learn
 * ─────────────────
 * Two i18n tail features that remove friction in bilingual interfaces:
 *
 *   1. `densifyOnWrite` — when a record is written with only some locale
 *      slots filled, the remaining slots are automatically filled from
 *      the substitute chain at write time ("eager fill").  Downstream
 *      readers never see an empty slot; no read-time fallback logic is
 *      needed at the app layer.  `collection.i18nProvenance(id)` tells
 *      you which slots were filled rather than authored.
 *
 *   2. `i18n:script-violation` event (filter mode) — script enforcement
 *      in `'filter'` mode silently strips disallowed characters instead
 *      of throwing.  It also emits a typed `ScriptViolationEvent` on
 *      the `db` so the application layer can log, warn, or surface the
 *      information to the user — without aborting the write.
 *
 * Why it matters
 * ──────────────
 * In a Thai/English product, a person's name is typically authored in
 * one script.  Without densifyOnWrite every read-path (reports, exports,
 * display components) must implement its own fallback.  With it, the
 * database guarantees a dense locale map at rest.
 *
 * The filter-mode event answers "what happened?" without crashing; it
 * gives you observability on dirty input (copy-paste from a mixed-script
 * clipboard, for example) without a hard gate.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 09 (withI18n basics).
 * - Showcase 94 (i18n hardening — substitute + script enforcement).
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/i18n.md (§ densifyOnWrite, § script enforcement)
 *   - docs/superpowers/specs/2026-06-20-i18n-v1x-tail-design.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → i18n-densify-on-write
 * features.yaml → features → i18n-script-violation-event
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'

// ─── Part 1: densifyOnWrite ───────────────────────────────────────────────────

describe('Showcase 121-A — densifyOnWrite: eager locale fill + provenance', () => {
  it('fills an absent en slot from the authored th value, hides the internal marker', async () => {
    // Open the vault with a collection that has densifyOnWrite on its name field.
    // The substitute chain is ['en','th'], so when en is empty the fill sources from th.
    const db = await createNoydb({
      store: memory(),
      user: 'a',
      secret: 'pw-121-densify',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('staff', { locale: 'en' })

    interface Employee { id: string; name: Record<string, string> }
    const employees = vault.collection<Employee>('employees', {
      i18nFields: {
        name: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          substitute: ['en', 'th'],
          densifyOnWrite: true,
        }),
      },
    })

    // Write a record with only the Thai name — English is intentionally absent.
    await employees.put('e1', { id: 'e1', name: { th: 'สมชาย' } })

    // An English-locale reader receives the filled value (no application-layer fallback needed).
    const e = await employees.get('e1')
    expect((e as any).name).toBe('สมชาย')

    // The raw read exposes the full dense locale map but NOT the internal provenance marker.
    // Applications should not depend on _i18nFilled — use i18nProvenance() instead.
    const raw = await employees.get('e1', { locale: 'raw' })
    expect((raw as any).name).toEqual({ th: 'สมชาย', en: 'สมชาย' })
    expect('_i18nFilled' in (raw as any)).toBe(false)

    // i18nProvenance() returns which slots were filled rather than authored.
    // This is the correct way to ask "did the database fill this, or did the user write it?".
    const provenance = await employees.i18nProvenance('e1')
    expect(provenance).toEqual({ name: ['en'] })

    db.close()
  })

  it('clears provenance when a previously-filled slot is overwritten by the author', async () => {
    // Once the user provides a real English name, the fill is replaced and
    // i18nProvenance() no longer mentions that slot — it is now authored.
    const db = await createNoydb({
      store: memory(),
      user: 'a',
      secret: 'pw-121-densify-b',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('staff', { locale: 'en' })

    interface Employee { id: string; name: Record<string, string> }
    const employees = vault.collection<Employee>('employees', {
      i18nFields: {
        name: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          substitute: ['en', 'th'],
          densifyOnWrite: true,
        }),
      },
    })

    // Initial write — en is filled from th.
    await employees.put('e2', { id: 'e2', name: { th: 'สมหญิง' } })
    expect(await employees.i18nProvenance('e2')).toEqual({ name: ['en'] })

    // Author now provides the real English transliteration.
    await employees.put('e2', { id: 'e2', name: { th: 'สมหญิง', en: 'Somying' } })

    const raw = await employees.get('e2', { locale: 'raw' })
    expect((raw as any).name.en).toBe('Somying')

    // Provenance marker is gone — both slots are now authored.
    expect(await employees.i18nProvenance('e2')).toBeUndefined()

    db.close()
  })
})

// ─── Part 2: i18n:script-violation event (filter mode) ───────────────────────

describe('Showcase 121-B — i18n:script-violation event: filter mode strips + reports', () => {
  it('strips disallowed-script chars, writes the cleaned value, and emits an event', async () => {
    // The English name field only allows Latin characters.
    // onScriptViolation: 'filter' means mixed input (e.g. a Thai character
    // pasted from the clipboard) is silently stripped rather than rejected.
    // The db emits a typed ScriptViolationEvent so the app layer can react.
    const db = await createNoydb({
      store: memory(),
      user: 'a',
      secret: 'pw-121-filter',
      i18nStrategy: withI18n(),
    })

    const violations: any[] = []
    // Subscribe BEFORE opening the vault — the event fires during the put().
    db.on('i18n:script-violation', (e) => violations.push(e))

    const vault = await db.openVault('contacts', { locale: 'en' })

    interface Contact { id: string; name: Record<string, string> }
    const contacts = vault.collection<Contact>('contacts', {
      i18nFields: {
        name: i18nText({
          languages: ['en'],
          required: 'any',
          // Latin-only script enforcement for the en slot.
          script: { en: ['Latin'] },
          // 'filter' strips violating chars and emits an event instead of throwing.
          onScriptViolation: 'filter',
        }),
      },
    })

    // Input contains Thai characters mixed into an otherwise-Latin name
    // (typical when a user copy-pastes from a mixed-script source).
    await contacts.put('c1', { id: 'c1', name: { en: 'Somสมchai' } })

    // The stored value has been cleaned — only the Latin characters remain.
    const stored = await contacts.get('c1', { locale: 'raw' })
    expect((stored as any).name.en).toBe('Somchai')

    // Exactly one violation event was emitted, describing what was stripped and why.
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      vault: 'contacts',
      collection: 'contacts',
      id: 'c1',
      mode: 'filter',
    })
    // The event's warning object identifies the field and locale that triggered it.
    expect(violations[0].warning).toMatchObject({ field: 'name', locale: 'en' })

    db.close()
  })
})
