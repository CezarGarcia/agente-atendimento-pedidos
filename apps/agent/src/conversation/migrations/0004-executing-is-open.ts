import { sql, type Kysely } from 'kysely';

/**
 * Uma ação em execução (`executing`) também ocupa a vaga de ação aberta da conversa. O índice da
 * 0003 a deixava de fora: com duas instâncias, outra mensagem abria uma confirmação enquanto a
 * primeira esperava a API, e a passagem da primeira para `outcome_unknown` violava o índice. O
 * cliente recebia "instabilidade" em vez de "não consegui confirmar", e a ação ficava presa em
 * `executing`, sem nova tentativa com a mesma chave (revisão do código das rodadas de avaliação).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Dados antigos: uma ação aberta ao lado de outra em execução perde a vez (a em execução segue).
  await sql`
    UPDATE pending_actions AS other SET status = 'superseded'
    WHERE other.status IN ('awaiting_confirmation', 'outcome_unknown')
      AND EXISTS (
        SELECT 1 FROM pending_actions AS running
        WHERE running.conversation_id = other.conversation_id
          AND running.status = 'executing'
      )
  `.execute(db);
  await sql`DROP INDEX IF EXISTS pending_actions_one_open_per_conversation`.execute(db);
  await sql`
    CREATE UNIQUE INDEX pending_actions_one_open_per_conversation
    ON pending_actions (conversation_id)
    WHERE status IN ('awaiting_confirmation', 'outcome_unknown', 'executing')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pending_actions_one_open_per_conversation`.execute(db);
  await sql`
    CREATE UNIQUE INDEX pending_actions_one_open_per_conversation
    ON pending_actions (conversation_id)
    WHERE status IN ('awaiting_confirmation', 'outcome_unknown')
  `.execute(db);
}
