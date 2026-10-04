# Build stage: install workspace deps, build client (Vite) and server bundle (esbuild).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/game-core/package.json packages/game-core/
RUN pnpm install --frozen-lockfile
COPY . .
# Release tag for the client build (version shown in the app); ARGs are env vars for RUN.
ARG APP_VERSION=dev
RUN pnpm test && pnpm build

# Runtime stage: a single self-contained server bundle that also serves the client.
FROM node:24-slim
WORKDIR /app
# Image-Tag, den bin/release.sh als --build-arg reinreicht (Default: dev);
# erscheint unter /healthz.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/public \
    APP_VERSION=${APP_VERSION}
COPY --from=build /app/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/client/dist ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
