/**
 * at-gcp-kms delegates to Cloud KMS encrypt/decrypt, so the cryptographic
 * contract is the service's. These pin the two obligations that are this
 * package's own: surface a failure, and never fabricate output.
 */
import { runDelegatingSealerObligations } from '@noy-db/test-sealer-conformance'
import { atGcpKms } from '../src/index.js'

const rejecting = {
  encrypt: async () => { throw new Error('KMS: PERMISSION_DENIED') },
  decrypt: async () => { throw new Error('KMS: PERMISSION_DENIED') },
}
const empty = { encrypt: async () => [{}], decrypt: async () => [{}] }

runDelegatingSealerObligations('at-gcp-kms', {
  rejecting: () => atGcpKms({ keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', client: rejecting as never }),
  empty: () => atGcpKms({ keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', client: empty as never }),
})
