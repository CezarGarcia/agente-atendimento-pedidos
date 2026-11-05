import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';

import { createLogger, type Logger } from '@agente/shared';

import { OrdersService } from '../../src/application/orders-service.js';
import { createApp } from '../../src/http/app.js';
import { createDatabase, type Database } from '../../src/infra/database.js';
import { migrateToLatest } from '../../src/infra/migrator.js';
import { createPostgresRepositories } from '../../src/infra/postgres-repositories.js';
import { DEMO_CUSTOMERS, resetDemoData } from '../../src/infra/seed.js';

export const AGENT_KEY = 'test-agent-key-0123456789';
export const [ANA, BRUNO, CARLA, DIEGO] = DEMO_CUSTOMERS.map((customer) => customer.id) as [
  string,
  string,
  string,
  string,
];

export interface TestDatabase {
  db: Kysely<Database>;
  url: string;
  destroy(): Promise<void>;
}

/** Cria um banco isolado por arquivo de teste (permite rodar os arquivos em paralelo). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('postgresAdminUrl');
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString(), 20);
  await migrateToLatest(db, createLogger({ service: 'test', level: 'silent' }));

  return {
    db,
    url: url.toString(),
    async destroy() {
      await db.destroy();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Logger que captura as linhas JSON emitidas, para verificar eventos e ausência de PII. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ service: 'orders-api', destination, level: 'debug' }), lines };
}

export function buildApp(db: Kysely<Database>, logger?: Logger) {
  const appLogger = logger ?? createLogger({ service: 'orders-api', level: 'silent' });
  const service = new OrdersService({
    ...createPostgresRepositories(db),
    clock: { now: () => new Date() },
    logger: appLogger,
    logPseudonymSecret: 'test-pseudonym-secret-0123',
  });
  return createApp({
    service,
    logger: appLogger,
    apiKeys: [{ clientName: 'agent-service', key: AGENT_KEY }],
    rateLimitPerMinute: 10_000,
    checkDatabase: async () => {
      await sql`select 1`.execute(db);
    },
  });
}

export async function resetData(db: Kysely<Database>): Promise<void> {
  await resetDemoData(db);
}

export async function orderStatus(db: Kysely<Database>, orderId: string): Promise<string> {
  const row = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();
  return row.status;
}
