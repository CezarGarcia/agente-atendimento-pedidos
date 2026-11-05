import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';

import type { Logger } from '@agente/shared';

import type { OrderSnapshot } from './order-mapper.js';

// DATE (oid 1082) volta como string 'AAAA-MM-DD' em vez de Date à meia-noite local:
// evita deslocamento de fuso em datas sem horário (ex.: previsão de entrega).
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface CustomersTable {
  id: Generated<string>;
  full_name: string;
  phone: string;
  created_at: Generated<Date>;
}

export interface OrdersTable {
  id: string;
  customer_id: string;
  status: string;
  total_cents: number;
  currency: Generated<string>;
  tracking_code: string | null;
  estimated_delivery_date: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  shipped_at: Timestamp | null;
  delivered_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  cancellation_reason: string | null;
}

export interface OrderItemsTable {
  id: Generated<number>;
  order_id: string;
  product_id: number;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderStatusHistoryTable {
  id: Generated<string>;
  order_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string | null;
  correlation_id: string | null;
  changed_at: Generated<Date>;
}

export type StoredOutcome =
  | { kind: 'cancelled'; order: OrderSnapshot }
  | { kind: 'not_found' }
  | { kind: 'not_cancellable'; order: OrderSnapshot; reason: string };

export interface IdempotencyKeysTable {
  customer_id: string;
  key: string;
  request_fingerprint: string;
  outcome: ColumnType<StoredOutcome | null, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface Database {
  customers: CustomersTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_status_history: OrderStatusHistoryTable;
  idempotency_keys: IdempotencyKeysTable;
}

export interface DatabaseOptions {
  readonly logger: Logger;
  readonly maxConnections?: number;
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions,
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'orders-api',
  });
  // Sem este listener, uma conexão ociosa derrubada pelo banco (restart, failover,
  // pg_terminate_backend) emite 'error' sem tratamento e encerra o processo. O pool descarta
  // a conexão quebrada e abre outra na próxima requisição.
  pool.on('error', (error: Error & { code?: string }) => {
    options.logger.warn(
      { event: 'db.pool.idle_client_error', code: error.code },
      'conexão ociosa com o banco foi encerrada; será recriada',
    );
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
