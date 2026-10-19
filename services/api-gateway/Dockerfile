ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

WORKDIR /app
COPY services/api-gateway/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/api-gateway/ .
COPY services/shared/ /shared/
COPY bridge-dist/ /app/bridge-dist/
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=api-gateway

EXPOSE 4000
CMD ["node", "dist/main.js"]
