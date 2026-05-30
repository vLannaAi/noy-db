import { describe, it, expect } from 'vitest'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { KmsPdfAttestationStack } from './stack.js'

describe('CDK stack synthesizes', () => {
  it('declares the KMS key, private bucket, container Lambda, and Function URL', () => {
    const app = new App()
    const stack = new KmsPdfAttestationStack(app, 'Test')
    const t = Template.fromStack(stack)
    t.resourceCountIs('AWS::KMS::Key', 1)
    t.resourceCountIs('AWS::S3::Bucket', 1)
    t.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', Architectures: ['arm64'], MemorySize: 2048 })
    t.resourceCountIs('AWS::Lambda::Url', 1)
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true },
    })
    expect(true).toBe(true)
  })
})
