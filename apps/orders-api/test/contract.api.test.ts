import { randomUUID } from 'node:crypto';

import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProblemSchema } from '../src/http/schemas.js';
import {
  AGENT_KEY,
  ANA,
  BRUNO,
  buildApp,
  captureLogger,
  createTestDatabase,
  resetData,
  type TestDatabase,
} from './support/harness.js';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let logLines: Record<string, unknown>[];

beforeAll(async () => {
  database = await createTestDatabase();
  await resetData(database.db);
  const captured = captureLogger();
  logLines = captured.lines;
  app = buildApp(database.db, captured.logger);
});

afterAll(async () => {
  await database.destroy();
});

const cancelPath = (orderId: string, customerId = ANA) =>
  `/v1/customers/${customerId}/orders/${orderId}/cancellation`;

/** Todo erro segue RFC 9457 e o schema documentado no OpenAPI. */
function expectProblem(res: Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const problem = ProblemSchema.parse(res.body);
  expect(problem).toMatchObject({ status, code });
  expect(problem.correlationId).toBeTypeOf('string');
}

describe('contrato de erros (cada resposta de erro respeita o schema Problem)', () => {
  it('400 — identificador inválido', async () => {
    const res = await request(app)
      .get(`/v1/customers/${ANA}/orders/abc`)
      .set('x-api-key', AGENT_KEY);
    expectProblem(res, 400, 'VALIDATION_ERROR');
  });

  it('400 — Idempotency-Key ausente', async () => {
    const res = await request(app).post(cancelPath('100101')).set('x-api-key', AGENT_KEY);
    expectProblem(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('400 — JSON malformado', async () => {
    const res = await request(app)
      .post('/v1/customers/lookup')
      .set('x-api-key', AGENT_KEY)
      .set('content-type', 'application/json')
      .send('{"phone":');
    expectProblem(res, 400, 'VALIDATION_ERROR');
  });

  it('400 — URL com codificação inválida, sem vazar o trecho da URL no log', async () => {
    const res = await request(app)
      .get(`/v1/customers/${BRUNO}%E0%A4%A/orders/100101`)
      .set('x-api-key', AGENT_KEY);
    expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(logLines).toContainEqual(
      expect.objectContaining({ event: 'http.client_error', status: 400 }),
    );
    expect(JSON.stringify(logLines)).not.toContain(BRUNO);
  });

  it('401 — sem credencial', async () => {
    expectProblem(await request(app).get(`/v1/customers/${ANA}/orders`), 401, 'UNAUTHENTICATED');
  });

  it('404 — pedido e rota', async () => {
    const order = await request(app)
      .get(`/v1/customers/${ANA}/orders/999999`)
      .set('x-api-key', AGENT_KEY);
    expectProblem(order, 404, 'ORDER_NOT_FOUND');
    expectProblem(await request(app).get('/nada'), 404, 'ROUTE_NOT_FOUND');
  });

  it('409 — pedido não cancelável', async () => {
    const res = await request(app)
      .post(cancelPath('100102'))
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', `k-${randomUUID()}`);
    expectProblem(res, 409, 'ORDER_NOT_CANCELLABLE');
  });

  it('413 — corpo grande demais', async () => {
    const res = await request(app)
      .post(cancelPath('100101'))
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', `k-${randomUUID()}`)
      .send({ reason: 'x'.repeat(20_000) });
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('415 — corpo que não é JSON não é ignorado silenciosamente', async () => {
    const res = await request(app)
      .post(cancelPath('100101'))
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', `k-${randomUUID()}`)
      .set('content-type', 'text/plain')
      .send('{"reason":"x"}');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('415 — charset não suportado', async () => {
    const res = await request(app)
      .post('/v1/customers/lookup')
      .set('x-api-key', AGENT_KEY)
      .set('content-type', 'application/json; charset=latin1')
      .send('{"phone":"+5551990000001"}');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('422 — Idempotency-Key reutilizada com outro corpo', async () => {
    const key = `k-${randomUUID()}`;
    await request(app)
      .post(cancelPath('100102'))
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', key)
      .send({ reason: 'a' });
    const res = await request(app)
      .post(cancelPath('100102'))
      .set('x-api-key', AGENT_KEY)
      .set('idempotency-key', key)
      .send({ reason: 'b' });
    expectProblem(res, 422, 'IDEMPOTENCY_KEY_MISMATCH');
  });

  it('erros do cliente não são registrados como erro do serviço', () => {
    expect(logLines.some((line) => line['level'] === 'error')).toBe(false);
  });
});

describe('documento OpenAPI', () => {
  it('não publica nenhuma chave de acesso', async () => {
    const res = await request(app).get('/openapi.json');
    expect(JSON.stringify(res.body)).not.toMatch(/change-me|dev-.*-key/);
  });

  it('documenta todas as rotas de negócio', async () => {
    const res = await request(app).get('/openapi.json');
    expect(Object.keys(res.body.paths as object).sort()).toEqual([
      '/v1/customers/lookup',
      '/v1/customers/{customerId}/orders',
      '/v1/customers/{customerId}/orders/{orderId}',
      '/v1/customers/{customerId}/orders/{orderId}/cancellation',
    ]);
  });
});
