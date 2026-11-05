/** Tipos espelhados da API do simulador (serviço do agente). */

export interface Persona {
  id: string;
  name: string;
  phone: string;
  description: string;
  suggestions: string[];
}

export interface ChaosFlags {
  ordersApiDown: boolean;
  catalogDown: boolean;
  llmDown: boolean;
}

export interface SimulatorState {
  personas: Persona[];
  chaos: ChaosFlags;
  model: string;
  promptVersion: string;
  llmConfigured: boolean;
}

export interface QuickReply {
  payload: string;
  title: string;
}

export interface OutgoingMessage {
  text: string;
  quickReplies?: QuickReply[];
}

export interface AgentReply {
  conversationId: string;
  correlationId: string;
  messages: OutgoingMessage[];
}

export interface TurnTrace {
  correlationId: string;
  conversationId: string;
  startedAt: string;
  durationMs: number;
  promptVersion: string;
  path: 'llm' | 'confirmation' | 'deterministic';
  inputGuard: { piiDetected: string[]; injectionSignals: string[]; truncated: boolean };
  confirmation?: { decision: string; orderId: string; outcome?: string };
  llmCalls: {
    iteration: number;
    model: string;
    stopReason: string | null;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  }[];
  toolCalls: {
    name: string;
    input: Record<string, unknown>;
    outcome: string;
    durationMs: number;
  }[];
  outputGuard?: { action: 'pass' | 'modified' | 'blocked'; reasons: string[] };
  responseSource: string;
}

export interface ChatEntry {
  id: string;
  author: 'customer' | 'agent';
  text: string;
  quickReplies?: QuickReply[];
  at: Date;
  /** Índice do trace do turno que gerou esta mensagem (para o painel de bastidores). */
  traceIndex?: number;
}
