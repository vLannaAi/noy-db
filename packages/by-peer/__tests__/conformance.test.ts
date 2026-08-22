/**
 * by-peer against the published `NoydbMesh` contract.
 *
 * `pairInMemory()` gives two connected `PeerChannel`s, and
 * `channelCoordination()` is the transport-agnostic protocol both by-peer and
 * by-tabs run over one — so this exercises the real coordination code, with
 * only the wire swapped for an in-process pair.
 */
import { runMeshConformanceTests } from '@noy-db/test-mesh-conformance'
import { pairInMemory } from '../src/channel.js'
import { channelCoordination } from '../src/coordination.js'

runMeshConformanceTests('by-peer (channelCoordination over pairInMemory)', {
  pair: () => {
    const [x, y] = pairInMemory()
    return [channelCoordination(x), channelCoordination(y)] as const
  },
})
