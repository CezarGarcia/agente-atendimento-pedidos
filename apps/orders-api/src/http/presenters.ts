import type { z } from 'zod';

import { evaluateCancellation, firstName, type Customer, type Order } from '../domain/order.js';
import type {
  CustomerLookupResultSchema,
  MoneySchema,
  OrderSchema,
  OrderSummarySchema,
} from './schemas.js';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function money(amountCents: number): z.infer<typeof MoneySchema> {
  return {
    amountCents,
    currency: 'BRL',
    // Intl usa espaço não separável (U+00A0); normalizamos para espaço comum.
    formatted: brl.format(amountCents / 100).replace(/\u00A0/g, ' '),
  };
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function presentOrder(order: Order): z.infer<typeof OrderSchema> {
  const eligibility = evaluateCancellation(order.status);
  return {
    id: order.id,
    status: order.status,
    placedAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: money(item.unitPriceCents),
      subtotal: money(item.unitPriceCents * item.quantity),
    })),
    total: money(order.totalCents),
    shipping: {
      trackingCode: order.trackingCode,
      estimatedDeliveryDate: order.estimatedDeliveryDate,
      shippedAt: iso(order.shippedAt),
      deliveredAt: iso(order.deliveredAt),
    },
    cancellation: {
      eligible: eligibility.eligible,
      blockedReason: eligibility.eligible ? null : eligibility.reason,
      cancelledAt: iso(order.cancelledAt),
    },
  };
}

export function presentOrderSummary(order: Order): z.infer<typeof OrderSummarySchema> {
  return {
    id: order.id,
    status: order.status,
    placedAt: order.createdAt.toISOString(),
    total: money(order.totalCents),
    itemCount: order.items.reduce((count, item) => count + item.quantity, 0),
  };
}

export function presentCustomer(customer: Customer): z.infer<typeof CustomerLookupResultSchema> {
  return { customerId: customer.id, firstName: firstName(customer.fullName) };
}
