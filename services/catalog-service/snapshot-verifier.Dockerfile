FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# Public corporate CA is optional; a stale staged file never enables trust by itself.
ARG NEUROCENTER_BUILD_CA_SHA256
ARG NEUROCENTER_BUILD_CA_NAME=.gitkeep
COPY docker/build-ca/${NEUROCENTER_BUILD_CA_NAME} /usr/local/share/neurocenter/build-ca/extra.pem
RUN if [ -n "$NEUROCENTER_BUILD_CA_SHA256" ]; then \
      printf '%s  %s\n' "$NEUROCENTER_BUILD_CA_SHA256" /usr/local/share/neurocenter/build-ca/extra.pem | sha256sum --check --status; \
    else \
      : > /usr/local/share/neurocenter/build-ca/extra.pem; \
    fi && chmod 0444 /usr/local/share/neurocenter/build-ca/extra.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/neurocenter/build-ca/extra.pem

# Ignore user/global npm settings; the lockfile and official registry define this build.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=false
WORKDIR /verifier
COPY services/catalog-service/package.json services/catalog-service/package-lock.json ./
ARG NEUROCENTER_NPM_DIAGNOSTICS=0
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=false --omit=dev --no-audit --no-fund --loglevel=http --foreground-scripts --update-notifier=false \
    $(if [ "$NEUROCENTER_NPM_DIAGNOSTICS" = "1" ]; then printf '%s' '--fetch-timeout=30000 --fetch-retries=0 --logs-max=0'; fi)
COPY scripts/snapshots/verify-image.cjs ./scripts/snapshots/verify-image.cjs
COPY services/shared/project-snapshot.cjs ./services/shared/project-snapshot.cjs
ENV RAYON_NUM_THREADS=2
ENV TOKIO_WORKER_THREADS=2
USER node
ENTRYPOINT ["/usr/bin/timeout","--signal=KILL","900","node", "--max-old-space-size=1024", "/verifier/scripts/snapshots/verify-image.cjs"]
