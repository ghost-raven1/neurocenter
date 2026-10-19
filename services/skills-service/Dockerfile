ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

WORKDIR /app
COPY services/skills-service/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/skills-service/ .
COPY services/shared/ /shared/
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV NEUROCENTER_SERVICE=skills-service

EXPOSE 4200
CMD ["node", "dist/main.js"]
