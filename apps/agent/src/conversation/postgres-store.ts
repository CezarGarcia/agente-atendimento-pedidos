import { randomInt } from 'node:crypto';

import { sql, type Kysely, type Selectable } from 'kysely';

import type {
  Conversation,
  HandoffTicket,
  IdentityStatus,
  MessageKind,
  PendingAction,
  PendingActionStatus,
  StoredMessage,
  TurnTrace,
} from '../agent/types.js';
import type { AgentDatabase } from './database.js';
import type { CompletedTurn, ConversationStore, MessageClaim } from './store.js';

type ConversationRow = Selectable<AgentDatabase['conversations']>;
type PendingRow = Selectable<AgentDatabase['pending_actions']>;

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  phoneRef: row.phone_ref,
  customerId: row.customer_id,
  customerFirstName: row.customer_first_name,
  identityStatus: row.identity_status as IdentityStatus,
  status: row.status as Conversation['status'],
  llmProfile: row.llm_profile,
  createdAt: row.created_at,
  lastActivityAt: new Date(row.last_activity_at),
});

const toPending = (row: PendingRow): PendingAction => ({
  id: row.id,
  conversationId: row.conversation_id,
  type: 'cancel_order',
  orderId: row.order_id,
  reason: row.reason,
  orderSummary: row.order_summary,
  status: row.status as PendingActionStatus,
  awaitingTextReply: row.awaiting_text_reply,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
});

