/**
 * at-aws-kms cannot run the full NoydbSealer suite without a real KMS: its
 * `seal` IS an `EncryptCommand`, so tamper and cross-provider refusal are
 * AWS's behaviour, not this package's. What IS this package's — surfacing a
 * failure and not fabricating output — is covered here with a stub client.
 */
import { runDelegatingSealerObligations } from '@noy-db/test-sealer-conformance'
import { atAwsKms } from '../src/index.js'

const rejecting = { send: async () => { throw new Error('KMS: AccessDeniedException') } }
const empty = { send: async () => ({}) } // resolves with neither CiphertextBlob nor Plaintext

runDelegatingSealerObligations('at-aws-kms', {
  rejecting: () => atAwsKms({ keyId: 'arn:aws:kms:us-east-1:1:key/x', client: rejecting as never }),
  empty: () => atAwsKms({ keyId: 'arn:aws:kms:us-east-1:1:key/x', client: empty as never }),
})
