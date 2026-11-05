import { z } from 'zod';

import { CORRELATION_HEADER, getCorrelationId, type Logger } from '@agente/shared';

import { backoffDelayMs, sleep } from '../../resilience/retry.js';

/**
 * Cliente da API principal de pedidos. Converte respostas HTTP em resultados de negócio
 * explícitos: o agente nunca precisa interpretar status HTTP, e um erro técnico jamais pode ser
 * confundido com sucesso (regras 5 e 6).
 */

const MoneySchema = z.object({ amountCents: z.number().int(), formatted: z.string() });
const StatusSchema = z.string(); // leitor tolerante: status novo não quebra o agente

const OrderSchema = z.object({
  id: z.string(),
  status: StatusSchema,
  placedAt: z.string(),
  updatedAt: z.string(),
  items: z.array(
    z.object({
      productId: z.number().int(),
      quantity: z.number().int(),
      unitPrice: MoneySchema,
      subtotal: MoneySchema,
    }),
  ),
  total: MoneySchema,
  shipping: z.object({
    trackingCode: z.string().nullable(),
    estimatedDeliveryDate: z.string().nullable(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
  }),
  cancellation: z.object({
    eligible: z.boolean(),
    blockedReason: z.string().nullable(),
    cancelledAt: z.string().nullable(),
  }),
});

const OrderSummarySchema = z.object({
  id: z.string(),
  status: StatusSchema,
  placedAt: z.string(),
  total: MoneySchema,
  itemCount: z.number().int(),
});

const ProblemSchema = z.object({
  code: z.string(),
  currentStatus: z.string().optional(),
  reason: z.string().optional(),
});

export type ApiOrder = z.infer<typeof OrderSchema>;
export type ApiOrderSummary = z.infer<typeof OrderSummarySchema>;

export type TechnicalErrorReason =
  'timeout' | 'network_error' | 'unavailable' | 'unexpected_response' | 'unauthorized';

export interface TechnicalError {
  readonly kind: 'technical_error';
  readonly reason: TechnicalErrorReason;
}

export type CustomerLookupResult =
  | { readonly kind: 'found'; readonly customerId: string; readonly firstName: string }
  | { readonly kind: 'not_found' }
  | TechnicalError;

export type OrderLookupResult =
  | { readonly kind: 'found'; readonly order: ApiOrder }
  | { readonly kind: 'not_found' }
  | TechnicalError;

export type OrderListResult =
  { readonly kind: 'found'; readonly orders: readonly ApiOrderSummary[] } | TechnicalError;

export type CancellationResult =
  | { readonly kind: 'cancelled'; readonly order: ApiOrder }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_cancellable'; readonly currentStatus: string; readonly reason: string }
  | TechnicalError;

export interface OrdersApi {
  findCustomerByPhone(phone: string): Promise<CustomerLookupResult>;
  getOrder(customerId: string, orderId: string): Promise<OrderLookupResult>;
  listOrders(customerId: string, limit: number): Promise<OrderListResult>;
  /** A chave de idempotência torna seguro repetir a chamada após timeout ou falha de rede. */
  requestCancellation(
    customerId: string,
    orderId: string,
    input: { idempotencyKey: string; reason: string | null },
  ): Promise<CancellationResult>;
}

export interface OrdersApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchFn?: typeof fetch;
  readonly random?: () => number;
}

type HttpOutcome =
  { readonly kind: 'response'; readonly status: number; readonly body: unknown } | TechnicalError;

