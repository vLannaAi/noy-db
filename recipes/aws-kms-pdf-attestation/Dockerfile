# Lambda container for the KMS-PDF render recipe (arm64, Node 22).
FROM public.ecr.aws/lambda/nodejs:22-arm64
# @sparticuz/chromium needs these shared libs present in the image.
RUN dnf install -y tar bzip2 && dnf clean all
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
# Install only the runtime deps the handler needs (no hub, no cdk, no test deps).
RUN npm install --omit=dev --no-package-lock \
    @aws-sdk/client-s3@^3 @aws-sdk/client-kms@^3 qrcode@^1 puppeteer-core@^24 @sparticuz/chromium@^138
COPY dist/ ./
CMD [ "handler.handler" ]
