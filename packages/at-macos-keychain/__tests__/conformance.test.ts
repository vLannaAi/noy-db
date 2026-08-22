/**
 * at-macos-keychain against the published `NoydbSealer` contract.
 *
 * This provider CAN run the full suite without a real Keychain, and the reason
 * is worth stating rather than assumed: the Keychain only stores the key
 * material. The sealing itself is `crypto.subtle.encrypt({ name: 'AES-GCM' })`
 * in this package's own code, so a memory-backed `KeychainEntry` swaps out the
 * key STORE and leaves every assertion — format, length checks, GCM tag
 * verification, cross-provider refusal — exercising real provider code.
 *
 * That is the opposite of at-aws-kms/at-gcp-kms/at-azure-keyvault, whose
 * `seal` IS the service call. Standing a fake in front of those would test the
 * fake; see the kit's README.
 */
import { runSealerConformanceTests } from '@noy-db/test-sealer-conformance'
import { atMacosKeychain, type KeychainEntry } from '../src/index.js'

/** Memory-backed KeychainEntry — the key store, not the cryptography. */
function memoryEntry(seed: string): KeychainEntry {
  let value: string | null = seed
  return {
    getPassword: () => value,
    setPassword: (v) => { value = v },
    deletePassword: () => { const had = value !== null; value = null; return had },
  }
}

// Two independently-keyed providers. 32 bytes base64, as the provider expects.
const KEY_A = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const KEY_B = 'f39+fXx7enl4d3Z1dHNycXBvbm1sa2poZ2ZlZGNiYWA='

runSealerConformanceTests(
  'at-macos-keychain (memory-backed key store, real AES-GCM)',
  () => atMacosKeychain({ service: 'com.acme.conformance', account: 'a@acme.test', entry: memoryEntry(KEY_A) }),
  { other: () => atMacosKeychain({ service: 'com.acme.conformance', account: 'b@acme.test', entry: memoryEntry(KEY_B) }) },
)
