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

# Ignore user/global npm settings; the lockfile and official registry define this build.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=true

WORKDIR /app

# --- MCP-мост neurocenter-asset-sync: нужен rag-sync-service для in-container restore_rag_db ---
# В репо только исходники; node_modules/dist не копируются (.dockerignore) и собираются в образе.
COPY mcp/neurocenter-asset-sync/package.json mcp/neurocenter-asset-sync/package-lock.json mcp/neurocenter-asset-sync/
WORKDIR /app/mcp/neurocenter-asset-sync
# Lock содержит Linux GNU-биндинги обеих архитектур. Проверяем загрузку сразу,
# без повторного npm install, который пересчитывал версии вне lock-файла.
RUN npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=true --include=optional --no-audit --no-fund && node -e "require('@lancedb/lancedb')"
COPY mcp/neurocenter-asset-sync/ .
# MCP использует общие контракты и их типы уже во время собственной сборки.
COPY services/shared/runtime-artifacts.cjs services/shared/runtime-artifacts.d.cts \
    services/shared/rag-index-contract.cjs services/shared/rag-index-contract.d.cts \
    services/shared/rag-ui-contract.cjs services/shared/rag-ui-contract.d.cts \
    services/shared/opencode-model-scan.cjs services/shared/opencode-model-scan.d.cts \
    services/shared/opencode-providers.cjs services/shared/opencode-providers.d.cts \
    services/shared/project-snapshot.cjs services/shared/project-snapshot.d.cts \
    services/shared/project-agents.cjs services/shared/project-agents.d.cts \
    services/shared/project-learning.cjs services/shared/project-learning.d.cts /app/services/shared/
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

# --- rag-sync-service (NestJS) ---
WORKDIR /app
COPY services/rag-sync-service/package*.json ./
RUN npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=true --no-audit --no-fund
COPY services/rag-sync-service/ .
COPY services/shared/ /shared/
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=rag-sync-service

EXPOSE 4300
CMD ["node", "dist/main.js"]
