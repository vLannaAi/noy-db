/**
 * Task 11 — the `'find'` consent op + the `'*'` sweep-marker non-collision
 * golden.
 *
 * `findByDigest` (Task 13) reports access via `onAccess('find', '*')` — a
 * NEW consent-recordId sentinel meaning "no single record" (a sweep, not a
 * per-id read). This test locks two things:
 *   1. `'find'` is a member of the public `ConsentOp` union (see the
 *      three-site widening checklist in consent.ts:77).
 *   2. `'*'` can never collide with a real store id — ids are ULIDs
 *      (`generateULID()` / `isULID()` from with-pod/ulid.js), and `'*'` is
 *      not a syntactically valid ULID.
 */
import { describe, it, expect } from 'vitest'
import type { ConsentOp } from '../../src/with-audit/consent/consent.js'
import { generateULID, isULID } from '../../src/with-pod/ulid.js'

describe("'find' consent op + '*' sentinel", () => {
  it("'find' is assignable to ConsentOp", () => {
    const op: ConsentOp = 'find'
    expect(op).toBe('find')
  })

  it("the '*' sweep marker is not a syntactically valid ULID", () => {
    expect(isULID('*')).toBe(false)
  })

  it('a generated id is never the sweep marker and is always a valid ULID', () => {
    const id = generateULID()
    expect(id).not.toBe('*')
    expect(isULID(id)).toBe(true)
  })
})
