ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

# Ignore user/global npm settings; the lockfile and official registry define this build.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=true

# Официальный клиент PG16 создаёт полноценные дампы сервера pgvector:pg16.
# https://www.postgresql.org/download/linux/debian/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/catalog-service/package*.json ./
RUN npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=true --no-audit --no-fund
COPY services/catalog-service/ .
COPY services/shared/ /shared/
# Shared declarations resolve the same pinned contracts as the owning service.
RUN ln -s /app/node_modules /shared/node_modules
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

# Сервер использует общий native builder; source assets приходят из единого репозитория.
COPY scripts/catalog-plugins/ /tools/scripts/catalog-plugins/
COPY scripts/models/ /tools/scripts/models/
COPY scripts/release-request.mjs /tools/scripts/release-request.mjs
COPY scripts/workspace/node-runtime.mjs /tools/scripts/workspace/node-runtime.mjs
RUN mkdir -p /tools/services && ln -s /app /tools/services/catalog-service && ln -s /shared /tools/services/shared && ln -s /app/node_modules /tools/node_modules

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=catalog-service
ENV TOOL_BUILD_SCRIPT=/tools/scripts/catalog-plugins/build.mjs

EXPOSE 4100
CMD ["node", "dist/main.js"]
