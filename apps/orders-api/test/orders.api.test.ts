import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CustomerLookupResultSchema,
  OrderListSchema,
  OrderSchema,
  ProblemSchema,
  ValidationProblemSchema,
} from '../src/http/schemas.js';
import {
  AGENT_KEY,
  ANA,
  BRUNO,
  DIEGO,
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

const api = () => ({
  get: (path: string) => request(app).get(path).set('x-api-key', AGENT_KEY),
  post: (path: string) => request(app).post(path).set('x-api-key', AGENT_KEY),
});

describe('autenticação serviço-a-serviço', () => {
  it('[API-05] recusa requisição sem chave com 401 em Problem Details', async () => {
    const res = await request(app).get(`/v1/customers/${ANA}/orders`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(ProblemSchema.parse(res.body).code).toBe('UNAUTHENTICATED');
  });

  it('[API-05] recusa chave inválida', async () => {
    const res = await request(app).get(`/v1/customers/${ANA}/orders`).set('x-api-key', 'errada');
    expect(res.status).toBe(401);
  });

  it('[API-33] mantém health e documentação públicos', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/health/ready')).body).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
    expect((await request(app).get('/openapi.json')).body.openapi).toBe('3.1.0');
  });
});

describe('POST /v1/customers/lookup', () => {
  it('[API-06] identifica o cliente pelo telefone e devolve só id e primeiro nome', async () => {
    const res = await api().post('/v1/customers/lookup').send({ phone: '+5551990000001' });
    expect(res.status).toBe(200);
    expect(CustomerLookupResultSchema.strict().parse(res.body)).toEqual({
      customerId: ANA,
      firstName: 'Ana',
    });
  });

  it('[API-06] responde 404 para telefone não cadastrado', async () => {
    const res = await api().post('/v1/customers/lookup').send({ phone: '+5511999999999' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it.each([
    [{ phone: '51990000001' }, 'phone'],
    [{ phone: '+5551990000001', isAdmin: true }, ''],
  ])('[API-08] valida a entrada %j', async (body, path) => {
    const res = await api().post('/v1/customers/lookup').send(body);
    expect(res.status).toBe(400);
    const problem = ValidationProblemSchema.parse(res.body);
    expect(problem.errors?.map((e) => e.path)).toContain(path);
  });

  it('[API-22] responde 400 para JSON malformado', async () => {
    const res = await api()
      .post('/v1/customers/lookup')
      .set('content-type', 'application/json')
      .send('{"phone":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /v1/customers/:customerId/orders', () => {
  it('[API-10] lista os pedidos do cliente do mais recente ao mais antigo', async () => {
    const res = await api().get(`/v1/customers/${ANA}/orders`);
    expect(res.status).toBe(200);
    const { orders } = OrderListSchema.parse(res.body);
    expect(orders.map((o) => o.id)).toEqual(['100101', '100102', '100103']);
  });

  it('[API-10] respeita o limite', async () => {
    const res = await api().get(`/v1/customers/${ANA}/orders?limit=1`);
    expect(OrderListSchema.parse(res.body).orders).toHaveLength(1);
  });

  it('[API-10] devolve lista vazia para cliente sem pedidos', async () => {
    const res = await api().get(`/v1/customers/${DIEGO}/orders`);
    expect(res.body).toEqual({ orders: [] });
  });

  it('[API-08] valida limit fora da faixa', async () => {
    const res = await api().get(`/v1/customers/${ANA}/orders?limit=500`);
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/customers/:customerId/orders/:orderId', () => {
  it('[API-09] retorna o pedido com valores formatados e elegibilidade calculada pelo domínio', async () => {
    const res = await api().get(`/v1/customers/${ANA}/orders/100101`);
    expect(res.status).toBe(200);
    const order = OrderSchema.parse(res.body);
    expect(order).toMatchObject({
      id: '100101',
      status: 'PROCESSING',
      total: { amountCents: 82980, currency: 'BRL', formatted: 'R$ 829,80' },
      cancellation: { eligible: true, blockedReason: null, cancelledAt: null },
    });
    expect(order.items).toHaveLength(2);
  });

  it('[API-09] informa o motivo do bloqueio para pedido enviado', async () => {
    const res = await api().get(`/v1/customers/${ANA}/orders/100102`);
    expect(OrderSchema.parse(res.body)).toMatchObject({
      status: 'SHIPPED',
      shipping: { trackingCode: 'QB123456785BR' },
      cancellation: { eligible: false, blockedReason: 'ALREADY_SHIPPED' },
    });
  });

  it('[API-07] não revela pedido de outro cliente: resposta idêntica a pedido inexistente (BOLA)', async () => {
    const otherCustomers = await api().get(`/v1/customers/${BRUNO}/orders/100101`);
    const nonexistent = await api().get(`/v1/customers/${BRUNO}/orders/999999`);

    expect(otherCustomers.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    const strip = (body: Record<string, unknown>) => ({
      ...body,
      detail: undefined,
      instance: undefined,
      correlationId: undefined,
    });
    expect(strip(otherCustomers.body as Record<string, unknown>)).toEqual(
      strip(nonexistent.body as Record<string, unknown>),
    );
    expect(otherCustomers.body.code).toBe('ORDER_NOT_FOUND');
  });

  it.each([
    ['abc', 'orderId'],
    ['1001011', 'orderId'],
  ])('[API-08] rejeita orderId inválido (%s)', async (orderId, path) => {
    const res = await api().get(`/v1/customers/${ANA}/orders/${orderId}`);
    expect(res.status).toBe(400);
    expect(ValidationProblemSchema.parse(res.body).errors?.[0]?.path).toBe(path);
  });

  it('[API-08] rejeita customerId que não é UUID', async () => {
    const res = await api().get(
      `/v1/customers/${encodeURIComponent("1' OR '1'='1")}/orders/100101`,
    );
    expect(res.status).toBe(400);
  });
});

describe('contrato de erros e rastreabilidade', () => {
  it('[API-32] propaga o correlation id recebido no header e no corpo do erro', async () => {
    const res = await api()
      .get(`/v1/customers/${ANA}/orders/999999`)
      .set('x-correlation-id', 'corr-test-12345');
    expect(res.headers['x-correlation-id']).toBe('corr-test-12345');
    expect(res.body.correlationId).toBe('corr-test-12345');
  });

  it('[API-22] responde 404 em Problem Details para rota inexistente', async () => {
    const res = await api().get('/v1/nada');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('logs estruturados', () => {
  it('[API-25] registram eventos de negócio sem dados pessoais nem identificadores reais', async () => {
    await api().post('/v1/customers/lookup').send({ phone: '+5551990000001' });
    await api().get(`/v1/customers/${ANA}/orders/100101`);

    const lookup = logLines.find((line) => line['event'] === 'order.lookup');
    expect(lookup).toMatchObject({
      level: 'info',
      service: 'orders-api',
      orderId: '100101',
      outcome: 'found',
      status: 'PROCESSING',
    });
    expect(lookup?.['customerRef']).toMatch(/^cus_[0-9a-f]{16}$/);
    expect(lookup?.['correlationId']).toBeTypeOf('string');

    const httpLine = logLines.find(
      (line) => line['event'] === 'http.request' && String(line['route']).includes(':orderId'),
    );
    expect(httpLine).toMatchObject({
      method: 'GET',
      route: '/v1/customers/:customerId/orders/:orderId',
      status: 200,
      client: 'agent-service',
    });

    const everything = JSON.stringify(logLines);
    expect(everything).not.toContain(ANA);
    expect(everything).not.toContain('990000001');
    expect(everything).not.toContain('Ana Souza');
    expect(everything).not.toContain(AGENT_KEY);
  });
});
