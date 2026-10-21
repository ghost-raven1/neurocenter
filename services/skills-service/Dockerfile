ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

# Public corporate CA is optional; a stale staged file never enables trust by itself.
ARG NEUROCENTER_BUILD_CA_SHA256
COPY docker/build-ca/ /usr/local/share/neurocenter/build-ca/
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
COPY services/skills-service/package*.json ./
RUN npm ci --registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl=true --no-audit --no-fund
COPY services/skills-service/ .
COPY services/shared/ /shared/
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=skills-service

EXPOSE 4200
CMD ["node", "dist/main.js"]
