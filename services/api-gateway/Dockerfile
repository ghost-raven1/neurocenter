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
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

# Ignore user/global npm settings; the lockfile and official registry define this build.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/tmp/neurocenter-empty-global.npmrc \
    NPM_CONFIG_STRICT_SSL=false

WORKDIR /app
COPY services/api-gateway/package*.json ./
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=false --no-audit --no-fund
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
RUN ln -s /app/node_modules /openapi/node_modules
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 NEUROCENTER_OPENAPI_ROOT=/openapi npm run build
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm prune --omit=dev --no-audit --no-fund
RUN rm -rf /openapi /scripts/openapi

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=api-gateway

EXPOSE 4000
CMD ["node", "dist/main.js"]
