/**
 * #806 — portal share-link grammar + parse/build helper.
 *
 * One canonical link shape addresses vault / period / collection /
 * record across the LIFF permalink, PWA, and vendor-console surfaces:
 *
 *   /r/{vaultHandle}/{collection}/{recordId}[?period=…][&v=…][#g={token}]
 *
 * Covered here: build/parse round-trips for every part combination and
 * input form (relative, based, full URL, URL instance, LIFF permalink),
 * the fragment-only grant-token transport rule, and the fail-closed
 * catalogue (unknown prefix, missing/extra/empty/non-canonical
 * segments, non-ULID vault handles, dot-segment + %2F injection,
 * duplicate/unknown query keys, malformed fragments).
 */
import { describe, it, expect } from 'vitest'
import {
  buildShareLink,
  parseShareLink,
  ShareLinkParseError,
  type ShareLinkParts,
} from '../src/share-link/index.js'

const VAULT = '01HZY3Q4X0T9GJK5M8N2P7RSTV' // valid Crockford ULID shape
const LIFF_BASE = 'https://liff.line.me/1656008674-Ab1Cd2Ef'
const PWA_BASE = 'https://portal.example.com'

function expectParseError(input: string | URL, code: string): void {
  let caught: unknown
  try {
    parseShareLink(input)
  } catch (e) {
    caught = e
  }
  expect(caught, `expected ${String(input)} to fail closed`).toBeInstanceOf(ShareLinkParseError)
  expect((caught as ShareLinkParseError).code).toBe(code)
}

