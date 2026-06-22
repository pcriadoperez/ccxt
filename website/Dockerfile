# CCXT Fumadocs — containerized Next.js server (standalone output).
# Build: docker build -t ccxt-fumadocs website
# Run:   docker run -d --restart=always -p 127.0.0.1:3005:3005 --name ccxt-docs ccxt-fumadocs

FROM node:20-slim AS builder
WORKDIR /app
COPY . .
RUN npm ci
# Root build (no NEXT_BASE_PATH): served at / behind nginx. Absolute site URL for
# sitemap/canonical/robots. To stage under a subpath instead, set NEXT_BASE_PATH=/v2.
# NEXT_PUBLIC_AI_ENABLED shows the "Ask AI" button; the OPENROUTER_API_KEY is provided
# at RUNTIME (docker run -e ...), never baked into the image.
ENV NEXT_PUBLIC_SITE_URL=https://docs.ccxt.com \
    NEXT_PUBLIC_AI_ENABLED=true \
    NODE_OPTIONS=--max-old-space-size=4096
# Stable Server Actions encryption key so a client served by an earlier deploy doesn't hit
# "Failed to find Server Action" after a redeploy. Next reads it ONLY during `next build`
# (https://nextjs.org/docs/app/guides/self-hosting#serverless-functions-encryption-key) and bakes
# the resulting module map into .next — so it's a build-time input, not a runtime one. We pass it as
# a BuildKit secret (not a build-arg/ENV) so it never lands in an image layer or `docker history`.
# Fail fast if it's empty: an unset key makes Next mint a random per-build key — the exact skew bug.
#   build with: docker build --secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ...
RUN --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY 2>/dev/null || true)"; \
    if [ -z "$KEY" ]; then echo "ERROR: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY build secret is empty — set the repo secret (openssl rand -base64 32)" >&2; exit 1; fi; \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$KEY" npm run build

FROM node:20-slim AS runner
WORKDIR /app
# No NEXT_SERVER_ACTIONS_ENCRYPTION_KEY here: the key is consumed at build time and baked into the
# .next module map, so the runtime never reads it from env. Keeping it out of the runner stage means
# it isn't exposed via `docker inspect`/`docker history` on the shipped image.
ENV NODE_ENV=production \
    PORT=3005 \
    HOSTNAME=0.0.0.0
# standalone bundle (flat, thanks to outputFileTracingRoot) + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# public/ holds the CCXT logo assets used by the homepage hero
COPY --from=builder /app/public ./public
EXPOSE 3005
CMD ["node", "server.js"]
