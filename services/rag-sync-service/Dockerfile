# Бейс: glibc (gnu), node >=18 — нативные биндинги lancedb/apache-arrow под linux-x64-gnu.
# (ранее: node:16-alpine — node 16 не тянет MCP, alpine/musl — другой биндинг)
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

# --- MCP-мост neurocenter-asset-sync: нужен rag-sync-service для in-container restore_rag_db ---
# В репо только исходники; node_modules/dist не копируются (.dockerignore) и собираются в образе.
COPY mcp/neurocenter-asset-sync/package.json mcp/neurocenter-asset-sync/package-lock.json mcp/neurocenter-asset-sync/
COPY mcp/neurocenter-asset-sync/vendor/ mcp/neurocenter-asset-sync/vendor/
# AD-15 vendor-схема: file:-зависимости mcp-lockfile (file:../../supply/vendor) указывают на /app/supply/vendor.
COPY supply/vendor/ /app/supply/vendor/
WORKDIR /app/mcp/neurocenter-asset-sync
# Lock содержит Linux GNU-биндинги обеих архитектур. Проверяем загрузку сразу,
# без повторного npm install, который пересчитывал версии вне lock-файла.
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm ci --install-links=true --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --include=optional --no-audit --no-fund && node -e "require('@lancedb/lancedb')"
COPY mcp/neurocenter-asset-sync/ .
# MCP использует общие контракты и их типы уже во время собственной сборки.
COPY services/shared/ /app/services/shared/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm run build
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm prune --omit=dev --no-audit --no-fund

# --- rag-sync-service (NestJS) ---
WORKDIR /app
COPY services/rag-sync-service/package*.json ./
# AD-15 vendor-схема: file:-зависимости lockfile (file:../../supply/vendor) указывают на /supply/vendor.
COPY supply/vendor/ /supply/vendor/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm ci --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --no-audit --no-fund
COPY services/rag-sync-service/ .
COPY services/shared/ /shared/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm run build
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=rag-sync-service

EXPOSE 4300
CMD ["node", "dist/main.js"]
