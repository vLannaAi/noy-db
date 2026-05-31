import { App } from 'aws-cdk-lib'
import { KmsPdfAttestationStack } from './stack.js'

const app = new App()
new KmsPdfAttestationStack(app, 'NoydbKmsPdfAttestation')
app.synth()
