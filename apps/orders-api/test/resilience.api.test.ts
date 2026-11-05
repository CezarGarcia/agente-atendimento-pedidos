import { setTimeout as delay } from 'node:timers/promises';

import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createLogger } from '@agente/shared';

import { createDatabase } from '../src/infra/database.js';
import {
  AGENT_KEY,
  ANA,
  BRUNO,
  adminClient,
  buildApp,
  createTestDatabase,
  resetData,
} from './support/harness.js';

// Banco apontando para uma porta sem servidor: simula indisponibilidade do PostgreSQL.
const unreachable = createDatabase('postgres://user:pass@127.0.0.1:1/none', {
  logger: createLogger({ service: 'test', level: 'silent' }),
  maxConnections: 1,
});
const app = buildApp(unreachable);

afterAll(async () => {
  await unreachable.destroy();
});

describe('falha técnica da dependência (banco fora do ar)', () => {
  it('responde 503 SERVICE_UNAVAILABLE com Retry-After, sem vazar detalhes internos', async () => {
    const res = await request(app)
      .get(`/v1/customers/${ANA}/orders/100101`)
      .set('x-api-key', AGENT_KEY);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack/);
  });

  it('readiness reporta indisponibilidade', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('cancelamento com banco fora do ar não é reportado como sucesso', async () => {
    const res = await request(app)
      .post(`/v1/customers/${ANA}/orders/100101/cancellation`)
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', 'conv-resilience-0001');
    expect(res.status).toBe(503);
  });
});

describe('falhas transitórias com o banco no ar', () => {
  it('sobrevive quando o banco derruba conexões ociosas (restart/failover)', async () => {
    const database = await createTestDatabase();
    await resetData(database.db);
    const healthyApp = buildApp(database.db);
    const get = () =>
      request(healthyApp).get(`/v1/customers/${ANA}/orders/100101`).set('x-api-key', AGENT_KEY);
    expect((await get()).status).toBe(200);

    const admin = adminClient();
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name = 'orders-api' AND datname = $1`,
      [new URL(database.url).pathname.slice(1)],
    );
    await admin.end();
    await delay(100);

    // Sem o listener de 'error' no pool, o processo (e este teste) cairia aqui.
    expect((await get()).status).toBe(200);
    await database.destroy();
  });

  it('não segura a requisição indefinidamente esperando o lock de um pedido (503)', async () => {
    const database = await createTestDatabase();
    await resetData(database.db);
    const lockedApp = buildApp(database.db);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locker = database.db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM orders WHERE id = '100201' FOR UPDATE`.execute(trx);
      await held;
    });
    await delay(50);

    const res = await request(lockedApp)
      .post(`/v1/customers/${BRUNO}/orders/100201/cancellation`)
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', 'conv-lock-timeout-0001');
    release();
    await locker;

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    await database.destroy();
  }, 15_000);
});

describe('limite de requisições', () => {
  it('é contado por cliente final: um cliente não esgota a cota dos outros', async () => {
    const database = await createTestDatabase();
    await resetData(database.db);
    const limitedApp = buildApp(database.db, undefined, { rateLimitPerMinute: 2 });
    const list = (customerId: string) =>
      request(limitedApp).get(`/v1/customers/${customerId}/orders`).set('x-api-key', AGENT_KEY);

    expect((await list(ANA)).status).toBe(200);
    expect((await list(ANA)).status).toBe(200);
    const limited = await list(ANA);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect((await list(BRUNO)).status).toBe(200);
    await database.destroy();
  });
});
