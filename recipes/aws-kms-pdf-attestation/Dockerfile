# ALTERNATIVE packaging — self-contained container image (no public layer).
# The DEFAULT deploy is an arm64 zip + public Chromium layer (see infra/stack.ts
# + RUNBOOK.md "Container alternative"). This Dockerfile is x86_64 because the npm
# @sparticuz/chromium binary is x86-only; bundle with
# `--external:@sparticuz/chromium --external:puppeteer-core` if you use it.
FROM public.ecr.aws/lambda/nodejs:22-x86_64
# @sparticuz/chromium needs these shared libs present in the image. The
# Amazon Linux 2023 Lambda base lacks Chromium's runtime deps (libnss3.so et al);
# install the documented set so the headless browser can launch.
RUN dnf install -y tar bzip2 \
      nss nss-util nspr \
      atk at-spi2-atk at-spi2-core cups-libs \
      libdrm libxkbcommon libXcomposite libXdamage libXext libXfixes \
      libXrandr libXScrnSaver libxshmfence mesa-libgbm \
      pango cairo alsa-lib gtk3 \
    && dnf clean all
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
