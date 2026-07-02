/**
 * Golden public-API freeze for the microkernel classes (S5 Task 8).
 *
 * `Noydb` / `Vault` / `Collection` are the three classes the entire family
 * (satellites, klum-db's lobby, showcases) programs against. This freezes
 * their public prototype surface (own property names on `.prototype`, minus
 * `constructor` and `_`-prefixed internals) against a checked-in baseline
 * (`kernel-api.golden.json`) so drift fails CI:
 *   - ADDING a public method/getter fails until the baseline is updated (visible, reviewed).
 *   - REMOVING / RENAMING one fails loudly.
 *
 * This baseline is maintained by future PRs consciously editing it — it is
 * not meant to stay static forever, just to make every change to the kernel
 * API surface a deliberate, reviewed diff instead of a silent one.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Noydb } from '../src/kernel/noydb.js'
import { Vault } from '../src/kernel/vault.js'
import { Collection } from '../src/kernel/collection.js'

const golden = JSON.parse(readFileSync(join(__dirname, 'kernel-api.golden.json'), 'utf8'))

const publicApi = (proto: object) =>
  Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && !n.startsWith('_'))
    .sort()

describe('kernel API manifest (the microkernel interface — additions and removals are deliberate baseline edits)', () => {
  it.each([
    ['Noydb', Noydb.prototype],
    ['Vault', Vault.prototype],
    ['Collection', Collection.prototype],
  ] as const)('%s public surface is frozen', (name, proto) => {
    expect(publicApi(proto)).toEqual(golden[name])
  })
})
