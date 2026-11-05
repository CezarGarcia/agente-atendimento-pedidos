import { sql, type Kysely } from 'kysely';

import type { OrderStatus } from '../domain/order.js';
import type { Database } from './database.js';

/**
 * Dados de demonstração. Cada persona exercita um ramo diferente das regras de negócio.
 * Os telefones são fictícios. Os productId apontam para produtos da Fake Store API; o 999 não
 * existe lá de propósito, para demonstrar a degradação quando o catálogo externo não responde.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface SeedOrder {
  id: string;
  status: OrderStatus;
  items: { productId: number; quantity: number; unitPriceCents: number }[];
  createdAgoMs: number;
  shippedAgoMs?: number;
  deliveredAgoMs?: number;
  cancelledAgoMs?: number;
  cancellationReason?: string;
  trackingCode?: string;
  etaInDays?: number;
}

interface SeedCustomer {
  id: string;
  fullName: string;
  phone: string;
  orders: SeedOrder[];
}

export const DEMO_CUSTOMERS: readonly SeedCustomer[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    fullName: 'Ana Souza',
    phone: '+5551990000001',
    orders: [
      {
        id: '100101',
        status: 'PROCESSING',
        items: [
          { productId: 1, quantity: 1, unitPriceCents: 54990 },
          { productId: 3, quantity: 1, unitPriceCents: 27990 },
        ],
        createdAgoMs: 1 * DAY,
        etaInDays: 7,
      },
      {
        id: '100102',
        status: 'SHIPPED',
        items: [{ productId: 9, quantity: 1, unitPriceCents: 31990 }],
        createdAgoMs: 4 * DAY,
        shippedAgoMs: 2 * DAY,
        trackingCode: 'QB123456785BR',
        etaInDays: 3,
      },
      {
        id: '100103',
        status: 'DELIVERED',
        items: [{ productId: 18, quantity: 2, unitPriceCents: 4990 }],
        createdAgoMs: 20 * DAY,
        shippedAgoMs: 18 * DAY,
        deliveredAgoMs: 15 * DAY,
        trackingCode: 'QB987654321BR',
      },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    fullName: 'Bruno Lima',
    phone: '+5551990000002',
    orders: [
      {
        id: '100201',
        status: 'PROCESSING',
        items: [{ productId: 14, quantity: 1, unitPriceCents: 499990 }],
        createdAgoMs: 2 * HOUR,
        etaInDays: 10,
      },
      {
        id: '100202',
        status: 'CANCELLED',
        items: [{ productId: 5, quantity: 1, unitPriceCents: 347500 }],
        createdAgoMs: 12 * DAY,
        cancelledAgoMs: 10 * DAY,
        cancellationReason: 'Desistência da compra',
      },
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    fullName: 'Carla Mendes',
    phone: '+5551990000003',
    orders: [
      {
        id: '100301',
        status: 'AWAITING_PAYMENT',
        items: [{ productId: 10, quantity: 1, unitPriceCents: 54500 }],
        createdAgoMs: HOUR / 2,
      },
      {
        id: '100302',
        status: 'PROCESSING',
        items: [
          { productId: 999, quantity: 1, unitPriceCents: 8990 },
          { productId: 7, quantity: 1, unitPriceCents: 4990 },
        ],
        createdAgoMs: 3 * HOUR,
        etaInDays: 8,
      },
    ],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    fullName: 'Diego Rocha',
    phone: '+5551990000004',
    orders: [],
  },
];

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Apaga e recria os dados de demonstração (usado no seed e no reset do simulador). */
export async function resetDemoData(db: Kysely<Database>, now: Date = new Date()): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`TRUNCATE idempotency_keys, order_status_history, order_items, orders, customers`.execute(
      trx,
    );

    for (const customer of DEMO_CUSTOMERS) {
      await trx
        .insertInto('customers')
        .values({ id: customer.id, full_name: customer.fullName, phone: customer.phone })
        .execute();

      for (const order of customer.orders) {
        const at = (agoMs: number | undefined) =>
          agoMs === undefined ? null : new Date(now.getTime() - agoMs);
        const createdAt = new Date(now.getTime() - order.createdAgoMs);
        const updatedAt =
          at(order.cancelledAgoMs) ??
          at(order.deliveredAgoMs) ??
          at(order.shippedAgoMs) ??
          createdAt;

        await trx
          .insertInto('orders')
          .values({
            id: order.id,
            customer_id: customer.id,
            status: order.status,
            total_cents: order.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
            tracking_code: order.trackingCode ?? null,
            estimated_delivery_date:
              order.etaInDays === undefined
                ? null
                : isoDate(new Date(now.getTime() + order.etaInDays * DAY)),
            created_at: createdAt,
            updated_at: updatedAt,
            shipped_at: at(order.shippedAgoMs),
            delivered_at: at(order.deliveredAgoMs),
            cancelled_at: at(order.cancelledAgoMs),
            cancellation_reason: order.cancellationReason ?? null,
          })
          .execute();

        await trx
          .insertInto('order_items')
          .values(
            order.items.map((item) => ({
              order_id: order.id,
              product_id: item.productId,
              quantity: item.quantity,
              unit_price_cents: item.unitPriceCents,
            })),
          )
          .execute();

        await trx
          .insertInto('order_status_history')
          .values({
            order_id: order.id,
            from_status: null,
            to_status: order.status,
            actor: 'seed',
            reason: 'dados de demonstração',
            correlation_id: null,
          })
          .execute();
      }
    }
  });
}

/** Popula o banco apenas se estiver vazio (seguro para rodar a cada inicialização). */
export async function seedIfEmpty(db: Kysely<Database>): Promise<boolean> {
  const existing = await db.selectFrom('customers').select('id').limit(1).executeTakeFirst();
  if (existing) return false;
  await resetDemoData(db);
  return true;
}
