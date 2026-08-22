/**
 * The suite, run against hub's reference double.
 *
 * It lives HERE rather than in hub, and the reason is structural: the kit
 * peer-depends on hub, so hub consuming the kit is a build cycle (turbo
 * catches it). `@noy-db/test-adapter-conformance` never hits this because
 * the STORES consume it and hub does not — the kit is for implementors, and
 * hub is not one of its own implementors.
 *
 * Running it from this side keeps the arrow pointing one way and still gets
 * the property that matters: the double every managed-mode test depends on is
 * checked against the same contract a third party's provider is.
 *
 * That check earned itself immediately. `MemorySealer` did not detect
 * tampering — it validated only its 4-byte provider fingerprint and returned
 * corrupted plaintext for any modification after that — while
 * `NoydbSealer.unseal` says "MUST throw on tamper". Every managed-mode test in
 * hub ran against a double that could not fail the way a real provider must.
 */
import { runSealerConformanceTests } from './index.js'
import { MemorySealer } from '@noy-db/hub/at'

runSealerConformanceTests('MemorySealer (hub reference double)', () => new MemorySealer({ id: 'memory:a' }), {
  other: () => new MemorySealer({ id: 'memory:b' }),
})
