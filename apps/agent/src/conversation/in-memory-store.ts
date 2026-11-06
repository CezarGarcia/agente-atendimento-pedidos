import { randomInt, randomUUID } from 'node:crypto';

import type {
  AgentReply,
  Conversation,
  HandoffTicket,
  PendingAction,
  PendingActionStatus,
  StoredMessage,
  TurnTrace,
} from '../agent/types.js';
import type { CompletedTurn, ConversationStore, MessageClaim } from './store.js';

const OPEN_STATUSES = new Set<PendingActionStatus>(['awaiting_confirmation', 'outcome_unknown']);

/** Implementação em memória do `ConversationStore`, usada nos testes do agente. */
export class InMemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, StoredMessage[]>();
  readonly pendingActions = new Map<string, PendingAction>();
  readonly handoffs = new Map<string, HandoffTicket>();
  readonly processed = new Map<string, AgentReply | null>();
  readonly traces: TurnTrace[] = [];
  /** Permite simular falha na gravação do turno. */
  failNextCompletion = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

  findActiveConversation(phoneRef: string, idleSince: Date): Promise<Conversation | null> {
    const found = [...this.conversations.values()].find(
      (c) => c.phoneRef === phoneRef && c.status !== 'closed' && c.lastActivityAt >= idleSince,
    );
    return Promise.resolve(found ?? null);
  }

  createConversation(
    input: Omit<Conversation, 'id' | 'createdAt' | 'lastActivityAt' | 'status'>,
  ): Promise<Conversation> {
    const now = this.now();
    const conversation: Conversation = {
      ...input,
      id: randomUUID(),
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return Promise.resolve(conversation);
  }

  updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
    const current = this.conversations.get(id);
    if (current) this.conversations.set(id, { ...current, ...patch });
    return Promise.resolve();
  }

  closeConversation(id: string): Promise<void> {
    return this.updateConversation(id, { status: 'closed' });
  }

  loadMessages(conversationId: string): Promise<StoredMessage[]> {
    return Promise.resolve(structuredClone(this.messages.get(conversationId) ?? []));
  }

  findOpenPendingAction(conversationId: string): Promise<PendingAction | null> {
    const found = [...this.pendingActions.values()]
      .filter((a) => a.conversationId === conversationId && OPEN_STATUSES.has(a.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return Promise.resolve(found ?? null);
  }

  listPendingActions(conversationId: string): Promise<PendingAction[]> {
    return Promise.resolve(
      [...this.pendingActions.values()].filter((a) => a.conversationId === conversationId),
    );
  }

  savePendingAction(action: PendingAction): Promise<void> {
    // Mesma garantia do índice único do Postgres: uma ação aberta por conversa.
    const open = [...this.pendingActions.values()].some(
      (other) =>
        other.conversationId === action.conversationId &&
        OPEN_STATUSES.has(other.status) &&
        OPEN_STATUSES.has(action.status),
    );
    if (open) return Promise.reject(new Error('já existe uma ação aberta nesta conversa'));
    this.pendingActions.set(action.id, action);
    return Promise.resolve();
  }

  updatePendingAction(
    id: string,
    patch: { status?: PendingActionStatus; expiresAt?: Date; awaitingTextReply?: boolean },
  ): Promise<void> {
    const current = this.pendingActions.get(id);
    if (current) this.pendingActions.set(id, { ...current, ...patch });
    return Promise.resolve();
  }

  transitionPendingAction(
    id: string,
    from: readonly PendingActionStatus[],
    to: PendingActionStatus,
  ): Promise<boolean> {
    const current = this.pendingActions.get(id);
    if (!current || !from.includes(current.status)) return Promise.resolve(false);
    this.pendingActions.set(id, { ...current, status: to });
    return Promise.resolve(true);
  }

  createHandoff(ticket: Omit<HandoffTicket, 'protocol' | 'createdAt'>): Promise<HandoffTicket> {
    const existing = this.handoffs.get(ticket.conversationId);
    if (existing) return Promise.resolve(existing);
    const created: HandoffTicket = {
      ...ticket,
      protocol: `ATD-${String(randomInt(100_000, 999_999))}`,
      createdAt: this.now(),
    };
    this.handoffs.set(ticket.conversationId, created);
    return Promise.resolve(created);
  }

  findHandoff(conversationId: string): Promise<HandoffTicket | null> {
    return Promise.resolve(this.handoffs.get(conversationId) ?? null);
  }

  claimMessage(messageKey: string): Promise<MessageClaim> {
    if (this.processed.has(messageKey)) {
      return Promise.resolve({
        status: 'duplicate',
        reply: this.processed.get(messageKey) ?? null,
      });
    }
    this.processed.set(messageKey, null);
    return Promise.resolve({ status: 'claimed' });
  }

  releaseMessage(messageKey: string): Promise<void> {
    if (this.processed.get(messageKey) === null) this.processed.delete(messageKey);
    return Promise.resolve();
  }

  completeTurn(turn: CompletedTurn): Promise<void> {
    if (this.failNextCompletion) {
      this.failNextCompletion = false;
      return Promise.reject(new Error('falha simulada ao gravar o turno'));
    }
    this.messages.set(turn.conversationId, [
      ...(this.messages.get(turn.conversationId) ?? []),
      ...structuredClone(turn.messages),
    ]);
    const conversation = this.conversations.get(turn.conversationId);
    if (conversation)
      this.conversations.set(conversation.id, { ...conversation, lastActivityAt: turn.at });
    this.traces.push(turn.trace);
    this.processed.set(turn.messageKey, turn.reply);
    return Promise.resolve();
  }

  listTraces(conversationId: string, limit: number): Promise<TurnTrace[]> {
    return Promise.resolve(
      this.traces.filter((t) => t.conversationId === conversationId).slice(-limit),
    );
  }
}
