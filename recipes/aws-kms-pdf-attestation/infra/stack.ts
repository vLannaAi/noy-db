import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_PREFIX = 'docs'
const here = dirname(fileURLToPath(import.meta.url))

export class KmsPdfAttestationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const key = new kms.Key(this, 'DocSealingKey', {
      description: 'noy-db attestation: seals render payloads for the PDF Lambda',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY, // recipe/demo: destroy on teardown
    })

    const bucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // recipe/demo
    })

    // x86_64: @sparticuz/chromium ships an x86_64 Chromium binary via npm (no
    // arm64 build), so the Lambda arch + image platform must be x86_64 or the
    // browser fails to launch (qemu can't run the x86 binary on arm64).
    const fn = new lambda.DockerImageFunction(this, 'RenderFn', {
      code: lambda.DockerImageCode.fromImageAsset(join(here, '..'), {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      timeout: Duration.seconds(30),
      environment: { DOCS_BUCKET: bucket.bucketName, KMS_KEY_ID: key.keyArn, DOCS_PREFIX },
    })

    // Least privilege: decrypt with the one key + read the one prefix.
    key.grantDecrypt(fn)
    bucket.grantRead(fn, `${DOCS_PREFIX}/*`)

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })
    new CfnOutput(this, 'FunctionUrl', { value: url.url })
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName })
    new CfnOutput(this, 'KeyArn', { value: key.keyArn })
  }
}