const UNIQUE_VIOLATION = '23505';
/** Reserva de mensagem sem resposta após este tempo é considerada abandonada (processo caiu). */
const STALE_CLAIM = '2 minutes';

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly db: Kysely<AgentDatabase>) {}

  async findActiveConversation(phoneRef: string, idleSince: Date): Promise<Conversation | null> {
    const row = await this.db
      .selectFrom('conversations')
      .selectAll()
      .where('phone_ref', '=', phoneRef)
      .where('status', '!=', 'closed')
      .where('last_activity_at', '>=', idleSince)
      .orderBy('last_activity_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toConversation(row) : null;
  }

  async createConversation(
    input: Omit<Conversation, 'id' | 'createdAt' | 'lastActivityAt' | 'status'>,
  ): Promise<Conversation> {
    const row = await this.db
      .insertInto('conversations')
      .values({
        phone_ref: input.phoneRef,
        customer_id: input.customerId,
        customer_first_name: input.customerFirstName,
        identity_status: input.identityStatus,
        llm_profile: input.llmProfile,
        last_activity_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConversation(row);
  }

  async updateConversation(
    id: string,
    patch: Partial<
      Pick<Conversation, 'customerId' | 'customerFirstName' | 'identityStatus' | 'status'>
    >,
  ): Promise<void> {
    await this.db
      .updateTable('conversations')
      .set({
        ...(patch.customerId === undefined ? {} : { customer_id: patch.customerId }),
        ...(patch.customerFirstName === undefined
          ? {}
          : { customer_first_name: patch.customerFirstName }),
        ...(patch.identityStatus === undefined ? {} : { identity_status: patch.identityStatus }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      })
      .where('id', '=', id)
      .execute();
  }

  async closeConversation(id: string): Promise<void> {
    await this.updateConversation(id, { status: 'closed' });
  }

  async loadMessages(conversationId: string): Promise<StoredMessage[]> {
    const rows = await this.db
      .selectFrom('conversation_messages')
      .select(['payload', 'kind', 'display_text'])
      .where('conversation_id', '=', conversationId)
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      message: row.payload,
      kind: row.kind as MessageKind,
      displayText: row.display_text,
    }));
  }

  async findOpenPendingAction(conversationId: string): Promise<PendingAction | null> {
    const row = await this.db
      .selectFrom('pending_actions')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('status', 'in', ['awaiting_confirmation', 'outcome_unknown'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toPending(row) : null;
  }

  async listPendingActions(conversationId: string): Promise<PendingAction[]> {
    const rows = await this.db
      .selectFrom('pending_actions')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at')
      .execute();
    return rows.map(toPending);
  }

  async savePendingAction(action: PendingAction): Promise<void> {
    await this.db
      .insertInto('pending_actions')
      .values({
        id: action.id,
        conversation_id: action.conversationId,
        type: action.type,
        order_id: action.orderId,
        reason: action.reason,
        order_summary: action.orderSummary,
        status: action.status,
        awaiting_text_reply: action.awaitingTextReply,
        created_at: action.createdAt,
        expires_at: action.expiresAt,
        updated_at: action.createdAt,
      })
      .execute();
  }

  async updatePendingAction(
    id: string,
    patch: { status?: PendingActionStatus; expiresAt?: Date; awaitingTextReply?: boolean },
  ): Promise<void> {
    await this.db
      .updateTable('pending_actions')
      .set({
        updated_at: new Date(),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.expiresAt === undefined ? {} : { expires_at: patch.expiresAt }),
        ...(patch.awaitingTextReply === undefined
          ? {}
          : { awaiting_text_reply: patch.awaitingTextReply }),
      })
      .where('id', '=', id)
      .execute();
  }

  async transitionPendingAction(
    id: string,
    from: readonly PendingActionStatus[],
    to: PendingActionStatus,
  ): Promise<boolean> {
    // Compare-and-set em uma única instrução: só uma instância consegue a transição.
    const row = await this.db
      .updateTable('pending_actions')
      .set({ status: to, updated_at: new Date() })
      .where('id', '=', id)
      .where('status', 'in', [...from])
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async createHandoff(
    ticket: Omit<HandoffTicket, 'protocol' | 'createdAt'>,
  ): Promise<HandoffTicket> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const protocol = `ATD-${String(randomInt(100_000, 999_999))}`;
      try {
        const row = await this.db
          .insertInto('handoffs')
          .values({
            protocol,
            conversation_id: ticket.conversationId,
            reason: ticket.reason,
            summary: ticket.summary,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          protocol: row.protocol,
          conversationId: row.conversation_id,
          reason: row.reason,
          summary: row.summary,
          createdAt: row.created_at,
        };
      } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
        const existing = await this.findHandoff(ticket.conversationId);
        if (existing) return existing; // a conversa já tinha sido encaminhada
      }
    }
    throw new Error('Não foi possível gerar um protocolo de atendimento único');
  }

  async findHandoff(conversationId: string): Promise<HandoffTicket | null> {
    const row = await this.db
      .selectFrom('handoffs')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .executeTakeFirst();
    return row
      ? {
          protocol: row.protocol,
          conversationId: row.conversation_id,
          reason: row.reason,
          summary: row.summary,
          createdAt: row.created_at,
        }
      : null;
  }

  async claimMessage(messageKey: string): Promise<MessageClaim> {
    // Insere a reserva; se já existir sem resposta há muito tempo (processo caiu), retoma.
    const claimed = await this.db
      .insertInto('processed_messages')
      .values({ message_id: messageKey, conversation_id: null, reply: null })
      .onConflict((oc) =>
        oc
          .column('message_id')
          .doUpdateSet({ claimed_at: sql<Date>`now()` })
          .where('processed_messages.reply', 'is', null)
          .where('processed_messages.claimed_at', '<', sql<Date>`now() - ${STALE_CLAIM}::interval`),
      )
      .returning('message_id')
      .executeTakeFirst();
    if (claimed) return { status: 'claimed' };

    const existing = await this.db
      .selectFrom('processed_messages')
      .select('reply')
      .where('message_id', '=', messageKey)
      .executeTakeFirst();
    return { status: 'duplicate', reply: existing?.reply ?? null };
  }

  async completeTurn(turn: CompletedTurn): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (turn.messages.length > 0) {
        await trx
          .insertInto('conversation_messages')
          .values(
            turn.messages.map((entry) => ({
              conversation_id: turn.conversationId,
              kind: entry.kind,
              payload: JSON.stringify(entry.message),
              display_text: entry.displayText,
            })),
          )
          .execute();
      }
      await trx
        .updateTable('conversations')
        .set({ last_activity_at: turn.at })
        .where('id', '=', turn.conversationId)
        .execute();
      await trx
        .insertInto('turn_traces')
        .values({
          conversation_id: turn.conversationId,
          correlation_id: turn.trace.correlationId,
          trace: JSON.stringify(turn.trace),
        })
        .execute();
      await trx
        .updateTable('processed_messages')
        .set({ conversation_id: turn.conversationId, reply: JSON.stringify(turn.reply) })
        .where('message_id', '=', turn.messageKey)
        .execute();
    });
  }

  async listTraces(conversationId: string, limit: number): Promise<TurnTrace[]> {
    const rows = await this.db
      .selectFrom('turn_traces')
      .select('trace')
      .where('conversation_id', '=', conversationId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.trace).reverse();
  }
}
