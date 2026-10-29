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
    NPM_CONFIG_STRICT_SSL=false

# Официальный клиент PG16 создаёт полноценные дампы сервера pgvector:pg16.
# https://www.postgresql.org/download/linux/debian/
RUN apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update \
    && apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --no-install-recommends ca-certificates curl bubblewrap \
    && if [ -s "$NODE_EXTRA_CA_CERTS" ]; then \
      awk '/-----BEGIN CERTIFICATE-----/ { n++ } n { print > ("/usr/local/share/ca-certificates/neurocenter-build-" n ".crt") }' "$NODE_EXTRA_CA_CERTS" \
      && update-ca-certificates; \
    fi \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl -fsSL --insecure https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update \
    && apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY vendor/asset-contract/ /vendor/asset-contract/
COPY services/catalog-service/package*.json ./
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=false --no-audit --no-fund
COPY services/catalog-service/ .
COPY services/shared/ /shared/
COPY catalog-source/ /catalog-source/
# Shared declarations resolve the same pinned contracts as the owning service.
RUN ln -s /app/node_modules /shared/node_modules
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm run build
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm prune --omit=dev --no-audit --no-fund

# Сервер использует общий native builder; source assets приходят из единого репозитория.
COPY scripts/catalog-plugins/ /tools/scripts/catalog-plugins/
COPY catalog-source/ /tools/catalog-source/
COPY services/shared/ /tools/services/shared/
COPY services/catalog-service/package*.json /tools/services/catalog-service/
COPY services/catalog-service/tsconfig*.json /tools/services/catalog-service/
COPY services/catalog-service/src/catalog/dto.ts /tools/services/catalog-service/src/catalog/dto.ts
COPY services/catalog-service/src/devices/mcp-config-schema.ts /tools/services/catalog-service/src/devices/mcp-config-schema.ts
COPY services/catalog-service/src/publication/publication-runtime.ts /tools/services/catalog-service/src/publication/publication-runtime.ts
COPY services/catalog-service/src/publication/publication-validation.ts /tools/services/catalog-service/src/publication/publication-validation.ts
COPY package*.json /tools/
COPY scripts/models/ /tools/scripts/models/
COPY scripts/release-request.mjs /tools/scripts/release-request.mjs
COPY scripts/workspace/node-runtime.mjs /tools/scripts/workspace/node-runtime.mjs
COPY scripts/opencode-platforms.mjs /tools/scripts/opencode-platforms.mjs
COPY vendor/asset-contract/ /tools/vendor/asset-contract/
RUN ln -s /app/dist /tools/services/catalog-service/dist && ln -s /app/node_modules /tools/services/catalog-service/node_modules && ln -s /app/node_modules /tools/services/shared/node_modules && ln -s /app/node_modules /tools/node_modules

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=catalog-service
ENV TOOL_BUILD_SCRIPT=/tools/scripts/catalog-plugins/build.mjs

EXPOSE 4100
CMD ["node", "dist/main.js"]
