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

# Ignore user/global npm settings; the lockfile and the trusted local registry define this build.
ENV NPM_CONFIG_REGISTRY=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=true
# Optional build-time registry auth (base64 of the trusted-host npmrc lines); empty keeps the file blank.
ARG NPM_REGISTRY_AUTH_B64
RUN if [ -n "$NPM_REGISTRY_AUTH_B64" ]; then printf '%s' "$NPM_REGISTRY_AUTH_B64" | base64 -d > /tmp/neurocenter-empty-global.npmrc; else : > /tmp/neurocenter-empty-global.npmrc; fi
WORKDIR /verifier
COPY scripts/snapshots/verifier/package.json scripts/snapshots/verifier/package-lock.json ./
# AD-15 vendor-схема: file:-зависимости lockfile (file:../../../supply/vendor) указывают на /supply/vendor.
COPY supply/vendor/ /supply/vendor/
ARG NEUROCENTER_NPM_DIAGNOSTICS=0
ARG NEUROCENTER_NPM_STRICT_SSL=true
RUN printf 'Snapshot verifier: effective npm-diagnostics=%s; strict-ssl=%s\n' "$NEUROCENTER_NPM_DIAGNOSTICS" "$NEUROCENTER_NPM_STRICT_SSL"
# Keep the small SDK install serial on constrained DNS/proxy paths; diagnostics only change logging.
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_NPM_STRICT_SSL" = "false" ]; then printf 0; else printf 1; fi)" NPM_CONFIG_STRICT_SSL="$NEUROCENTER_NPM_STRICT_SSL" NODE_NO_WARNINGS=1 npm ci --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --omit=dev --no-audit --no-fund --loglevel=http --foreground-scripts --update-notifier=false --maxsockets=1 --fetch-timeout=120000 --fetch-retries=1 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=5000 \
    $(if [ "$NEUROCENTER_NPM_DIAGNOSTICS" = "1" ]; then printf '%s' '--loglevel=verbose --logs-max=0'; fi)
COPY scripts/snapshots/verify-image.cjs ./scripts/snapshots/verify-image.cjs
COPY services/shared/project-snapshot.cjs ./services/shared/project-snapshot.cjs
ENV RAYON_NUM_THREADS=2
ENV TOKIO_WORKER_THREADS=2
USER node
ENTRYPOINT ["/usr/bin/timeout","--signal=KILL","900","node", "--max-old-space-size=1024", "/verifier/scripts/snapshots/verify-image.cjs"]
