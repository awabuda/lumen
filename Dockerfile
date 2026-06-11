# Build a standalone binary with pkg
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ packages/
COPY apps/ apps/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter @lumen/cli deploy /pruned

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /pruned /app
ENTRYPOINT ["node", "dist/index.js"]
CMD ["chat"]
