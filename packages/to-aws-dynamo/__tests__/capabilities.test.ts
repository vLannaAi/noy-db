import { describe, it, expect } from 'vitest'
import { dynamo } from '../src/index.js'

// Regression for #321 — `dynamo()` documented `casAtomic: true` (it does
// atomic CAS via a ConditionExpression on `_v`) but never populated
// `capabilities`, so `vault.sequence().next()` threw SequenceOfflineError
// against DynamoDB — the recommended production backend for gap-free
// fiscal numbering. Construction is offline (the client is lazy), so this
// needs no real AWS access.
describe('dynamo() capabilities (#321)', () => {
  it('advertises casAtomic:true (ConditionExpression CAS) with an iam auth descriptor', () => {
    const caps = dynamo({ table: 't', region: 'eu-west-1' }).capabilities
    expect(caps).toBeDefined()
    expect(caps?.casAtomic).toBe(true)
    expect(caps?.auth.kind).toBe('iam')
  })
})
