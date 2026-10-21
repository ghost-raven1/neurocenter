ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

# Ignore user/global npm settings; the lockfile and official registry define this build.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=true

WORKDIR /app
COPY services/feature-flags-service/package*.json ./
RUN npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=true --no-audit --no-fund
COPY services/feature-flags-service/ .
COPY services/shared/ /shared/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=feature-flags-service
EXPOSE 4400
CMD ["node", "dist/main.js"]
