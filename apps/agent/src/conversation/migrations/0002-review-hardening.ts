import { sql, type Kysely } from 'kysely';

/**
 * Ajustes da revisão de segurança do agente:
 *  - perfil do modelo por conversa (prompt + modelo), para não reenviar raciocínio com outro prefixo;
 *  - confirmação por texto só logo após a pergunta de confirmação (awaiting_text_reply);
 *  - status 'executing' para reservar a execução de forma atômica entre instâncias;
 *  - deduplicação de mensagens reservada no início do processamento (reply nulo = em andamento).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE conversations ADD COLUMN llm_profile text NOT NULL DEFAULT ''`.execute(db);

  await sql`ALTER TABLE pending_actions ADD COLUMN awaiting_text_reply boolean NOT NULL DEFAULT false`.execute(
    db,
  );
  await sql`ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_status_check`.execute(db);
  await sql`
    ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_status_check CHECK (status IN
      ('awaiting_confirmation', 'executing', 'outcome_unknown', 'completed', 'rejected', 'declined', 'superseded', 'expired'))
  `.execute(db);

  await sql`ALTER TABLE processed_messages ALTER COLUMN reply DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE processed_messages ALTER COLUMN conversation_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE processed_messages ADD COLUMN claimed_at timestamptz NOT NULL DEFAULT now()`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE processed_messages DROP COLUMN claimed_at`.execute(db);
  await sql`ALTER TABLE pending_actions DROP COLUMN awaiting_text_reply`.execute(db);
  await sql`ALTER TABLE conversations DROP COLUMN llm_profile`.execute(db);
}
