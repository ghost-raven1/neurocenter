ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# Global (pre-FROM) ARG: stage-local ARGs are not visible from a following FROM.
# Default — pinned digest (supply policy). Local dev builds without docker.io access
# may pass --build-arg NGINX_IMAGE=<local equivalent> (same nginx version).
ARG NGINX_IMAGE=nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
FROM ${NODE_IMAGE} AS build

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
WORKDIR /app/frontend
COPY frontend/package*.json ./
# AD-15 vendor-схема: file:-зависимости lockfile указывают на supply/vendor (на уровень выше frontend/).
COPY supply/vendor/ /app/supply/vendor/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm ci --registry=https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/ --userconfig=/dev/null --globalconfig=/tmp/neurocenter-empty-global.npmrc --strict-ssl="$NEUROCENTER_NPM_STRICT_SSL" --no-audit --no-fund
COPY frontend/ .
COPY services/shared/ /app/services/shared/
RUN NODE_TLS_REJECT_UNAUTHORIZED="$(if [ "$NEUROCENTER_TLS_DISABLE" = "1" ]; then printf 0; else printf 1; fi)" npm run build

FROM ${NGINX_IMAGE}
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx.production.conf.template /etc/neurocenter/nginx.production.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
