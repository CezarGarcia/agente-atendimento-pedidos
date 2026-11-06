import { sql, type Kysely } from 'kysely';

/**
 * No máximo UMA ação pendente aberta por conversa. A fila que serializa as mensagens de uma
 * conversa vive em memória; com duas instâncias, duas mensagens simultâneas podiam abrir duas
 * confirmações, e responder a uma deixava a outra aceitando "sim" (revisão adversarial). O índice
 * único faz o banco recusar a segunda; o turno que perde a corrida falha sem efeito colateral.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Dados antigos com mais de uma ação aberta: fica valendo só a mais recente.
  await sql`
    UPDATE pending_actions AS older SET status = 'superseded'
    WHERE older.status IN ('awaiting_confirmation', 'outcome_unknown')
      AND EXISTS (
        SELECT 1 FROM pending_actions AS newer
        WHERE newer.conversation_id = older.conversation_id
          AND newer.status IN ('awaiting_confirmation', 'outcome_unknown')
          AND (newer.created_at, newer.id) > (older.created_at, older.id)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX pending_actions_one_open_per_conversation
    ON pending_actions (conversation_id)
    WHERE status IN ('awaiting_confirmation', 'outcome_unknown')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pending_actions_one_open_per_conversation`.execute(db);
}
