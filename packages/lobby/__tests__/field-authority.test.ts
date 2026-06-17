import { describe, it, expect } from 'vitest'
import {
  resolveFieldAuthority,
  resolveRecordByFieldAuthority,
  type FieldAuthorityPolicy,
} from '../src/interchange/field-authority'

describe('resolveFieldAuthority (pure)', () => {
  it('source-newest: newer incoming origin wins', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2022-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('incoming')
  })
  it('source-newest: older incoming keeps local', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2020-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
  })
  it('source-newest: tie keeps local; missing incoming keeps local; missing local takes incoming', () => {
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2021-01-01T00:00:00Z', localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { localSourceTs: '2021-01-01T00:00:00Z' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'source-newest' },
      { incomingSourceTs: '2021-01-01T00:00:00Z' })).toBe('incoming')
  })
  it('owner: incoming wins only when its _source matches ownerSource', () => {
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' },
      { incomingSource: 'principal-X' })).toBe('incoming')
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' },
      { incomingSource: 'firm-B', localSource: 'principal-X' })).toBe('local')
    expect(resolveFieldAuthority({ authority: 'owner', ownerSource: 'principal-X' }, {})).toBe('local')
  })
  it('fixed-source: incoming wins only when its _source matches', () => {
    expect(resolveFieldAuthority({ authority: 'fixed-source', source: 'dbd-registry' },
      { incomingSource: 'dbd-registry' })).toBe('incoming')
    expect(resolveFieldAuthority({ authority: 'fixed-source', source: 'dbd-registry' },
      { incomingSource: 'firm-B' })).toBe('local')
  })
})

describe('resolveRecordByFieldAuthority (pure)', () => {
  it('merges per field: registry→newest-source, sovereign→owner, unlisted→local', () => {
    const policy: FieldAuthorityPolicy = {
      juristicName: { authority: 'source-newest' },
      nickname: { authority: 'owner', ownerSource: 'principal-X' },
    }
    const before = { id: 'c1', juristicName: 'Old Co', nickname: 'localNick', secret: 'keepme' }
    const incoming = { id: 'c1', juristicName: 'New Co', nickname: 'theirNick', secret: 'clobber' }
    const { merged, decisions } = resolveRecordByFieldAuthority(
      policy, before, incoming,
      ['juristicName', 'nickname', 'secret'],
      { incomingSource: 'firm-B', incomingSourceTs: '2022-01-01T00:00:00Z',
        localSource: 'principal-X', localSourceTs: '2021-01-01T00:00:00Z' },
    )
    expect(merged.juristicName).toBe('New Co')   // source-newest: incoming newer
    expect(merged.nickname).toBe('localNick')    // owner: incoming not principal-X → local
    expect(merged.secret).toBe('keepme')         // unlisted → local
    expect(decisions).toEqual({ juristicName: 'incoming', nickname: 'local', secret: 'local' })
  })
})
