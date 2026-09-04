FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
# `npm run build` is tsc + copy-assets + build:info. copy-assets reads openapi/openapi.yaml and
# build:info runs scripts/write-build-info.mjs, so a build stage without these two directories
# fails outright — which is what `docker compose up --build` did.
COPY openapi ./openapi
COPY scripts ./scripts
# The build stage has no .git, so write-build-info falls back to `unknown` unless the commit is
# passed in. An `unknown` commit is a legible failure at deploy time; a wrong one is not.
ARG ORDER_ROUTER_BUILD_SHA=""
ENV ORDER_ROUTER_BUILD_SHA=$ORDER_ROUTER_BUILD_SHA
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# The process binds a port and talks to exchanges; it never needs to write to its own image.
USER node
EXPOSE 8080
# /ready, not /health: /health answers 200 while connectors are still filling the cache, so an
# orchestrator that waits on it routes traffic to a router with no books.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
