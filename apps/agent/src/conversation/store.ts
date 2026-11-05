import type {
  AgentReply,
  Conversation,
  HandoffTicket,
  PendingAction,
  PendingActionStatus,
  StoredMessage,
  TurnTrace,
} from '../agent/types.js';

/**
 * Persistência do estado do agente. O estado que garante as regras (confirmação pendente,
 * identidade do cliente, handoff) vive aqui, no servidor, e não na "memória" do modelo.
 */
export interface ConversationStore {
  findActiveConversation(phoneRef: string, idleSince: Date): Promise<Conversation | null>;
  createConversation(
    input: Omit<Conversation, 'id' | 'createdAt' | 'lastActivityAt' | 'status'>,
  ): Promise<Conversation>;
  updateConversation(
    id: string,
    patch: Partial<
      Pick<Conversation, 'customerId' | 'customerFirstName' | 'identityStatus' | 'status'>
    >,
  ): Promise<void>;
  touchConversation(id: string, at: Date): Promise<void>;
  closeConversation(id: string): Promise<void>;

  /** Histórico completo, na ordem. Mensagens nunca são editadas (apenas acrescentadas). */
  loadMessages(conversationId: string): Promise<StoredMessage[]>;
  appendMessages(conversationId: string, messages: readonly StoredMessage[]): Promise<void>;

  /** Ação pendente ativa: aguardando confirmação ou com resultado desconhecido, não expirada. */
  findOpenPendingAction(conversationId: string): Promise<PendingAction | null>;
  listPendingActions(conversationId: string): Promise<PendingAction[]>;
  savePendingAction(action: PendingAction): Promise<void>;
  updatePendingAction(id: string, status: PendingActionStatus, expiresAt?: Date): Promise<void>;

  createHandoff(ticket: Omit<HandoffTicket, 'protocol' | 'createdAt'>): Promise<HandoffTicket>;
  findHandoff(conversationId: string): Promise<HandoffTicket | null>;

  /** Deduplicação de webhooks: a mesma mensagem recebida duas vezes recebe a mesma resposta. */
  findProcessedMessage(messageId: string): Promise<AgentReply | null>;
  saveProcessedMessage(messageId: string, reply: AgentReply): Promise<void>;

  saveTrace(trace: TurnTrace): Promise<void>;
  listTraces(conversationId: string, limit: number): Promise<TurnTrace[]>;
}
