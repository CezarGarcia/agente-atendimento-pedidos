import { sql, type Kysely } from 'kysely';

/**
 * Esquema inicial. As restrições (CHECK, FK, UNIQUE) repetem no banco as invariantes do
 * domínio: mesmo um acesso direto ao banco não consegue criar um pedido com status inválido.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE customers (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name   text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
      phone       text NOT NULL UNIQUE CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$'),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE orders (
      id                       text PRIMARY KEY CHECK (id ~ '^[0-9]{6}$'),
      customer_id              uuid NOT NULL REFERENCES customers (id),
      status                   text NOT NULL CHECK (status IN
                                 ('AWAITING_PAYMENT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
      total_cents              integer NOT NULL CHECK (total_cents >= 0),
      currency                 char(3) NOT NULL DEFAULT 'BRL',
      tracking_code            text,
      estimated_delivery_date  date,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      shipped_at               timestamptz,
      delivered_at             timestamptz,
      cancelled_at             timestamptz,
      cancellation_reason      text CHECK (length(cancellation_reason) <= 500),
      CONSTRAINT cancelled_orders_have_timestamp
        CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC)`.execute(
    db,
  );

  await sql`
    CREATE TABLE order_items (
      id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id          text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      product_id        integer NOT NULL CHECK (product_id > 0),
      quantity          integer NOT NULL CHECK (quantity > 0),
      unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0)
    )
  `.execute(db);
  await sql`CREATE INDEX order_items_order_idx ON order_items (order_id)`.execute(db);

  // Trilha de auditoria: toda transição de status fica registrada, com quem e por quê.
  await sql`
    CREATE TABLE order_status_history (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id        text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      from_status     text,
      to_status       text NOT NULL,
      actor           text NOT NULL,
      reason          text,
      correlation_id  text,
      changed_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, changed_at)`.execute(
    db,
  );

  await sql`
    CREATE TABLE idempotency_keys (
      customer_id          uuid NOT NULL,
      key                  text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
      request_fingerprint  text NOT NULL,
      outcome              jsonb,
      created_at           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (customer_id, key)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE idempotency_keys, order_status_history, order_items, orders, customers`.execute(
    db,
  );
}