describe('#806 share-link — build/parse round-trip', () => {
  const combos: Array<[string, ShareLinkParts]> = [
    ['minimal', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001' }],
    ['period', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', period: '2026-Q2' }],
    ['version', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', version: 0 }],
    ['grant token', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', grantToken: 'tok_abc123' }],
    ['period+version', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', period: '2026-Q2', version: 7 }],
    ['period+token', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', period: '2026-Q2', grantToken: 'tok_abc123' }],
    ['version+token', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', version: 12, grantToken: 'tok_abc123' }],
    ['all parts', { vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001', period: '2026-Q2', version: 12, grantToken: 'tok_abc123' }],
  ]

  it.each(combos)('round-trips with %s', (_name, parts) => {
    const link = buildShareLink(parts)
    expect(link.startsWith('/r/')).toBe(true)
    expect(parseShareLink(link)).toEqual(parts)
  })

  it('parse result carries no absent optional keys', () => {
    const parsed = parseShareLink(`/r/${VAULT}/invoices/inv-001`)
    expect(Object.keys(parsed).sort()).toEqual(['collection', 'recordId', 'vaultHandle'])
  })

  it('canonical part order: period before v, fragment last', () => {
    const link = buildShareLink({
      vaultHandle: VAULT, collection: 'c', recordId: 'r',
      period: 'p1', version: 3, grantToken: 't',
    })
    expect(link).toBe(`/r/${VAULT}/c/r?period=p1&v=3#g=t`)
  })
})

describe('#806 share-link — the three surfaces (base + input forms)', () => {
  const parts: ShareLinkParts = {
    vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-001',
    period: '2026-Q2', version: 3, grantToken: 'tok_abc123',
  }

  it('base is prepended verbatim and the result still parses (PWA origin)', () => {
    const link = buildShareLink(parts, PWA_BASE)
    expect(link.startsWith(`${PWA_BASE}/r/${VAULT}/`)).toBe(true)
    expect(parseShareLink(link)).toEqual(parts)
  })

  it('LIFF permalink base round-trips (prefix tolerance on parse)', () => {
    const link = buildShareLink(parts, LIFF_BASE)
    expect(link.startsWith(`${LIFF_BASE}/r/`)).toBe(true)
    expect(parseShareLink(link)).toEqual(parts)
  })

  it('accepts a URL instance', () => {
    expect(parseShareLink(new URL(buildShareLink(parts, PWA_BASE)))).toEqual(parts)
    expect(parseShareLink(new URL(buildShareLink(parts, LIFF_BASE)))).toEqual(parts)
  })

  it('LIFF fallback takes the FIRST /r/ segment boundary', () => {
    // Collection literally named "r" after the real /r/ prefix — the
    // fallback must not re-anchor deeper into the path.
    const parsed = parseShareLink(`${LIFF_BASE}/r/${VAULT}/r/rec`)
    expect(parsed).toEqual({ vaultHandle: VAULT, collection: 'r', recordId: 'rec' })
  })

  it('LIFF fallback fires only when the direct parse fails', () => {
    // Same-origin path starting with /r/ is parsed directly even though
    // a second /r/ appears later as data.
    const parsed = parseShareLink(`${PWA_BASE}/r/${VAULT}/docs/r`)
    expect(parsed).toEqual({ vaultHandle: VAULT, collection: 'docs', recordId: 'r' })
  })
})

describe('#806 share-link — grant-token transport rule (fragment only)', () => {
  it('the token never appears in the path or query on build', () => {
    const token = 'SECRET-single-use-token'
    const link = buildShareLink({
      vaultHandle: VAULT, collection: 'c', recordId: 'r',
      period: 'p', version: 1, grantToken: token,
    })
    const [serverVisible, fragment] = link.split('#') as [string, string]
    expect(serverVisible).not.toContain(token)
    expect(fragment).toBe(`g=${token}`)
  })

  it('a token offered via query is refused, never accepted', () => {
    expectParseError(`/r/${VAULT}/c/r?g=token`, 'UNKNOWN_QUERY_KEY')
  })

  it('token round-trips through the fragment, encoded', () => {
    const grantToken = 'tok/with?reserved#chars&=+%'
    const link = buildShareLink({ vaultHandle: VAULT, collection: 'c', recordId: 'r', grantToken })
    expect(link.split('#')[0]).not.toContain('with?reserved')
    expect(parseShareLink(link).grantToken).toBe(grantToken)
  })
})

describe('#806 share-link — fail closed: prefixes and URL forms', () => {
  it.each([
    ['no leading slash', `r/${VAULT}/c/r`, 'UNKNOWN_PREFIX'],
    ['wrong prefix', `/records/${VAULT}/c/r`, 'UNKNOWN_PREFIX'],
    ['no /r/ anywhere in a full URL', `${PWA_BASE}/x/${VAULT}/c/r`, 'UNKNOWN_PREFIX'],
    ['bare /r with nothing after', '/r', 'UNKNOWN_PREFIX'],
    ['non-http(s) scheme', `ftp://host/r/${VAULT}/c/r`, 'UNKNOWN_PREFIX'],
    ['scheme-relative-ish garbage', `liff.line.me/app/r/${VAULT}/c/r`, 'UNKNOWN_PREFIX'],
  ])('%s → UNKNOWN_PREFIX', (_n, input, code) => {
    expectParseError(input, code)
  })

  it('URL instance with a non-http(s) protocol fails closed', () => {
    expectParseError(new URL(`line://app/r/${VAULT}/c/r`), 'UNKNOWN_PREFIX')
  })

  it('never falls back to a default vault: result is a throw, not a value', () => {
    expect(() => parseShareLink('/r/')).toThrow(ShareLinkParseError)
    expect(() => parseShareLink(PWA_BASE)).toThrow(ShareLinkParseError)
  })
})

describe('#806 share-link — fail closed: path segments', () => {
  it.each([
    ['missing recordId', `/r/${VAULT}/c`, 'MALFORMED_PATH'],
    ['missing collection + recordId', `/r/${VAULT}`, 'MALFORMED_PATH'],
    ['extra trailing segment', `/r/${VAULT}/c/r/extra`, 'MALFORMED_PATH'],
    ['trailing slash after full path', `/r/${VAULT}/c/r/`, 'MALFORMED_PATH'],
    ['empty vault segment', '/r//c/r', 'MALFORMED_SEGMENT'],
    ['empty collection segment', `/r/${VAULT}//r`, 'MALFORMED_SEGMENT'],
    ['empty recordId (trailing slash)', `/r/${VAULT}/c/`, 'MALFORMED_SEGMENT'],
    ['non-canonical + in segment', `/r/${VAULT}/a+b/r`, 'MALFORMED_SEGMENT'],
    ['non-canonical %61 (over-encoded)', `/r/${VAULT}/%61bc/r`, 'MALFORMED_SEGMENT'],
    ['lowercase hex escape', `/r/${VAULT}/a%2fb/r`, 'MALFORMED_SEGMENT'],
    ['truncated percent escape', `/r/${VAULT}/a%2/r`, 'MALFORMED_SEGMENT'],
    ['invalid percent escape', `/r/${VAULT}/a%GGb/r`, 'MALFORMED_SEGMENT'],
    ['raw @ is not canonical', `/r/${VAULT}/a@b/r`, 'MALFORMED_SEGMENT'],
  ])('%s → fail closed', (_n, input, code) => {
    expectParseError(input, code)
  })

  it.each([
    ['too short', VAULT.slice(0, 25)],
    ['too long', `${VAULT}0`],
    ['lowercase', VAULT.toLowerCase()],
    ['excluded Crockford letters', `${VAULT.slice(0, 22)}ILOU`],
    ['not a ulid at all', 'customer-vault'],
  ])('non-ULID vault handle (%s) → INVALID_VAULT_HANDLE', (_n, handle) => {
    expectParseError(`/r/${handle}/c/r`, 'INVALID_VAULT_HANDLE')
  })

  it('dot-segment injection collapses under URL normalization and fails closed', () => {
    // "/.." eats the vault segment → wrong arity, never a re-anchored path.
    expectParseError(`/r/${VAULT}/../r`, 'MALFORMED_PATH')
    expectParseError(`/r/${VAULT}/%2E%2E/r`, 'MALFORMED_PATH')
    expectParseError(`/r/${VAULT}/c/..`, 'MALFORMED_PATH')
  })

  it('double-encoded %252E decodes ONCE to the literal string "%2E%2E" — no second decode, no dot segment', () => {
    // Single decode is the contract: the value is the opaque collection
    // name "%2E%2E", never re-decoded into "..".
    expect(parseShareLink(`/r/${VAULT}/%252E%252E/r`)).toEqual({
      vaultHandle: VAULT, collection: '%2E%2E', recordId: 'r',
    })
  })

  it('buildShareLink refuses "." and ".." segments outright', () => {
    for (const bad of ['.', '..']) {
      expect(() => buildShareLink({ vaultHandle: VAULT, collection: bad, recordId: 'r' }))
        .toThrow(ShareLinkParseError)
      expect(() => buildShareLink({ vaultHandle: VAULT, collection: 'c', recordId: bad }))
        .toThrow(ShareLinkParseError)
    }
  })

  it('%2F inside a segment decodes to a slash WITHOUT creating extra segments', () => {
    const parts: ShareLinkParts = { vaultHandle: VAULT, collection: 'a/b', recordId: 'x/y/z' }
    const link = buildShareLink(parts)
    expect(link).toBe(`/r/${VAULT}/a%2Fb/x%2Fy%2Fz`)
    expect(parseShareLink(link)).toEqual(parts)
    // Direct wire form, same guarantee.
    expect(parseShareLink(`/r/${VAULT}/a%2Fb/rec`)).toEqual({
      vaultHandle: VAULT, collection: 'a/b', recordId: 'rec',
    })
  })
})

describe('#806 share-link — fail closed: query', () => {
  it.each([
    ['duplicate period', `/r/${VAULT}/c/r?period=a&period=b`, 'DUPLICATE_QUERY_KEY'],
    ['duplicate v', `/r/${VAULT}/c/r?v=1&v=2`, 'DUPLICATE_QUERY_KEY'],
    ['unknown key', `/r/${VAULT}/c/r?foo=1`, 'UNKNOWN_QUERY_KEY'],
    ['tracking key', `/r/${VAULT}/c/r?period=a&utm_source=line`, 'UNKNOWN_QUERY_KEY'],
    ['case-sensitive keys', `/r/${VAULT}/c/r?Period=a`, 'UNKNOWN_QUERY_KEY'],
    ['bare key without =', `/r/${VAULT}/c/r?period`, 'MALFORMED_QUERY'],
    ['empty key', `/r/${VAULT}/c/r?=x`, 'MALFORMED_QUERY'],
    ['dangling &', `/r/${VAULT}/c/r?period=a&`, 'MALFORMED_QUERY'],
    ['empty period value', `/r/${VAULT}/c/r?period=`, 'MALFORMED_QUERY'],
    ['non-canonical period (+ as space)', `/r/${VAULT}/c/r?period=a+b`, 'MALFORMED_QUERY'],
  ])('%s → fail closed', (_n, input, code) => {
    expectParseError(input, code)
  })

  it.each([
    ['leading zero', '01'],
    ['negative', '-1'],
    ['float', '1.5'],
    ['exponent', '1e3'],
    ['non-numeric', 'abc'],
    ['empty', ''],
    ['beyond 2^53-1', '9007199254740992'],
  ])('version "%s" → INVALID_VERSION', (_n, v) => {
    expectParseError(`/r/${VAULT}/c/r?v=${v}`, 'INVALID_VERSION')
  })

  it('version at exactly 2^53-1 parses', () => {
    expect(parseShareLink(`/r/${VAULT}/c/r?v=9007199254740991`).version).toBe(9007199254740991)
  })
})

describe('#806 share-link — fail closed: fragment', () => {
  it.each([
    ['unknown fragment shape', `/r/${VAULT}/c/r#token`, 'MALFORMED_FRAGMENT'],
    ['wrong fragment key', `/r/${VAULT}/c/r#t=abc`, 'MALFORMED_FRAGMENT'],
    ['empty token', `/r/${VAULT}/c/r#g=`, 'MALFORMED_FRAGMENT'],
    ['non-canonical token', `/r/${VAULT}/c/r#g=a+b`, 'MALFORMED_FRAGMENT'],
  ])('%s → MALFORMED_FRAGMENT', (_n, input, code) => {
    expectParseError(input, code)
  })

  it('a lone "#" is treated as no fragment', () => {
    expect(parseShareLink(`/r/${VAULT}/c/r#`).grantToken).toBeUndefined()
  })
})

describe('#806 share-link — buildShareLink fail closed (INVALID_PARTS)', () => {
  const good: ShareLinkParts = { vaultHandle: VAULT, collection: 'c', recordId: 'r' }

  const badParts: Array<[string, ShareLinkParts]> = [
    ['non-ULID vaultHandle', { ...good, vaultHandle: 'nope' }],
    ['empty collection', { ...good, collection: '' }],
    ['empty recordId', { ...good, recordId: '' }],
    ['empty period', { ...good, period: '' }],
    ['empty grantToken', { ...good, grantToken: '' }],
    ['negative version', { ...good, version: -1 }],
    ['float version', { ...good, version: 1.5 }],
    ['unsafe-integer version', { ...good, version: 2 ** 53 }],
  ]

  it.each(badParts)('%s throws INVALID_PARTS', (_n, parts) => {
    let caught: unknown
    try {
      buildShareLink(parts)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ShareLinkParseError)
    expect((caught as ShareLinkParseError).code).toBe('INVALID_PARTS')
  })
})

describe('#806 share-link — i18n-safe encoding', () => {
  it('Unicode collection/record/period round-trip (Thai, Polish, emoji)', () => {
    const parts: ShareLinkParts = {
      vaultHandle: VAULT,
      collection: 'ลูกค้า',
      recordId: 'faktura-śląsk-🧾',
      period: 'ปี-2569',
    }
    const link = buildShareLink(parts, LIFF_BASE)
    expect(parseShareLink(link)).toEqual(parts)
    // The wire form is pure percent-encoded ASCII after the base.
    expect(link.slice(LIFF_BASE.length)).toMatch(/^[\x21-\x7E]+$/)
  })

  it('property-ish: tricky strings round-trip as every opaque part', () => {
    const tricky = [
      'a b', 'a/b', 'a\\b', 'a?b', 'a#b', 'a&b', 'a=b', 'a%b', '%2F',
      '..x', 'x..', 'a.b.c', '+', '&', '=', '?', '#', '%', ' ',
      "a'b", 'a(b)*c!~', 'ID_with-mixed.chars', 'ปี-2569/ไตรมาส:1',
      '🧾🔗', 'ｱｲｳ ｴｵ', 'x'.repeat(512),
    ]
    for (const s of tricky) {
      const parts: ShareLinkParts = {
        vaultHandle: VAULT, collection: s, recordId: s, period: s, grantToken: s,
      }
      const link = buildShareLink(parts)
      expect(parseShareLink(link), `round-trip failed for ${JSON.stringify(s)}`).toEqual(parts)
      // And through a full-URL carry, as each surface would transport it.
      expect(parseShareLink(`${LIFF_BASE}${link}`)).toEqual(parts)
    }
  })
})
