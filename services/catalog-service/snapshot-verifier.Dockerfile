FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /verifier
COPY services/catalog-service/package.json services/catalog-service/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY scripts/snapshots/verify-image.cjs ./scripts/snapshots/verify-image.cjs
COPY services/shared/project-snapshot.cjs ./services/shared/project-snapshot.cjs
ENV RAYON_NUM_THREADS=2
ENV TOKIO_WORKER_THREADS=2
USER node
ENTRYPOINT ["/usr/bin/timeout","--signal=KILL","900","node", "--max-old-space-size=1024", "/verifier/scripts/snapshots/verify-image.cjs"]
