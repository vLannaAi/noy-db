/**
 * `@noy-db/on-shamir` satisfies hub's `NoydbShamir` port — checked by the
 * COMPILER, in the only direction the dependency graph allows.
 *
 * `shamirRecovery` is the one `on-*` entry among hub's injected ports
 * (`store`/`sealingKey`/`deviceSeal`/`mesh` are the others), and it is the
 * only one whose implementor does NOT import the contract it implements.
 * on-shamir declares its own structurally-identical copy, with the reason
 * stated in its source: *"no hub import — avoids the cycle."*
 *
 * The cycle is real and was measured, not assumed. Adding `@noy-db/hub` as a
 * peer of on-shamir installs (pnpm only WARNs) and then turbo refuses:
 *
 *     x Cyclic dependency detected:
 *     | 	@noy-db/on-shamir#build, @noy-db/hub#build
 *
 * — because hub devDepends on on-shamir for six managed-mode / recovery test
 * files that exercise REAL threshold behaviour. Swapping those onto a stub
 * would leave them green while proving nothing about k-of-n, which is the
 * whole property under test.
 *
 * So the duplication stays, and the risk it creates — the two declarations
 * drifting apart silently — is closed from the side that CAN see both. Hub
 * already depends on on-shamir, so hub can compile the satellite's factory
 * against hub's own interface. A shape change on either side fails here.
 *
 * This is a type-level file: it asserts assignability and runs nothing.
 */
import type { NoydbShamir } from '../src/index.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

// The satellite's factory must produce something hub's port accepts.
const fromSatellite: NoydbShamir = shamirRecoveryProvider()
void fromSatellite

// ...and the satellite's own exported mirror — deliberately the SAME name, so
// the duplication is legible rather than disguised — must be interchangeable
// with hub's in BOTH directions. One-way assignability would pass on a copy
// that merely ADDED members, which is exactly the drift worth catching.
import type { NoydbShamir as SatelliteContract } from '@noy-db/on-shamir'
const hubToSatellite: SatelliteContract = null as unknown as NoydbShamir
const satelliteToHub: NoydbShamir = null as unknown as SatelliteContract
void hubToSatellite
void satelliteToHub
