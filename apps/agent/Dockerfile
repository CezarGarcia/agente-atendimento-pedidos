# Build a partir da raiz do monorepo: docker build -f apps/agent/Dockerfile .
# A imagem serve o agente e também o simulador web (build estático do Vite).
FROM node:22-alpine AS base
WORKDIR /repo

FROM base AS build
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
COPY apps/simulator/package.json apps/simulator/
RUN npm ci --workspace @agente/agent --workspace @agente/simulator --ignore-scripts
COPY packages/shared packages/shared
COPY apps/agent apps/agent
COPY apps/simulator apps/simulator
RUN npm run build --workspace @agente/agent && npm run build --workspace @agente/simulator

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
RUN npm ci --workspace @agente/agent --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/agent/dist ./dist
COPY --from=build --chown=node:node /repo/apps/agent/prompts ./prompts
COPY --from=build --chown=node:node /repo/apps/simulator/dist ./simulator
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3002/health/live > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
