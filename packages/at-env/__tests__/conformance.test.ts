/**
 * at-env against the published `NoydbSealer` contract.
 *
 * The suite lives in @noy-db/test-sealer-conformance so that "implements the
 * contract" means the same thing here, in hub's reference double, and in a
 * third party's provider — rather than one thing per package, checked against
 * each package's own reading of the interface.
 */
import { runSealerConformanceTests } from '@noy-db/test-sealer-conformance'
import { atEnv } from '../src/index.js'

// Two independently-keyed providers: the cross-provider refusal case cannot be
// demonstrated with one instance, which is why `other` is required.
const A = 'NOYDB_CONFORMANCE_KEY_A'
const B = 'NOYDB_CONFORMANCE_KEY_B'
process.env[A] = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
process.env[B] = 'f39+fXx7enl4d3Z1dHNycXBvbm1sa2poZ2ZlZGNiYWA='

runSealerConformanceTests('at-env', () => atEnv({ envVar: A }), {
  other: () => atEnv({ envVar: B }),
})
