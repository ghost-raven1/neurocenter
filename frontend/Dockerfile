ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx.production.conf.template /etc/neurocenter/nginx.production.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
