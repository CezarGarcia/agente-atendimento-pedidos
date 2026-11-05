import type { Selectable } from 'kysely';

import type { CancellationOutcome } from '../application/ports.js';
import {
  CANCELLATION_BLOCK_REASONS,
  evaluateCancellation,
  isOrderStatus,
  type CancellationBlockReason,
  type Order,
} from '../domain/order.js';
import type { OrderItemsTable, OrdersTable, StoredOutcome } from './database.js';

/** Representação serializável de um pedido, usada para gravar respostas idempotentes. */
export interface OrderSnapshot {
  id: string;
  customerId: string;
  status: string;
  items: { productId: number; quantity: number; unitPriceCents: number }[];
  totalCents: number;
  trackingCode: string | null;
  estimatedDeliveryDate: string | null;
  createdAt: string;
  updatedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

const isBlockReason = (value: string): value is CancellationBlockReason =>
  (CANCELLATION_BLOCK_REASONS as readonly string[]).includes(value);

export class DataIntegrityError extends Error {
  override readonly name = 'DataIntegrityError';
}

function requireStatus(status: string, orderId: string): Order['status'] {
  if (!isOrderStatus(status)) {
    throw new DataIntegrityError(`Pedido ${orderId} com status desconhecido no banco: ${status}`);
  }
  return status;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const toNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : toDate(value);

export function rowToOrder(
  row: Selectable<OrdersTable>,
  items: readonly Selectable<OrderItemsTable>[],
): Order {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: requireStatus(row.status, row.id),
    items: items.map((item) => ({
      productId: item.product_id,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
    })),
    totalCents: row.total_cents,
    trackingCode: row.tracking_code,
    estimatedDeliveryDate: row.estimated_delivery_date,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    shippedAt: toNullableDate(row.shipped_at),
    deliveredAt: toNullableDate(row.delivered_at),
    cancelledAt: toNullableDate(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
  };
}

export function orderToSnapshot(order: Order): OrderSnapshot {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    shippedAt: order.shippedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
  };
}

export function snapshotToOrder(snapshot: OrderSnapshot): Order {
  return {
    ...snapshot,
    status: requireStatus(snapshot.status, snapshot.id),
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    shippedAt: toNullableDate(snapshot.shippedAt),
    deliveredAt: toNullableDate(snapshot.deliveredAt),
    cancelledAt: toNullableDate(snapshot.cancelledAt),
  };
}

export function outcomeToStored(outcome: CancellationOutcome): StoredOutcome {
  switch (outcome.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'cancelled':
      return { kind: 'cancelled', order: orderToSnapshot(outcome.order) };
    case 'not_cancellable':
      return {
        kind: 'not_cancellable',
        order: orderToSnapshot(outcome.order),
        reason: outcome.reason,
      };
  }
}

export function storedToOutcome(stored: StoredOutcome): CancellationOutcome {
  switch (stored.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'cancelled':
      return { kind: 'cancelled', order: snapshotToOrder(stored.order) };
    case 'not_cancellable': {
      const order = snapshotToOrder(stored.order);
      const eligibility = evaluateCancellation(order.status);
      const reason = isBlockReason(stored.reason)
        ? stored.reason
        : eligibility.eligible
          ? 'UNKNOWN_STATUS'
          : eligibility.reason;
      return { kind: 'not_cancellable', order, reason };
    }
  }
}
