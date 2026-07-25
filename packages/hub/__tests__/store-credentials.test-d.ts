/**
 * Type-level tests for the `StoreCredentials` union on the `@noy-db/hub/to`
 * seam (#479 landed `'aws' | 'token'`; #795 added the additive `'password'`
 * connection-auth variant for to-postgres/to-mysql user+password and to-smb
 * NTLM via `domain`). Validated by `pnpm --filter @noy-db/hub typecheck`
 * (`tsconfig.typetest.json`) — vitest never runs this file.
 *
 * Key-shaped auth (`kind: 'key'`) is deliberately absent — to-ssh is
 * keys-only by design and may refuse brokered keys entirely (#795 defers it).
 */
import { describe, it, expectTypeOf } from 'vitest'
import type { StoreCredentials, StoreCredentialSource } from '../src/port/to/index.js'

describe("StoreCredentials — the #795 kind:'password' variant", () => {
  it('accepts the full NTLM shape (username/password/domain/expiresAt)', () => {
    expectTypeOf<{
      kind: 'password'
      username: string
      password: string
      domain: string
      expiresAt: string
    }>().toMatchTypeOf<StoreCredentials>()
  })

  it('`domain` and `expiresAt` are optional — the bare postgres/mysql shape is assignable', () => {
    expectTypeOf<{
      kind: 'password'
      username: string
      password: string
    }>().toMatchTypeOf<StoreCredentials>()
  })

  it('narrowing on the discriminant exposes username/password', () => {
    const narrow = (creds: StoreCredentials): string => {
      if (creds.kind === 'password') {
        expectTypeOf(creds.username).toEqualTypeOf<string>()
        expectTypeOf(creds.password).toEqualTypeOf<string>()
        expectTypeOf(creds.domain).toEqualTypeOf<string | undefined>()
        return creds.username
      }
      return creds.kind
    }
    expectTypeOf(narrow).returns.toEqualTypeOf<string>()
  })

  it('the union is exactly aws | token | password (exhaustiveness)', () => {
    expectTypeOf<StoreCredentials['kind']>().toEqualTypeOf<'aws' | 'token' | 'password'>()
    // A switch on `kind` covering all three arms leaves `never` — a fourth
    // variant added later must consciously extend this check.
    const exhaust = (creds: StoreCredentials): string => {
      switch (creds.kind) {
        case 'aws': return creds.accessKeyId
        case 'token': return creds.token
        case 'password': return creds.username
        default: return creds satisfies never
      }
    }
    expectTypeOf(exhaust).returns.toEqualTypeOf<string>()
  })

  it('a password-minting source satisfies StoreCredentialSource', () => {
    const source = async (): Promise<StoreCredentials> => ({
      kind: 'password', username: 'svc', password: 'pw',
    })
    expectTypeOf(source).toMatchTypeOf<StoreCredentialSource>()
  })
})
