FROM node:24-slim AS builder

RUN npm install -g pnpm@10

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts/api-server ./artifacts/api-server
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

# Deploy the scripts package with only its production deps (pg).
# --legacy is required for pnpm v10 to deploy without inject-workspace-packages.
RUN pnpm --filter @workspace/scripts deploy --legacy --prod /app/scripts-deploy

FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NOVA_STATIC_DIR=/app/nova-static

COPY --from=builder /app/artifacts/api-server/dist ./dist
# Worker: lean production bundle (pg node_modules + all .mjs scripts)
COPY --from=builder /app/scripts-deploy ./scripts
COPY artifacts/nova/index.html ./nova-static/index.html
COPY artifacts/nova/public ./nova-static
COPY SOUL.md AGENTS.md DIRECTIVE.md IDENTITY.md USER.md HEARTBEAT.md TOOLS.md TASKS.md GOVERNANCE.json ./

EXPOSE 8080

# Run the work-tree worker in the background, then exec the API server as PID 1.
# Both share DATABASE_URL and BITDEER_API_KEY injected by Render at runtime.
CMD ["/bin/sh", "-c", "node scripts/work-tree-worker.mjs & exec node --enable-source-maps ./dist/index.mjs"]
