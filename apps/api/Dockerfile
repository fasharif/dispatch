# syntax=docker/dockerfile:1.7
# The API (target "api") and the simulator (target "tools") from the monorepo root:
#   docker build -f apps/api/Dockerfile --target api -t dispatch-api .
# Only the workspaces these images need are installed; the web and driver apps are left out.

ARG NODE_IMAGE=node:24.19.0-alpine3.24

FROM ${NODE_IMAGE} AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/driver/package.json apps/driver/
COPY tools/simulator/package.json tools/simulator/

FROM manifests AS build
RUN npm ci --no-audit --no-fund --include-workspace-root \
      -w @dispatch/shared -w @dispatch/api -w @dispatch/simulator
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY tools/simulator tools/simulator
RUN npm run build -w @dispatch/shared -w @dispatch/api -w @dispatch/simulator

FROM manifests AS runtime-deps
RUN npm ci --no-audit --no-fund --omit=dev \
      -w @dispatch/shared -w @dispatch/api -w @dispatch/simulator

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=runtime-deps /repo/node_modules node_modules
COPY --from=runtime-deps /repo/package.json ./
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/shared/dist packages/shared/dist

FROM base AS api
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/migrations apps/api/migrations
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM base AS tools
COPY --from=build /repo/tools/simulator/package.json tools/simulator/
COPY --from=build /repo/tools/simulator/dist tools/simulator/dist
USER node
WORKDIR /work
ENTRYPOINT ["node", "/repo/tools/simulator/dist/cli.js"]
