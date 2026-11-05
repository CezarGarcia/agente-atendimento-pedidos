import { randomInt } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import type {
  AgentReply,
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
import type { ConversationStore } from './store.js';

type ConversationRow = Selectable<AgentDatabase['conversations']>;
type PendingRow = Selectable<AgentDatabase['pending_actions']>;

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  phoneRef: row.phone_ref,
  customerId: row.customer_id,
  customerFirstName: row.customer_first_name,
  identityStatus: row.identity_status as IdentityStatus,
  status: row.status as Conversation['status'],
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
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
});

const UNIQUE_VIOLATION = '23505';

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

  async touchConversation(id: string, at: Date): Promise<void> {
    await this.db
      .updateTable('conversations')
      .set({ last_activity_at: at })
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

  async appendMessages(conversationId: string, messages: readonly StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Uma única instrução: o turno entra inteiro (ou nada), preservando a alternância de papéis.
    await this.db
      .insertInto('conversation_messages')
      .values(
        messages.map((entry) => ({
          conversation_id: conversationId,
          kind: entry.kind,
          payload: JSON.stringify(entry.message),
          display_text: entry.displayText,
        })),
      )
      .execute();
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
        created_at: action.createdAt,
        expires_at: action.expiresAt,
        updated_at: action.createdAt,
      })
      .execute();
  }

  async updatePendingAction(
    id: string,
    status: PendingActionStatus,
    expiresAt?: Date,
  ): Promise<void> {
    await this.db
      .updateTable('pending_actions')
      .set({ status, updated_at: new Date(), ...(expiresAt ? { expires_at: expiresAt } : {}) })
      .where('id', '=', id)
      .execute();
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

  async findProcessedMessage(messageId: string): Promise<AgentReply | null> {
    const row = await this.db
      .selectFrom('processed_messages')
      .select('reply')
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    return row?.reply ?? null;
  }

  async saveProcessedMessage(messageId: string, reply: AgentReply): Promise<void> {
    await this.db
      .insertInto('processed_messages')
      .values({
        message_id: messageId,
        conversation_id: reply.conversationId,
        reply: JSON.stringify(reply),
      })
      .onConflict((oc) => oc.column('message_id').doNothing())
      .execute();
  }

  async saveTrace(trace: TurnTrace): Promise<void> {
    await this.db
      .insertInto('turn_traces')
      .values({
        conversation_id: trace.conversationId,
        correlation_id: trace.correlationId,
        trace: JSON.stringify(trace),
      })
      .execute();
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
