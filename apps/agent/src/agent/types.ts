import type Anthropic from '@anthropic-ai/sdk';

import type { PiiKind } from '@agente/shared';

import type { InjectionSignal } from '../guardrails/injection-signals.js';

// ---------- Canal de mensagens ----------

export interface IncomingMessage {
  /** Id único da mensagem na plataforma (webhooks podem ser reentregues). */
  readonly messageId: string;
  /** Telefone verificado pela plataforma de mensagens (E.164). É a identidade do cliente. */
  readonly from: string;
  readonly text?: string;
  /** Resposta rápida (botão) escolhida pelo cliente. */
  readonly button?: { readonly payload: string; readonly title: string };
}

export interface QuickReply {
  readonly payload: string;
  readonly title: string;
}

export interface OutgoingMessage {
  readonly text: string;
  readonly quickReplies?: readonly QuickReply[];
}

export interface AgentReply {
  readonly conversationId: string;
  readonly correlationId: string;
  readonly messages: readonly OutgoingMessage[];
}

// ---------- Estado da conversa ----------

export type IdentityStatus = 'verified' | 'unknown_customer' | 'lookup_failed';

export interface Conversation {
  readonly id: string;
  /** HMAC do telefone: o banco do agente nunca guarda o número em claro. */
  readonly phoneRef: string;
  readonly customerId: string | null;
  readonly customerFirstName: string | null;
  readonly identityStatus: IdentityStatus;
  readonly status: 'active' | 'handed_off' | 'closed';
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
}

/** Mensagem no formato da API do modelo. Guardada sem edição (histórico só cresce). */
export type LlmMessage = Anthropic.MessageParam;

export type MessageKind = 'customer' | 'agent' | 'tool' | 'system_note';

export interface StoredMessage {
  readonly message: LlmMessage;
  readonly kind: MessageKind;
  /** Texto exibido no simulador/transcrição (já sem dados pessoais). */
  readonly displayText: string | null;
}

export type PendingActionStatus =
  | 'awaiting_confirmation'
  /** O cancelamento foi tentado e o resultado é desconhecido (erro técnico). Pode ser repetido. */
  | 'outcome_unknown'
  | 'completed'
  | 'rejected'
  | 'declined'
  | 'superseded'
  | 'expired';

export interface PendingAction {
  /** Também é a Idempotency-Key enviada à API: repetir a execução nunca cancela duas vezes. */
  readonly id: string;
  readonly conversationId: string;
  readonly type: 'cancel_order';
  readonly orderId: string;
  readonly reason: string | null;
  /** Resumo do pedido mostrado na confirmação (ex.: "Mochila e mais 1 item, R$ 829,80"). */
  readonly orderSummary: string;
  readonly status: PendingActionStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface HandoffTicket {
  readonly protocol: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly summary: string;
  readonly createdAt: Date;
}

// ---------- Rastreamento de cada turno (simulador e logs) ----------

export interface LlmCallTrace {
  readonly iteration: number;
  readonly model: string;
  readonly stopReason: string | null;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export interface ToolCallTrace {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface TurnTrace {
  readonly correlationId: string;
  readonly conversationId: string;
  readonly startedAt: string;
  durationMs: number;
  promptVersion: string;
  /** Caminho de decisão do turno: modelo, confirmação determinística ou resposta fixa. */
  path: 'llm' | 'confirmation' | 'deterministic';
  inputGuard: {
    piiDetected: readonly PiiKind[];
    injectionSignals: readonly InjectionSignal[];
    truncated: boolean;
  };
  confirmation?: { decision: string; orderId: string; outcome?: string };
  llmCalls: LlmCallTrace[];
  toolCalls: ToolCallTrace[];
  outputGuard?: { action: 'pass' | 'modified' | 'blocked'; reasons: readonly string[] };
  /** De onde veio o texto final: 'llm' ou 'template:<nome>'. */
  responseSource: string;
}
