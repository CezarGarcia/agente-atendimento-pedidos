import Anthropic from '@anthropic-ai/sdk';

import { isSupportedModel, type SupportedModel } from './models.js';

/**
 * Porta para o modelo de IA. O orquestrador depende só desta interface: nos testes, um modelo
 * roteirizado substitui o real e torna os cenários (inclusive os de falha) determinísticos.
 */

export interface LlmRequest {
  readonly system: string;
  readonly tools: readonly Anthropic.Tool[];
  readonly messages: readonly Anthropic.MessageParam[];
  /** Identificador opaco (pseudônimo) da conversa, enviado como metadata.user_id. */
  readonly conversationRef: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LlmResponse {
  readonly content: readonly Anthropic.ContentBlock[];
  readonly stopReason: Anthropic.StopReason | null;
  readonly usage: LlmUsage;
  readonly model: string;
  readonly latencyMs: number;
}

export type LlmFailureReason =
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'connection'
  | 'authentication'
  | 'bad_request'
  | 'unknown';

export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';
  constructor(
    readonly reason: LlmFailureReason,
    readonly status?: number,
  ) {
    super(`Modelo indisponível: ${reason}`);
  }
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Preço por milhão de tokens (USD), para estimar o custo de cada turno nos logs e no trace. */
const PRICING: Readonly<Record<SupportedModel, { input: number; output: number }>> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

export function estimateCostUsd(model: string, usage: LlmUsage): number {
  if (!isSupportedModel(model)) return 0;
  const price = PRICING[model];
  const inputCost =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.input * 1.25 +
    usage.cacheReadTokens * price.input * 0.1;
  return (inputCost + usage.outputTokens * price.output) / 1_000_000;
}

export interface AnthropicLlmClientOptions {
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(private readonly options: AnthropicLlmClientOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.timeoutMs,
      // O SDK já repete 408/409/429/5xx e falhas de conexão com backoff.
      maxRetries: options.maxRetries,
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        // Prefixo estável (ferramentas + instruções) em cache entre conversas…
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        tools: [...request.tools],
        messages: [...request.messages],
        // …e o histórico da conversa em cache entre as chamadas do mesmo turno e entre turnos.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: this.options.effort },
        metadata: { user_id: request.conversationRef },
      });
      return {
        content: response.content,
        stopReason: response.stop_reason,
        model: response.model,
        latencyMs: Date.now() - startedAt,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw toLlmError(error);
    }
  }
}

function toLlmError(error: unknown): LlmUnavailableError {
  if (error instanceof Anthropic.RateLimitError)
    return new LlmUnavailableError('rate_limited', 429);
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmUnavailableError('authentication', 401);
  }
  if (error instanceof Anthropic.BadRequestError)
    return new LlmUnavailableError('bad_request', 400);
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new LlmUnavailableError('timeout');
  if (error instanceof Anthropic.APIConnectionError) return new LlmUnavailableError('connection');
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new LlmUnavailableError(status === 529 ? 'overloaded' : 'unknown', status);
  }
  return new LlmUnavailableError('unknown');
}
