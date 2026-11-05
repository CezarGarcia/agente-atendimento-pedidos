import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/infra/database.js';
import { AGENT_KEY, ANA, buildApp } from './support/harness.js';

// Banco apontando para uma porta sem servidor: simula indisponibilidade do PostgreSQL.
const unreachable = createDatabase('postgres://user:pass@127.0.0.1:1/none', 1);
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
