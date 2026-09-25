# syntax=docker/dockerfile:1.7
# The web console as a standalone Next.js server, built from the monorepo root:
#   docker build -f apps/web/Dockerfile -t dispatch-web .
# NEXT_PUBLIC_API_URL is built into the page; empty means the API is on the same origin (nginx).

ARG NODE_IMAGE=node:24.19.0-alpine3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/driver/package.json apps/driver/
COPY tools/simulator/package.json tools/simulator/
RUN npm ci --no-audit --no-fund --include-workspace-root -w @dispatch/shared -w @dispatch/web
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_BASEMAP_URL=/tiles/dubai.pmtiles
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_BASEMAP_URL=${NEXT_PUBLIC_BASEMAP_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @dispatch/shared && npm run build -w @dispatch/web

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
