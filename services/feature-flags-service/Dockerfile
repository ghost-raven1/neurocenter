ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

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

# TLS policy is derived from the project flag; direct builds without the wrapper stay strict.
ARG NEUROCENTER_TLS_DISABLE=0
ARG NEUROCENTER_NPM_STRICT_SSL=true

# Ignore user/global npm settings; the lockfile and the trusted local registry define this build.
ENV NPM_CONFIG_REGISTRY=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=$NEUROCENTER_NPM_STRICT_SSL
# Optional build-time registry auth (base64 of the trusted-host npmrc lines); empty keeps the file blank.
ARG NPM_REGISTRY_AUTH_B64
RUN if [ -n "$NPM_REGISTRY_AUTH_B64" ]; then printf '%s' "$NPM_REGISTRY_AUTH_B64" | base64 -d > /tmp/neurocenter-empty-global.npmrc; else : > /tmp/neurocenter-empty-global.npmrc; fi

# Repo layout, not flat: the lockfile's file: links (file:../../vendor/asset-contract,
# file:../../supply/vendor) and the postbuild hook (node ../../scripts/workspace/dist-freshness.mjs)
# resolve relative to the service's position two levels below the repo root. A flat /app layout
# clamps ../../ at the filesystem root, so the computed link location no longer matches the
# lockfile key (npm ci EMISSINGTARGET → misleading "can only install with an existing package-lock.json").
WORKDIR /repo
COPY services/feature-flags-service/package*.json /repo/services/feature-flags-service/
COPY vendor/asset-contract/ /repo/vendor/asset-contract/
# AD-15 vendor-схема: file:-зависимости lockfile (file:../../supply/vendor) указывают на
# /repo/supply/vendor (два уровня вверх от /repo/services/<svc>).
COPY supply/vendor/ /repo/supply/vendor/
# postbuild-stamp freshness-guard (AD-10): закрывает closure входов сборки, --write не требует git.
COPY scripts/workspace/dist-freshness.mjs scripts/workspace/isolated-build-source.mjs /repo/scripts/workspace/
WORKDIR /repo/services/feature-flags-service
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm ci --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --no-audit --no-fund
COPY services/feature-flags-service/ /repo/services/feature-flags-service/
COPY services/shared/ /repo/services/shared/
# shared-пакет резолвит свои deps (@neurocenter/asset-contract и др.) через node_modules
# владельца: symlink на node_modules сервиса (паттерн catalog-service).
RUN ln -s /repo/services/feature-flags-service/node_modules /repo/services/shared/node_modules
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm run build && NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=feature-flags-service
EXPOSE 4400
CMD ["node", "dist/main.js"]
