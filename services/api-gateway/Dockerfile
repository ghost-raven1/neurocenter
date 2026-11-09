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

WORKDIR /app
COPY vendor/asset-contract/ /vendor/asset-contract/
COPY services/api-gateway/package*.json ./
# AD-15 vendor-схема: file:-зависимости lockfile (file:../../supply/vendor) указывают на /supply/vendor.
COPY supply/vendor/ /supply/vendor/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm ci --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --no-audit --no-fund
COPY services/api-gateway/ .
COPY services/shared/ /shared/
COPY bridge-dist/ /app/bridge-dist/
COPY scripts/openapi/ /scripts/openapi/
COPY services/catalog-service/src/ /openapi/services/catalog-service/src/
COPY services/skills-service/src/ /openapi/services/skills-service/src/
COPY services/rag-sync-service/src/ /openapi/services/rag-sync-service/src/
COPY services/feature-flags-service/src/ /openapi/services/feature-flags-service/src/
COPY services/oauth2-bridge/src/ /openapi/services/oauth2-bridge/src/
COPY services/api-gateway/src/ /openapi/services/api-gateway/src/
COPY services/api-gateway/package.json /openapi/services/api-gateway/package.json
COPY services/shared/ /openapi/services/shared/
COPY vendor/asset-contract/index.d.ts /openapi/vendor/asset-contract/index.d.ts
RUN ln -s /app/node_modules /openapi/node_modules
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" NEUROCENTER_OPENAPI_ROOT=/openapi npm run build
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm prune --omit=dev --no-audit --no-fund
RUN rm -rf /openapi /scripts/openapi

# AD-4: non-root — child-MCP («одобренный» недоверенный артефакт) не работает root.
# Каталог кэша комплектов заранее в owner: первый mount именованного volume наследует права.
RUN groupadd --gid 1000 neurocenter \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin neurocenter \
    && mkdir -p /data/gateway/mcp-host \
    && chown -R neurocenter:neurocenter /app /data/gateway
USER neurocenter

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=api-gateway

EXPOSE 4000
CMD ["node", "dist/main.js"]
