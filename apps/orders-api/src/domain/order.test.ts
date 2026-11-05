import { describe, expect, it } from 'vitest';

import { cancelOrder, evaluateCancellation, firstName, type Order } from './order.js';

const baseOrder: Order = {
  id: '100101',
  customerId: '6f1c2a10-0000-4000-8000-000000000001',
  status: 'PROCESSING',
  items: [{ productId: 1, quantity: 1, unitPriceCents: 54990 }],
  totalCents: 54990,
  trackingCode: null,
  estimatedDeliveryDate: '2026-11-20',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  updatedAt: new Date('2026-11-01T10:00:00Z'),
  shippedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  cancellationReason: null,
};

describe('evaluateCancellation (regras 2 e 3)', () => {
  it('permite cancelar somente pedidos em processamento', () => {
    expect(evaluateCancellation('PROCESSING')).toEqual({ eligible: true });
  });

  it.each([
    ['SHIPPED', 'ALREADY_SHIPPED'],
    ['DELIVERED', 'ALREADY_DELIVERED'],
    ['CANCELLED', 'ALREADY_CANCELLED'],
    ['AWAITING_PAYMENT', 'PAYMENT_PENDING'],
  ])('bloqueia pedido %s com motivo %s', (status, reason) => {
    expect(evaluateCancellation(status)).toEqual({ eligible: false, reason });
  });

  it('nega por padrão qualquer status desconhecido (allowlist)', () => {
    expect(evaluateCancellation('RETURNED')).toEqual({ eligible: false, reason: 'UNKNOWN_STATUS' });
    expect(evaluateCancellation('processing')).toEqual({
      eligible: false,
      reason: 'UNKNOWN_STATUS',
    });
  });
});

describe('cancelOrder', () => {
  const now = new Date('2026-11-05T12:00:00Z');

  it('cancela pedido em processamento registrando data e motivo', () => {
    const result = cancelOrder(baseOrder, now, 'comprei errado');
    expect(result).toEqual({
      ok: true,
      order: {
        ...baseOrder,
        status: 'CANCELLED',
        cancelledAt: now,
        updatedAt: now,
        cancellationReason: 'comprei errado',
      },
    });
  });

  it('não altera o pedido original (transição pura)', () => {
    cancelOrder(baseOrder, now, null);
    expect(baseOrder.status).toBe('PROCESSING');
  });

  it('recusa cancelar pedido enviado', () => {
    expect(cancelOrder({ ...baseOrder, status: 'SHIPPED' }, now, null)).toEqual({
      ok: false,
      reason: 'ALREADY_SHIPPED',
    });
  });
});

describe('firstName', () => {
  it('extrai apenas o primeiro nome (minimização de dados)', () => {
    expect(firstName('  Ana Paula Souza ')).toBe('Ana');
  });
});
