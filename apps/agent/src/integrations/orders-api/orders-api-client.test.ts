import { describe, expect, it, vi } from 'vitest';

import { createLogger, runWithContext } from '@agente/shared';

import { OrdersApiClient } from './orders-api-client.js';

const ORDER = {
  id: '100101',
  status: 'CANCELLED',
  placedAt: '2026-11-04T13:00:00.000Z',
  updatedAt: '2026-11-05T13:00:00.000Z',
  items: [
    {
      productId: 1,
      quantity: 1,
      unitPrice: { amountCents: 100, currency: 'BRL', formatted: 'R$ 1,00' },
      subtotal: { amountCents: 100, currency: 'BRL', formatted: 'R$ 1,00' },
    },
  ],
  total: { amountCents: 100, currency: 'BRL', formatted: 'R$ 1,00' },
  shipping: { trackingCode: null, estimatedDeliveryDate: null, shippedAt: null, deliveredAt: null },
  cancellation: {
    eligible: false,
    blockedReason: 'ALREADY_CANCELLED',
    cancelledAt: '2026-11-05T13:00:00.000Z',
  },
};

const json = (body: unknown, status: number) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

function client(fetchImpl: typeof fetch) {
  const fetchFn = vi.fn(fetchImpl);
  return {
    fetchFn,
    api: new OrdersApiClient({
      baseUrl: 'http://orders.test',
      apiKey: 'agent-key-0123456789',
      logger: createLogger({ service: 'test', level: 'silent' }),
      fetchFn,
      random: () => 0,
    }),
  };
}

const cancel = (api: OrdersApiClient) =>
  api.requestCancellation('cust-1', '100101', { idempotencyKey: 'pending-1', reason: null });

describe('OrdersApiClient — resultados de negócio explícitos', () => {
  it('[AG-38] cancelamento só é sucesso com 200 E pedido devolvido como CANCELLED (regra 5)', async () => {
    expect((await cancel(client(() => json({ order: ORDER }, 200)).api)).kind).toBe('cancelled');
    const weird = await cancel(
      client(() => json({ order: { ...ORDER, status: 'PROCESSING' } }, 200)).api,
    );
    expect(weird).toEqual({ kind: 'technical_error', reason: 'unexpected_response' });
  });

  it('[AG-38] 409 ORDER_NOT_CANCELLABLE vira not_cancellable com o motivo', async () => {
    const result = await cancel(
      client(() =>
        json(
          { code: 'ORDER_NOT_CANCELLABLE', currentStatus: 'SHIPPED', reason: 'ALREADY_SHIPPED' },
          409,
        ),
      ).api,
    );
    expect(result).toEqual({
      kind: 'not_cancellable',
      currentStatus: 'SHIPPED',
      reason: 'ALREADY_SHIPPED',
    });
  });

  it('[AG-38] 404 vira not_found', async () => {
    expect(await cancel(client(() => json({ code: 'ORDER_NOT_FOUND' }, 404)).api)).toEqual({
      kind: 'not_found',
    });
  });

  it.each([
    [503, 'unavailable'],
    [500, 'unavailable'],
    [401, 'unauthorized'],
  ])('[AG-38] HTTP %i vira erro técnico (%s)', async (status, reason) => {
    expect(await cancel(client(() => json({ code: 'X' }, status)).api)).toEqual({
      kind: 'technical_error',
      reason,
    });
  });

  it('[AG-38] corpo fora do contrato vira erro técnico, nunca sucesso', async () => {
    const result = await client(() => json({ inesperado: true }, 200)).api.getOrder(
      'cust-1',
      '100101',
    );
    expect(result).toEqual({ kind: 'technical_error', reason: 'unexpected_response' });
  });

  it('[AG-38] timeout vira erro técnico', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const api = new OrdersApiClient({
      baseUrl: 'http://orders.test',
      apiKey: 'k',
      logger: createLogger({ service: 'test', level: 'silent' }),
      fetchFn: hang,
      timeoutMs: 20,
      maxRetries: 0,
    });
    expect(await api.getOrder('cust-1', '100101')).toEqual({
      kind: 'technical_error',
      reason: 'timeout',
    });
  });
});

describe('OrdersApiClient — transporte', () => {
  it('[AG-38] repete o cancelamento com a MESMA Idempotency-Key após falha transitória', async () => {
    let calls = 0;
    const { api, fetchFn } = client(() => {
      calls += 1;
      return calls === 1 ? json({ code: 'SERVICE_UNAVAILABLE' }, 503) : json({ order: ORDER }, 200);
    });
    expect((await cancel(api)).kind).toBe('cancelled');
    const keys = fetchFn.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('idempotency-key'),
    );
    expect(keys).toEqual(['pending-1', 'pending-1']);
  });

  it('[AG-38] não repete quando a credencial é recusada', async () => {
    const { api, fetchFn } = client(() => json({ code: 'UNAUTHENTICATED' }, 401));
    await api.getOrder('cust-1', '100101');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('[AG-38] envia chave de API e propaga o correlation id', async () => {
    const { api, fetchFn } = client(() => json({ customerId: 'c', firstName: 'Ana' }, 200));
    await runWithContext({ correlationId: 'corr-abc-123456' }, () =>
      api.findCustomerByPhone('+5551990000001'),
    );
    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-api-key')).toBe('agent-key-0123456789');
    expect(headers.get('x-correlation-id')).toBe('corr-abc-123456');
    // o telefone vai no corpo, nunca na URL
    expect((fetchFn.mock.calls[0]?.[0] as URL).toString()).not.toContain('5551990000001');
  });

  it('[AG-38] codifica identificadores na URL', async () => {
    const { api, fetchFn } = client(() => json({ code: 'ORDER_NOT_FOUND' }, 404));
    await api.getOrder('../admin', '100101');
    expect((fetchFn.mock.calls[0]?.[0] as URL).toString()).toContain(
      '/v1/customers/..%2Fadmin/orders/100101',
    );
  });
});
