import { randomInt } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { resetDemoData } from './seed.js';

/**
 * Operações exclusivas de demonstração (DEMO_MODE): recriar os dados e simular o despacho de um
 * pedido, para mostrar ao vivo a corrida entre a confirmação do cliente e o envio.
 */
export function createDemoOperations(db: Kysely<Database>) {
  return {
    reset: () => resetDemoData(db),

    async shipOrder(orderId: string, correlationId: string | null): Promise<boolean> {
      return db.transaction().execute(async (trx) => {
        const now = new Date();
        const shipped = await trx
          .updateTable('orders')
          .set({
            status: 'SHIPPED',
            shipped_at: now,
            updated_at: now,
            tracking_code: `QB${String(randomInt(100_000_000, 999_999_999))}BR`,
          })
          .where('id', '=', orderId)
          .where('status', '=', 'PROCESSING')
          .returning('id')
          .executeTakeFirst();
        if (!shipped) return false;
        await trx
          .insertInto('order_status_history')
          .values({
            order_id: orderId,
            from_status: 'PROCESSING',
            to_status: 'SHIPPED',
            actor: 'demo',
            reason: 'despacho simulado pelo simulador',
            correlation_id: correlationId,
          })
          .execute();
        return true;
      });
    },
  };
}