export class OrdersApiClient implements OrdersApi {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OrdersApiClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async findCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
    const response = await this.request('POST', '/v1/customers/lookup', 'customer.lookup', {
      body: { phone },
    });
    if (response.kind === 'technical_error') return response;
    if (response.status === 404) return { kind: 'not_found' };
    const parsed = z
      .object({ customerId: z.string(), firstName: z.string() })
      .safeParse(response.body);
    return response.status === 200 && parsed.success
      ? { kind: 'found', ...parsed.data }
      : this.unexpected('customer.lookup', response.status);
  }

  async getOrder(customerId: string, orderId: string): Promise<OrderLookupResult> {
    const response = await this.request(
      'GET',
      `/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}`,
      'order.get',
    );
    if (response.kind === 'technical_error') return response;
    if (response.status === 404) return { kind: 'not_found' };
    const parsed = OrderSchema.safeParse(response.body);
    return response.status === 200 && parsed.success
      ? { kind: 'found', order: parsed.data }
      : this.unexpected('order.get', response.status);
  }

  async listOrders(customerId: string, limit: number): Promise<OrderListResult> {
    const response = await this.request(
      'GET',
      `/v1/customers/${encodeURIComponent(customerId)}/orders?limit=${limit}`,
      'order.list',
    );
    if (response.kind === 'technical_error') return response;
    const parsed = z.object({ orders: z.array(OrderSummarySchema) }).safeParse(response.body);
    return response.status === 200 && parsed.success
      ? { kind: 'found', orders: parsed.data.orders }
      : this.unexpected('order.list', response.status);
  }

  async requestCancellation(
    customerId: string,
    orderId: string,
    input: { idempotencyKey: string; reason: string | null },
  ): Promise<CancellationResult> {
    const response = await this.request(
      'POST',
      `/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/cancellation`,
      'order.cancel',
      {
        body: input.reason === null ? {} : { reason: input.reason },
        headers: { 'idempotency-key': input.idempotencyKey },
      },
    );
    if (response.kind === 'technical_error') return response;

    if (response.status === 200) {
      const parsed = z.object({ order: OrderSchema }).safeParse(response.body);
      // Regra 5: só é sucesso se a API disse 200 E o pedido voltou cancelado.
      if (parsed.success && parsed.data.order.status === 'CANCELLED') {
        return { kind: 'cancelled', order: parsed.data.order };
      }
      return this.unexpected('order.cancel', response.status);
    }
    if (response.status === 404) return { kind: 'not_found' };
    if (response.status === 409) {
      const problem = ProblemSchema.safeParse(response.body);
      if (problem.success && problem.data.code === 'ORDER_NOT_CANCELLABLE') {
        return {
          kind: 'not_cancellable',
          currentStatus: problem.data.currentStatus ?? 'UNKNOWN',
          reason: problem.data.reason ?? 'UNKNOWN',
        };
      }
    }
    return this.unexpected('order.cancel', response.status);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpOutcome> {
    const maxRetries = this.options.maxRetries ?? 1;
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attempt(method, path, init);
      // Repetir é seguro: GETs são idempotentes e o POST de cancelamento usa Idempotency-Key.
      const retryable = outcome.kind === 'technical_error' && outcome.reason !== 'unauthorized';
      if (retryable && attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt, { baseMs: 150, maxMs: 1_000 }, this.options.random));
        continue;
      }

      this.options.logger.info(
        {
          event: 'external.orders_api.request',
          operation,
          method,
          status: outcome.kind === 'response' ? outcome.status : undefined,
          outcome: outcome.kind === 'response' ? 'response' : outcome.reason,
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
        },
        'chamada à API de pedidos',
      );
      return outcome;
    }
  }

  private async attempt(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpOutcome> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.options.apiKey,
      ...init.headers,
    };
    const correlationId = getCorrelationId();
    if (correlationId) headers[CORRELATION_HEADER] = correlationId;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, this.options.baseUrl), {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 4_000),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      return { kind: 'technical_error', reason: isTimeout ? 'timeout' : 'network_error' };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: 'technical_error', reason: 'unauthorized' };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: 'technical_error', reason: 'unavailable' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'technical_error', reason: 'unexpected_response' };
    }
    return { kind: 'response', status: response.status, body };
  }

  private unexpected(operation: string, status: number): TechnicalError {
    this.options.logger.warn(
      { event: 'external.orders_api.unexpected_response', operation, status },
      'resposta fora do contrato da API de pedidos',
    );
    return { kind: 'technical_error', reason: 'unexpected_response' };
  }
}
