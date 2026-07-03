/**
 * noy-db's own reference enclave, run through the conformance kit.
 *
 * `kernel/enclave/index.ts` has no public `@noy-db/hub/enclave` subpath —
 * per Enclave Contract v1 (see
 * docs/superpowers/specs/2026-07-03-enclave-contract-v1-design.md) it is a
 * fork-swap contract a sister repo replaces wholesale by editing the folder
 * directly, not a runtime-injectable seam — so this test imports the barrel
 * by relative path, same as `packages/hub/__tests__/enclave-surface-golden.test.ts`
 * does from inside the hub package itself.
 *
 * This IS the reference implementation, so every optional group is
 * supported and the suite must be fully green.
 */
import * as enclave from '../../../packages/hub/src/kernel/enclave/index.js'
import { runEnclaveConformance } from './index.js'

runEnclaveConformance(enclave, {
  supports: { sealing: true, deterministic: true, perRecordKeys: true },
})
