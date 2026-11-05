import { sql } from 'kysely';

import { createLogger, getCorrelationId, CORRELATION_HEADER } from '@agente/shared';

import { AgentService } from './agent/agent-service.js';
import { AnthropicLlmClient, type LlmClient } from './agent/llm.js';
import { loadSystemPrompt } from './agent/prompt.js';
import { ToolExecutor } from './agent/tools.js';
import { loadConfig } from './config.js';
import { createAgentDatabase, migrateAgentDatabase } from './conversation/database.js';
import { PostgresConversationStore } from './conversation/postgres-store.js';
import {
  ChaosCatalog,
  ChaosLlm,
  ChaosOrdersApi,
  ChaosState,
  UnconfiguredLlm,
} from './demo/chaos.js';
import { createAgentApp } from './http/agent-app.js';
import { simulatorRouter, type OrdersDemoClient } from './http/simulator-routes.js';
import { FakeStoreClient, type CatalogClient } from './integrations/fakestore/fakestore-client.js';
import { OrdersApiClient, type OrdersApi } from './integrations/orders-api/orders-api-client.js';

const MINUTE = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: 'agent',
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const db = createAgentDatabase(config.DATABASE_URL, { logger });
  if (config.MIGRATE_ON_START) await migrateAgentDatabase(db, logger);
  const store = new PostgresConversationStore(db);

  let orders: OrdersApi = new OrdersApiClient({
    baseUrl: config.ORDERS_API_URL,
    apiKey: config.ORDERS_API_KEY,
    logger,
  });
  let catalog: CatalogClient = new FakeStoreClient({ baseUrl: config.FAKESTORE_BASE_URL, logger });
  let llm: LlmClient = config.ANTHROPIC_API_KEY
    ? new AnthropicLlmClient({
        model: config.LLM_MODEL,
        effort: config.LLM_EFFORT,
        maxTokens: config.LLM_MAX_TOKENS,
        timeoutMs: config.LLM_TIMEOUT_MS,
        maxRetries: config.LLM_MAX_RETRIES,
        apiKey: config.ANTHROPIC_API_KEY,
        ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
      })
    : new UnconfiguredLlm(config.LLM_MODEL);
  if (!config.ANTHROPIC_API_KEY) {
    logger.warn(
      { event: 'llm.not_configured' },
      'ANTHROPIC_API_KEY ausente: o agente responderá com indisponibilidade',
    );
  }

  const chaos = new ChaosState();
  if (config.DEMO_MODE) {
    orders = new ChaosOrdersApi(orders, chaos);
    catalog = new ChaosCatalog(catalog, chaos);
    llm = new ChaosLlm(llm, chaos);
  }

  const prompt = loadSystemPrompt(config.LOG_PSEUDONYM_SECRET);
  const tools = new ToolExecutor({
    orders,
    catalog,
    store,
    logger,
    now: () => new Date(),
    confirmationTtlMs: config.CONFIRMATION_TTL_MINUTES * MINUTE,
    catalogBudgetMs: 3_000,
  });
  const agent = new AgentService({
    store,
    orders,
    tools,
    llm,
    prompt,
    logger,
    now: () => new Date(),
    pseudonymSecret: config.LOG_PSEUDONYM_SECRET,
    conversationIdleMs: config.CONVERSATION_IDLE_MINUTES * MINUTE,
    confirmationTtlMs: config.CONFIRMATION_TTL_MINUTES * MINUTE,
    maxLlmIterations: 5,
    messagesPerMinute: config.MESSAGES_PER_MINUTE,
  });

  const app = createAgentApp({
    agent,
    logger,
    webhookSecret: config.CHANNEL_WEBHOOK_SECRET,
    checkReadiness: async () => {
      await sql`select 1`.execute(db);
      return { database: 'ok', llm: config.ANTHROPIC_API_KEY ? 'configured' : 'not_configured' };
    },
    ...(config.SIMULATOR_DIST_DIR ? { simulatorDistDir: config.SIMULATOR_DIST_DIR } : {}),
    ...(config.DEMO_MODE
      ? {
          simulatorRouter: simulatorRouter({
            agent,
            store,
            chaos,
            ordersDemo: ordersDemoClient(config.ORDERS_API_URL, config.ORDERS_API_KEY),
            info: {
              model: config.LLM_MODEL,
              promptVersion: prompt.version,
              llmConfigured: Boolean(config.ANTHROPIC_API_KEY),
              // Endpoint trocado (stub dos testes E2E): o simulador avisa que as respostas são simuladas.
              llmSimulated: config.ANTHROPIC_BASE_URL !== undefined,
            },
          }),
        }
      : {}),
  });

  const server = app.listen(config.PORT, (error?: Error) => {
    if (error) {
      logger.fatal({ event: 'server.listen_failed', err: error }, 'falha ao abrir a porta');
      process.exit(1);
    }
    logger.info(
      {
        event: 'server.started',
        port: config.PORT,
        model: config.LLM_MODEL,
        promptVersion: prompt.version,
        demoMode: config.DEMO_MODE,
      },
      'agente no ar',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ event: 'server.stopping', signal }, 'encerrando');
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

function ordersDemoClient(baseUrl: string, apiKey: string): OrdersDemoClient {
  const post = async (path: string) => {
    const headers: Record<string, string> = { 'x-api-key': apiKey };
    const correlationId = getCorrelationId();
    if (correlationId) headers[CORRELATION_HEADER] = correlationId;
    return fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  };
  return {
    async reset() {
      const response = await post('/internal/demo/reset');
      if (!response.ok)
        throw new Error(`Falha ao recriar os dados de demonstração (${response.status})`);
    },
    async shipOrder(orderId) {
      const response = await post(`/internal/demo/orders/${orderId}/ship`);
      const body = (await response.json().catch(() => ({}))) as { shipped?: boolean };
      return { shipped: body.shipped === true, status: response.status };
    },
  };
}

main().catch((error: unknown) => {
  createLogger({ service: 'agent' }).fatal(
    { event: 'server.crashed', err: error },
    'falha ao iniciar',
  );
  process.exit(1);
});
