import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type {
  CustomersRepository,
  IdempotencyClaim,
  OrdersReadRepository,
  TransactionScope,
  UnitOfWork,
} from '../application/ports.js';
import type { Order } from '../domain/order.js';
import type { Database, OrdersTable } from './database.js';
import { outcomeToStored, rowToOrder, storedToOutcome } from './order-mapper.js';

type Executor = Kysely<Database> | Transaction<Database>;

export const IDEMPOTENCY_TTL = '24 hours';

async function loadItems(executor: Executor, orderIds: readonly string[]) {
  if (orderIds.length === 0) return [];
  return executor
    .selectFrom('order_items')
    .selectAll()
    .where('order_id', 'in', orderIds)
    .orderBy('id')
    .execute();
}

/** Carrega os itens de vários pedidos em uma única consulta (evita N+1). */
async function hydrate(
  executor: Executor,
  rows: readonly Selectable<OrdersTable>[],
): Promise<Order[]> {
  const items = await loadItems(
    executor,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    rowToOrder(
      row,
      items.filter((item) => item.order_id === row.id),
    ),
  );
}

export function createPostgresRepositories(db: Kysely<Database>): {
  customers: CustomersRepository;
  orders: OrdersReadRepository;
  unitOfWork: UnitOfWork;
} {
  const customers: CustomersRepository = {
    async findByPhone(phone) {
      const row = await db
        .selectFrom('customers')
        .select(['id', 'full_name'])
        .where('phone', '=', phone)
        .executeTakeFirst();
      return row ? { id: row.id, fullName: row.full_name } : null;
    },
  };

  const orders: OrdersReadRepository = {
    async findForCustomer(customerId, orderId) {
      const row = await db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .where('customer_id', '=', customerId)
        .executeTakeFirst();
      if (!row) return null;
      const [order] = await hydrate(db, [row]);
      return order ?? null;
    },

    async listForCustomer(customerId, limit) {
      const rows = await db
        .selectFrom('orders')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return hydrate(db, rows);
    },
  };

  const scopeFor = (trx: Transaction<Database>): TransactionScope => ({
    orders: {
      async findForUpdate(customerId, orderId) {
        const row = await trx
          .selectFrom('orders')
          .selectAll()
          .where('id', '=', orderId)
          .where('customer_id', '=', customerId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) return null;
        const [order] = await hydrate(trx, [row]);
        return order ?? null;
      },

      async saveCancellation(order) {
        await trx
          .updateTable('orders')
          .set({
            status: order.status,
            cancelled_at: order.cancelledAt,
            cancellation_reason: order.cancellationReason,
            estimated_delivery_date: order.estimatedDeliveryDate,
            updated_at: order.updatedAt,
          })
          .where('id', '=', order.id)
          .execute();
      },
    },

    statusHistory: {
      async append(entry) {
        await trx
          .insertInto('order_status_history')
          .values({
            order_id: entry.orderId,
            from_status: entry.fromStatus,
            to_status: entry.toStatus,
            actor: entry.actor,
            reason: entry.reason,
            correlation_id: entry.correlationId,
          })
          .execute();
      },
    },

    idempotency: {
      async claim(customerId, key, fingerprint): Promise<IdempotencyClaim> {
        // Chaves valem por IDEMPOTENCY_TTL; depois disso a mesma chave inicia uma nova tentativa.
        await trx
          .deleteFrom('idempotency_keys')
          .where('customer_id', '=', customerId)
          .where('key', '=', key)
          .where('created_at', '<', sql<Date>`now() - ${IDEMPOTENCY_TTL}::interval`)
          .execute();
        // Se outra transação já inseriu a mesma chave e ainda não terminou, o INSERT espera
        // por ela. Ao terminar, o ON CONFLICT faz este INSERT não inserir nada e lemos o
        // resultado gravado pela primeira.
        const inserted = await trx
          .insertInto('idempotency_keys')
          .values({ customer_id: customerId, key, request_fingerprint: fingerprint })
          .onConflict((oc) => oc.columns(['customer_id', 'key']).doNothing())
          .returning('key')
          .executeTakeFirst();
        if (inserted) return { status: 'acquired' };

        const existing = await trx
          .selectFrom('idempotency_keys')
          .select(['request_fingerprint', 'outcome'])
          .where('customer_id', '=', customerId)
          .where('key', '=', key)
          .executeTakeFirstOrThrow();

        // outcome nulo não deveria ocorrer (a chave e o resultado são gravados na mesma
        // transação); por segurança, é tratado como conflito e nunca como sucesso.
        if (existing.request_fingerprint !== fingerprint || existing.outcome === null) {
          return { status: 'mismatch' };
        }
        return { status: 'replay', outcome: storedToOutcome(existing.outcome) };
      },

      async complete(customerId, key, outcome) {
        await trx
          .updateTable('idempotency_keys')
          .set({ outcome: JSON.stringify(outcomeToStored(outcome)) })
          .where('customer_id', '=', customerId)
          .where('key', '=', key)
          .execute();
      },
    },
  });

  const unitOfWork: UnitOfWork = {
    transaction: (work) =>
      db.transaction().execute(async (trx) => {
        // Não espera indefinidamente pelo bloqueio de um pedido: após 3s falha com 55P03,
        // que a API responde como 503 (pode ser repetido) em vez de segurar a conexão.
        await sql`SET LOCAL lock_timeout = '3s'`.execute(trx);
        return work(scopeFor(trx));
      }),
  };

  return { customers, orders, unitOfWork };
}
