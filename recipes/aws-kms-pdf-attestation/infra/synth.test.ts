import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { KmsPdfAttestationStack } from './stack.js'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')

describe('CDK stack synthesizes', () => {
  beforeAll(() => {
    // Code.fromAsset('dist') needs a non-empty dir at synth time. The real
    // handler is produced by `npm run bundle`; for a hermetic test we just
    // ensure a placeholder exists if the bundle hasn't been built.
    if (!existsSync(join(distDir, 'handler.cjs'))) {
      mkdirSync(distDir, { recursive: true })
      writeFileSync(join(distDir, 'handler.cjs'), 'exports.handler = async () => ({})\n')
    }
  })

  it('declares the KMS key, private bucket, arm64 zip Lambda + Chromium layer, and Function URL', () => {
    const app = new App()
    const stack = new KmsPdfAttestationStack(app, 'Test')
    const t = Template.fromStack(stack)
    t.resourceCountIs('AWS::KMS::Key', 1)
    t.resourceCountIs('AWS::S3::Bucket', 1)
    // Zip package (no PackageType: Image), arm64, with at least one layer attached.
    t.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      MemorySize: 2048,
      Runtime: 'nodejs22.x',
    })
    t.resourceCountIs('AWS::Lambda::Url', 1)
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true },
    })
    // The render function references the public Chromium layer ARN.
    const fns = t.findResources('AWS::Lambda::Function')
    const hasLayer = Object.values(fns).some(
      (r) => Array.isArray((r as { Properties?: { Layers?: unknown[] } }).Properties?.Layers)
        && ((r as { Properties: { Layers: unknown[] } }).Properties.Layers.length > 0),
    )
    expect(hasLayer).toBe(true)

    // The render function carries the KMS-sealed share secret as an env var.
    const renderFn = Object.values(fns).find(
      (r) => (r as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables?.['SHARE_SECRET_CIPHERTEXT'] !== undefined,
    )
    expect(renderFn).toBeDefined()
  })
})
