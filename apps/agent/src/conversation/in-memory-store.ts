import { randomInt, randomUUID } from 'node:crypto';

import type {
  AgentReply,
  Conversation,
  HandoffTicket,
  PendingAction,
  StoredMessage,
  TurnTrace,
} from '../agent/types.js';
import type { ConversationStore } from './store.js';

const OPEN_STATUSES = new Set(['awaiting_confirmation', 'outcome_unknown']);

/** Implementação em memória do `ConversationStore`, usada nos testes do agente. */
export class InMemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, StoredMessage[]>();
  readonly pendingActions = new Map<string, PendingAction>();
  readonly handoffs = new Map<string, HandoffTicket>();
  readonly processed = new Map<string, AgentReply>();
  readonly traces: TurnTrace[] = [];

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

  touchConversation(id: string, at: Date): Promise<void> {
    return this.updateConversation(id, { lastActivityAt: at });
  }

  closeConversation(id: string): Promise<void> {
    return this.updateConversation(id, { status: 'closed' });
  }

  loadMessages(conversationId: string): Promise<StoredMessage[]> {
    return Promise.resolve([...(this.messages.get(conversationId) ?? [])]);
  }

  appendMessages(conversationId: string, messages: readonly StoredMessage[]): Promise<void> {
    this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), ...messages]);
    return Promise.resolve();
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
    this.pendingActions.set(action.id, action);
    return Promise.resolve();
  }

  updatePendingAction(
    id: string,
    status: PendingAction['status'],
    expiresAt?: Date,
  ): Promise<void> {
    const current = this.pendingActions.get(id);
    if (current) {
      this.pendingActions.set(id, {
        ...current,
        status,
        expiresAt: expiresAt ?? current.expiresAt,
      });
    }
    return Promise.resolve();
  }

  createHandoff(ticket: Omit<HandoffTicket, 'protocol' | 'createdAt'>): Promise<HandoffTicket> {
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

  findProcessedMessage(messageId: string): Promise<AgentReply | null> {
    return Promise.resolve(this.processed.get(messageId) ?? null);
  }

  saveProcessedMessage(messageId: string, reply: AgentReply): Promise<void> {
    this.processed.set(messageId, reply);
    return Promise.resolve();
  }

  saveTrace(trace: TurnTrace): Promise<void> {
    this.traces.push(trace);
    return Promise.resolve();
  }

  listTraces(conversationId: string, limit: number): Promise<TurnTrace[]> {
    return Promise.resolve(
      this.traces.filter((t) => t.conversationId === conversationId).slice(-limit),
    );
  }
}
