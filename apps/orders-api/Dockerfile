# Build a partir da raiz do monorepo: docker build -f apps/orders-api/Dockerfile .
FROM node:22-alpine AS base
WORKDIR /repo

# Dependências completas (com devDependencies) para compilar
FROM base AS build
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orders-api/package.json apps/orders-api/
RUN npm ci --workspace @agente/orders-api --ignore-scripts
COPY packages/shared packages/shared
COPY apps/orders-api apps/orders-api
RUN npm run build --workspace @agente/orders-api

# Apenas dependências de produção
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orders-api/package.json apps/orders-api/
RUN npm ci --workspace @agente/orders-api --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/orders-api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health/live > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
