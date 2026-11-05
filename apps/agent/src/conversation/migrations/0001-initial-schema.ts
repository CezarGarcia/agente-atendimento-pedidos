import { sql, type Kysely } from 'kysely';

/**
 * Estado do agente. Não há telefone em claro: a conversa é encontrada pelo HMAC do número.
 * O histórico guarda as mensagens já sem os dados pessoais mascarados na entrada.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE conversations (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_ref            text NOT NULL,
      customer_id          text,
      customer_first_name  text,
      identity_status      text NOT NULL CHECK (identity_status IN ('verified', 'unknown_customer', 'lookup_failed')),
      status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'handed_off', 'closed')),
      created_at           timestamptz NOT NULL DEFAULT now(),
      last_activity_at     timestamptz NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX conversations_phone_activity_idx ON conversations (phone_ref, last_activity_at DESC)`.execute(
    db,
  );

  await sql`
    CREATE TABLE conversation_messages (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      kind             text NOT NULL CHECK (kind IN ('customer', 'agent', 'tool', 'system_note')),
      -- json (e não jsonb) preserva o conteúdo exatamente como foi enviado ao modelo.
      payload          json NOT NULL,
      display_text     text,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX conversation_messages_conversation_idx ON conversation_messages (conversation_id, id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE pending_actions (
      id               uuid PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      type             text NOT NULL CHECK (type IN ('cancel_order')),
      order_id         text NOT NULL,
      reason           text,
      order_summary    text NOT NULL,
      status           text NOT NULL CHECK (status IN ('awaiting_confirmation', 'outcome_unknown', 'completed', 'rejected', 'declined', 'superseded', 'expired')),
      created_at       timestamptz NOT NULL,
      expires_at       timestamptz NOT NULL,
      updated_at       timestamptz NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX pending_actions_conversation_idx ON pending_actions (conversation_id, created_at DESC)`.execute(
    db,
  );

  await sql`
    CREATE TABLE handoffs (
      protocol         text PRIMARY KEY,
      conversation_id  uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
      reason           text NOT NULL,
      summary          text NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE processed_messages (
      message_id       text PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      reply            jsonb NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE turn_traces (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      correlation_id   text NOT NULL,
      trace            jsonb NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX turn_traces_conversation_idx ON turn_traces (conversation_id, id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE turn_traces, processed_messages, handoffs, pending_actions, conversation_messages, conversations`.execute(
    db,
  );
}
