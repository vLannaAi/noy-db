import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_PREFIX = 'docs'
const here = dirname(fileURLToPath(import.meta.url))

// shelfio chrome-aws-lambda arm64 layer — Chromium v149 / @sparticuz/chromium@149,
// region ap-southeast-1. Verified live via get-layer-version-by-arn
// (CompatibleArchitectures=arm64; provides nodejs/node_modules/@sparticuz/chromium).
// A region-pinned ARN: change it if you deploy elsewhere (see the recipe's README
// for the full per-region table) — https://github.com/shelfio/chrome-aws-lambda-layer
const CHROMIUM_LAYER_ARN =
  'arn:aws:lambda:ap-southeast-1:764866452798:layer:chrome-aws-lambda-arm64:9'

/**
 * KMS-PDF render Lambda — ZIP function on arm64 (Graviton) with Chromium supplied
 * by a public Lambda layer (no container image / ECR).
 *
 * Why this shape (measured trade-off vs. a container image):
 *  - arm64: ~20% cheaper GB-s at identical render performance. The npm
 *    @sparticuz/chromium binary is x86-only, but the layer ships a native arm64
 *    build, so the layer route is what unlocks Graviton here.
 *  - artifact: ~1.7 MB zip + the AWS-hosted 66 MB layer (you store/push nothing),
 *    vs. a ~527 MB ECR image.
 *  - no Docker in the deploy path.
 * The container variant remains available in `Dockerfile` (see RUNBOOK.md
 * "Container alternative") for air-gapped/self-contained deployments that can't
 * depend on a third-party public layer.
 */
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

    // Deploy-time: Secrets Manager generates a random share-signing secret. The
    // plaintext appears in NEITHER the template NOR CloudFormation state (the
    // native construct holds only an ARN reference); the function reads the value
    // at cold-start via GetSecretValue. Separate from the doc-sealing KMS key, so
    // rotating share-signing never touches data access.
    const shareSecret = new secretsmanager.Secret(this, 'ShareSecret', {
      description: 'noy-db attestation: HMAC secret for share-link minting/verification',
      removalPolicy: RemovalPolicy.DESTROY, // recipe/demo: destroy on teardown
      generateSecretString: {
        // 64 hex chars = 256 bits of entropy; ASCII so it round-trips as utf8.
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 64,
      },
    })

    const fn = new lambda.Function(this, 'RenderFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      // dist/handler.cjs bundles puppeteer-core but externalizes
      // @sparticuz/chromium, which the layer provides at /opt/nodejs/node_modules.
      // Run `pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation run bundle` first.
      code: lambda.Code.fromAsset(join(here, '..', 'dist')),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'ChromiumLayer', CHROMIUM_LAYER_ARN),
      ],
      memorySize: 2048,
      timeout: Duration.seconds(30),
      environment: {
        DOCS_BUCKET: bucket.bucketName,
        KMS_KEY_ID: key.keyArn,
        DOCS_PREFIX,
        // ARN, not the value — the function reads it via GetSecretValue at init.
        SHARE_SECRET_ARN: shareSecret.secretArn,
      },
    })

    // Least privilege: decrypt with the one key + read the one prefix + read the secret.
    key.grantDecrypt(fn)
    bucket.grantRead(fn, `${DOCS_PREFIX}/*`)
    shareSecret.grantRead(fn)

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })
    new CfnOutput(this, 'FunctionUrl', { value: url.url })
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName })
    new CfnOutput(this, 'KeyArn', { value: key.keyArn })
  }
}
