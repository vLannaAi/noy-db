import { describe, it, expect } from 'vitest'
import { classifyPublishFailure } from '../release/classify-publish.mjs'

/**
 * #1233 — `create-noy-db` is on its own version line and a satellite-only
 * release does not bump it, so the publish step tries to republish an existing
 * version and npm refuses with E403. Nothing needed publishing, but the job
 * exits 1 and the `Docs bridge payload` step is skipped.
 *
 * The discrimination has to be narrow. npm reports write-path AUTH failures as
 * 404, never 401, and a genuine permissions problem must still fail loudly —
 * so this matches the "cannot publish over" condition specifically, NOT E403
 * in general.
 */
describe('classifyPublishFailure (#1233)', () => {
  const alreadyPublished = `
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/create-noy-db - You cannot publish over the previously published versions: 0.3.4-pre.6.
npm error 403 In most cases, you or one of your dependencies are requesting
`.trim()

  it('a successful publish is ok', () => {
    expect(classifyPublishFailure(0, '+ create-noy-db@0.3.4-pre.7')).toBe('ok')
  })

  it('E403 "cannot publish over" is nothing-to-do, not a failure', () => {
    expect(classifyPublishFailure(1, alreadyPublished)).toBe('already-published')
  })

  it('REFUSES to tolerate a genuine permissions E403', () => {
    const forbidden = `
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/create-noy-db - You do not have permission to publish "create-noy-db". Are you logged in as the correct user?
`.trim()
    expect(classifyPublishFailure(1, forbidden)).toBe('failed')
  })

  it('REFUSES to tolerate an auth failure — npm reports those as 404, never 401', () => {
    const authFailure = `
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/create-noy-db - Not found
npm error 404 'create-noy-db@0.3.4-pre.7' is not in this registry.
`.trim()
    expect(classifyPublishFailure(1, authFailure)).toBe('failed')
  })

  it('REFUSES to tolerate an unrecognised failure', () => {
    expect(classifyPublishFailure(1, 'npm error network ETIMEDOUT')).toBe('failed')
    expect(classifyPublishFailure(1, '')).toBe('failed')
  })

  it('does not tolerate the phrase on a SUCCESSFUL-looking exit code mismatch', () => {
    // A zero exit with that phrase in the log would be incoherent; treat the
    // exit code as authoritative rather than pattern-matching the text.
    expect(classifyPublishFailure(0, alreadyPublished)).toBe('ok')
  })
})

import { orphanPeerMeta } from '../release/classify-publish.mjs'

/**
 * `peerDependenciesMeta` only ANNOTATES entries that exist in
 * `peerDependencies`. An entry with no matching peer is inert: npm never
 * learns about the package, the consumer gets no version range, and nothing
 * warns — while the manifest reads as though the dependency were declared and
 * deliberately optional.
 *
 * Found in `@noy-db/in-rest`, which marked express/fastify/hono/h3 optional
 * while declaring only `@noy-db/hub` as a peer, and genuinely imports three of
 * them from its adapter entry points.
 */
describe('orphanPeerMeta — peerDependenciesMeta without a peer is inert', () => {
  it('flags a meta entry with no matching peer', () => {
    expect(orphanPeerMeta({
      peerDependencies: { '@noy-db/hub': '1.0.0' },
      peerDependenciesMeta: { express: { optional: true } },
    })).toEqual(['express'])
  })

  it('accepts a meta entry that HAS a matching peer', () => {
    expect(orphanPeerMeta({
      peerDependencies: { express: '^5.0.0' },
      peerDependenciesMeta: { express: { optional: true } },
    })).toEqual([])
  })

  it('is quiet on manifests with neither block', () => {
    expect(orphanPeerMeta({})).toEqual([])
    expect(orphanPeerMeta({ peerDependencies: { a: '1' } })).toEqual([])
  })

  it('reports every orphan, not just the first', () => {
    expect(orphanPeerMeta({
      peerDependencies: {},
      peerDependenciesMeta: { a: { optional: true }, b: { optional: true } },
    }).sort()).toEqual(['a', 'b'])
  })
})
