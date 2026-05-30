# Lambda container for the KMS-PDF render recipe (arm64, Node 22).
FROM public.ecr.aws/lambda/nodejs:22-arm64
# @sparticuz/chromium needs these shared libs present in the image.
RUN dnf install -y tar bzip2 && dnf clean all
WORKDIR ${LAMBDA_TASK_ROOT}
# A minimal package.json that only declares ESM. We deliberately do NOT copy the
# workspace package.json — it has `workspace:*` deps npm cannot install
# (EUNSUPPORTEDPROTOCOL). The handler bundle is self-contained except for the
# externalized native/runtime deps installed below; node resolves those from
# node_modules regardless of what package.json lists.
RUN printf '{"type":"module"}' > package.json
# Install only the runtime deps the handler needs (no hub, no cdk, no test deps).
# NOTE: pinned majors here are decoupled from the workspace lockfile — pin exact
# versions before any production use (see PR #239 known limitations).
RUN npm install --omit=dev --no-package-lock \
    @aws-sdk/client-s3@^3 @aws-sdk/client-kms@^3 qrcode@^1 puppeteer-core@^24 @sparticuz/chromium@^138
COPY dist/ ./
CMD [ "handler.handler" ]
