import { sql } from 'kysely';

import { createLogger } from '@agente/shared';

import { OrdersService } from './application/orders-service.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { demoRouter } from './http/routes/demo.js';
import { createDatabase } from './infra/database.js';
import { createDemoOperations } from './infra/demo.js';
import { migrateToLatest } from './infra/migrator.js';
import { createPostgresRepositories } from './infra/postgres-repositories.js';
import { seedIfEmpty } from './infra/seed.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: 'orders-api',
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });
  const db = createDatabase(config.DATABASE_URL, { logger });

  if (config.MIGRATE_ON_START) await migrateToLatest(db, logger);
  if (config.SEED_ON_START && (await seedIfEmpty(db))) {
    logger.info({ event: 'db.seeded' }, 'dados de demonstração inseridos');
  }

  const repositories = createPostgresRepositories(db);
  const service = new OrdersService({
    ...repositories,
    clock: { now: () => new Date() },
    logger,
    logPseudonymSecret: config.LOG_PSEUDONYM_SECRET,
  });

  const app = createApp({
    service,
    logger,
    apiKeys: config.ORDERS_API_KEYS,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    checkDatabase: async () => {
      await sql`select 1`.execute(db);
    },
    extraRouters: config.DEMO_MODE
      ? [
          {
            path: '/internal/demo',
            router: demoRouter(createDemoOperations(db), config.ORDERS_API_KEYS),
          },
        ]
      : [],
  });
  if (config.DEMO_MODE) {
    logger.warn(
      { event: 'server.demo_mode' },
      'rotas de demonstração habilitadas (/internal/demo)',
    );
  }

  const server = app.listen(config.PORT, (error?: Error) => {
    if (error) {
      logger.fatal({ event: 'server.listen_failed', err: error }, 'falha ao abrir a porta');
      process.exit(1);
    }
    logger.info({ event: 'server.started', port: config.PORT }, 'API de pedidos no ar');
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

main().catch((error: unknown) => {
  createLogger({ service: 'orders-api' }).fatal(
    { event: 'server.crashed', err: error },
    'falha ao iniciar',
  );
  process.exit(1);
});
