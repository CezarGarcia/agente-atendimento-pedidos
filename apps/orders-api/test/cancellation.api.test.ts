import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CancellationResultSchema, OrderNotCancellableProblemSchema } from '../src/http/schemas.js';
import {
  AGENT_KEY,
  ANA,
  BRUNO,
  CARLA,
  buildApp,
  captureLogger,
  createTestDatabase,
  orderStatus,
  resetData,
  type TestDatabase,
} from './support/harness.js';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let logLines: Record<string, unknown>[];

beforeAll(async () => {
  database = await createTestDatabase();
  const captured = captureLogger();
  logLines = captured.lines;
  app = buildApp(database.db, captured.logger);
});

beforeEach(async () => {
  await resetData(database.db);
});

afterAll(async () => {
  await database.destroy();
});

const cancel = (customerId: string, orderId: string, key: string | null = randomUUID()) => {
  const req = request(app)
    .post(`/v1/customers/${customerId}/orders/${orderId}/cancellation`)
    .set('x-api-key', AGENT_KEY);
  return key === null ? req : req.set('idempotency-key', key);
};

const historyOf = (orderId: string) =>
  database.db
    .selectFrom('order_status_history')
    .selectAll()
    .where('order_id', '=', orderId)
    .where('actor', '!=', 'seed')
    .execute();

describe('POST …/cancellation — regra de negócio validada na API', () => {
  it('cancela pedido em processamento e registra a auditoria', async () => {
    const res = await cancel(ANA, '100101')
      .set('x-correlation-id', 'corr-cancel-0001')
      .send({ reason: 'Comprei errado' });

    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('false');
    const { order } = CancellationResultSchema.parse(res.body);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancellation).toMatchObject({
      eligible: false,
      blockedReason: 'ALREADY_CANCELLED',
    });
    expect(order.cancellation.cancelledAt).not.toBeNull();

    expect(await orderStatus(database.db, '100101')).toBe('CANCELLED');
    expect(await historyOf('100101')).toEqual([
      expect.objectContaining({
        from_status: 'PROCESSING',
        to_status: 'CANCELLED',
        actor: 'agent-service',
        reason: 'Comprei errado',
        correlation_id: 'corr-cancel-0001',
      }),
    ]);
  });

  it('aceita requisição sem corpo (motivo opcional)', async () => {
    const res = await cancel(BRUNO, '100201');
    expect(res.status).toBe(200);
  });

  it.each([
    ['100102', ANA, 'SHIPPED', 'ALREADY_SHIPPED'],
    ['100103', ANA, 'DELIVERED', 'ALREADY_DELIVERED'],
    ['100202', BRUNO, 'CANCELLED', 'ALREADY_CANCELLED'],
    ['100301', CARLA, 'AWAITING_PAYMENT', 'PAYMENT_PENDING'],
  ])(
    'recusa o pedido %s (%s → %s) com 409 e não altera o status',
    async (orderId, customerId, status, reason) => {
      const res = await cancel(customerId, orderId);

      expect(res.status).toBe(409);
      expect(OrderNotCancellableProblemSchema.parse(res.body)).toMatchObject({
        code: 'ORDER_NOT_CANCELLABLE',
        orderId,
        currentStatus: status,
        reason,
      });
      expect(await orderStatus(database.db, orderId)).toBe(status);
      expect(await historyOf(orderId)).toHaveLength(0);
      expect(logLines).toContainEqual(
        expect.objectContaining({ event: 'order.cancellation.rejected', orderId, reason }),
      );
      expect(logLines.at(-1)).toMatchObject({
        event: 'http.request',
        route: '/v1/customers/:customerId/orders/:orderId/cancellation',
        status: 409,
      });
    },
  );

  it('responde 404 e não altera pedido de outro cliente', async () => {
    const res = await cancel(BRUNO, '100101');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
    expect(await orderStatus(database.db, '100101')).toBe('PROCESSING');
  });

  it('responde 404 para pedido inexistente', async () => {
    const res = await cancel(ANA, '999999');
    expect(res.status).toBe(404);
  });

  it('exige Idempotency-Key', async () => {
    const res = await cancel(ANA, '100101', null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await orderStatus(database.db, '100101')).toBe('PROCESSING');
  });

  it('valida o formato da Idempotency-Key', async () => {
    const res = await cancel(ANA, '100101', 'curta');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    [{ reason: 'x'.repeat(501) }],
    [{ reason: 'ok', status: 'CANCELLED' }],
    [{ reason: 42 }],
  ])('rejeita corpo inválido %#', async (body) => {
    const res = await cancel(ANA, '100101').send(body);
    expect(res.status).toBe(400);
    expect(await orderStatus(database.db, '100101')).toBe('PROCESSING');
  });
});

describe('idempotência', () => {
  it('repetir a mesma chave devolve a resposta original sem executar de novo', async () => {
    const key = `conv-${randomUUID()}`;
    const first = await cancel(ANA, '100101', key).send({ reason: 'mudei de ideia' });
    const second = await cancel(ANA, '100101', key).send({ reason: 'mudei de ideia' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await historyOf('100101')).toHaveLength(1);
  });

  it('uma nova chave para pedido já cancelado recebe 409 ALREADY_CANCELLED', async () => {
    await cancel(ANA, '100101');
    const res = await cancel(ANA, '100101');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('ALREADY_CANCELLED');
  });

  it('a mesma chave com outro corpo é rejeitada com 422', async () => {
    const key = `conv-${randomUUID()}`;
    await cancel(ANA, '100101', key).send({ reason: 'um motivo' });
    const res = await cancel(ANA, '100101', key).send({ reason: 'outro motivo' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('também reproduz recusas (409) para a mesma chave', async () => {
    const key = `conv-${randomUUID()}`;
    const first = await cancel(ANA, '100102', key);
    const second = await cancel(ANA, '100102', key);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });
});

describe('concorrência', () => {
  it('10 cancelamentos simultâneos do mesmo pedido: exatamente 1 sucesso', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => cancel(BRUNO, '100201')));
    const statuses = results.map((res) => res.status).sort();

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    expect(
      results
        .filter((res) => res.status === 409)
        .every((res) => res.body.reason === 'ALREADY_CANCELLED'),
    ).toBe(true);
    expect(await historyOf('100201')).toHaveLength(1);
  });

  it('requisições simultâneas com a mesma chave executam a ação uma única vez', async () => {
    const key = `conv-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cancel(BRUNO, '100201', key)),
    );

    expect(results.every((res) => res.status === 200)).toBe(true);
    expect(results.filter((res) => res.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
    expect(new Set(results.map((res) => JSON.stringify(res.body))).size).toBe(1);
    expect(await historyOf('100201')).toHaveLength(1);
  });
});
