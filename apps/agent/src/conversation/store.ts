import type {
  AgentReply,
  Conversation,
  HandoffTicket,
  PendingAction,
  PendingActionStatus,
  StoredMessage,
  TurnTrace,
} from '../agent/types.js';

export type MessageClaim =
  | { readonly status: 'claimed' }
  /** Já processada (reply) ou em processamento por outra requisição (reply null). */
  | { readonly status: 'duplicate'; readonly reply: AgentReply | null };

export interface CompletedTurn {
  readonly messageKey: string;
  readonly conversationId: string;
  readonly messages: readonly StoredMessage[];
  readonly at: Date;
  readonly trace: TurnTrace;
  readonly reply: AgentReply;
}

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
  closeConversation(id: string): Promise<void>;

  /** Histórico completo, na ordem. Mensagens nunca são editadas (apenas acrescentadas). */
  loadMessages(conversationId: string): Promise<StoredMessage[]>;

  /** Ação pendente ativa: aguardando confirmação ou com resultado desconhecido, não expirada. */
  findOpenPendingAction(conversationId: string): Promise<PendingAction | null>;
  listPendingActions(conversationId: string): Promise<PendingAction[]>;
  savePendingAction(action: PendingAction): Promise<void>;
  updatePendingAction(
    id: string,
    patch: { status?: PendingActionStatus; expiresAt?: Date; awaitingTextReply?: boolean },
  ): Promise<void>;
  /**
   * Transição atômica (compare-and-set): só muda se o status atual estiver em `from`.
   * Garante que, mesmo com várias instâncias, uma ação é executada ou recusada uma única vez.
   */
  transitionPendingAction(
    id: string,
    from: readonly PendingActionStatus[],
    to: PendingActionStatus,
  ): Promise<boolean>;

  createHandoff(ticket: Omit<HandoffTicket, 'protocol' | 'createdAt'>): Promise<HandoffTicket>;
  findHandoff(conversationId: string): Promise<HandoffTicket | null>;

  /**
   * Deduplicação de webhooks: reserva a mensagem no início do processamento. A mesma mensagem
   * recebida de novo recebe a mesma resposta (ou nada, se ainda estiver em processamento).
   */
  claimMessage(messageKey: string): Promise<MessageClaim>;
  /** Desfaz a reserva de uma mensagem sem resposta (o turno falhou): a reentrega será processada. */
  releaseMessage(messageKey: string): Promise<void>;
  /** Grava o turno de forma atômica: histórico, atividade, trace e resposta da mensagem. */
  completeTurn(turn: CompletedTurn): Promise<void>;

  listTraces(conversationId: string, limit: number): Promise<TurnTrace[]>;
}
