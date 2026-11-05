import { Writable } from 'node:stream';

import type Anthropic from '@anthropic-ai/sdk';

import { createLogger, type Logger } from '@agente/shared';

import {
  LlmUnavailableError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '../agent/llm.js';
import type {
  CatalogClient,
  CatalogLookup,
  CatalogProduct,
} from '../integrations/fakestore/fakestore-client.js';
import type {
  ApiOrder,
  CancellationResult,
  CustomerLookupResult,
  OrderListResult,
  OrderLookupResult,
  OrdersApi,
  TechnicalError,
} from '../integrations/orders-api/orders-api-client.js';

/*
 * Dublês de teste determinísticos para o modelo de IA, a API de pedidos e o catálogo externo.
 * Permitem reproduzir comportamentos difíceis de obter com os serviços reais: o modelo errando,
 * a API caindo no meio de um cancelamento, o catálogo devolvendo conteúdo malicioso.
 */

// ---------- Modelo roteirizado ----------

type Step = (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;

let toolUseCounter = 0;

const response = (
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
): LlmResponse => ({
  content,
  stopReason,
  model: 'claude-haiku-5-5',
  latencyMs: 5,
  usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

export const llm = {
  reply:
    (text: string): Step =>
    () =>
      response([{ type: 'text', text, citations: null }], 'end_turn'),
  callTool:
    (name: string, input: Record<string, unknown>, preamble?: string): Step =>
    () => {
      toolUseCounter += 1;
      const blocks: Anthropic.ContentBlock[] = [];
      if (preamble) blocks.push({ type: 'text', text: preamble, citations: null });
      blocks.push({
        type: 'tool_use',
        id: `toolu_${toolUseCounter}`,
        name,
        input,
        caller: { type: 'direct' },
      });
      return response(blocks, 'tool_use');
    },
  stop:
    (stopReason: Anthropic.StopReason): Step =>
    () =>
      response([], stopReason),
  fail:
    (reason: ConstructorParameters<typeof LlmUnavailableError>[0] = 'overloaded'): Step =>
    () => {
      throw new LlmUnavailableError(reason);
    },
};

export class ScriptedLlm implements LlmClient {
  readonly model = 'claude-haiku-5-5';
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[] = [];

  script(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedLlm: roteiro esgotado (chamada inesperada ao modelo)');
    return step(request);
  }

  /** Conteúdo (JSON) dos tool_result enviados ao modelo na última requisição. */
  lastToolResults(): Record<string, unknown>[] {
    const last = this.requests.at(-1);
    const results: Record<string, unknown>[] = [];
    for (const message of last?.messages ?? []) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          results.push(JSON.parse(block.content) as Record<string, unknown>);
        }
      }
    }
    return results;
  }
}

// ---------- API de pedidos em memória ----------

interface FakeOrder extends ApiOrder {
  customerId: string;
}

const money = (amountCents: number) => ({
  amountCents,
  formatted: `R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}`,
});

const BLOCK_REASON: Record<string, string> = {
  AWAITING_PAYMENT: 'PAYMENT_PENDING',
  SHIPPED: 'ALREADY_SHIPPED',
  DELIVERED: 'ALREADY_DELIVERED',
  CANCELLED: 'ALREADY_CANCELLED',
};

function makeOrder(
  id: string,
  customerId: string,
  status: string,
  items: { productId: number; quantity: number; cents: number }[],
  trackingCode: string | null = null,
): FakeOrder {
  const total = items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
  return {
    id,
    customerId,
    status,
    placedAt: '2026-11-04T13:00:00.000Z',
    updatedAt: '2026-11-04T13:00:00.000Z',
    items: items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: money(item.cents),
      subtotal: money(item.cents * item.quantity),
    })),
    total: money(total),
    shipping: {
      trackingCode,
      estimatedDeliveryDate: status === 'PROCESSING' ? '2026-11-12' : null,
      shippedAt: status === 'SHIPPED' ? '2026-11-03T10:00:00.000Z' : null,
      deliveredAt: null,
    },
    cancellation: {
      eligible: status === 'PROCESSING',
      blockedReason: BLOCK_REASON[status] ?? null,
      cancelledAt: status === 'CANCELLED' ? '2026-11-02T10:00:00.000Z' : null,
    },
  };
}

export const PHONES = {
  ana: '+5551990000001',
  bruno: '+5551990000002',
  unknown: '+5511988887777',
} as const;

export const CUSTOMERS = { ana: 'cust-ana', bruno: 'cust-bruno' } as const;

export type FakeOperation = 'customer' | 'get' | 'list' | 'cancel';

export class FakeOrdersApi implements OrdersApi {
  readonly orders = new Map<string, FakeOrder>([
    [
      '100101',
      makeOrder('100101', CUSTOMERS.ana, 'PROCESSING', [
        { productId: 1, quantity: 1, cents: 54990 },
        { productId: 3, quantity: 1, cents: 27990 },
      ]),
    ],
    [
      '100102',
      makeOrder(
        '100102',
        CUSTOMERS.ana,
        'SHIPPED',
        [{ productId: 9, quantity: 1, cents: 31990 }],
        'QB123456785BR',
      ),
    ],
    [
      '100202',
      makeOrder('100202', CUSTOMERS.ana, 'CANCELLED', [
        { productId: 5, quantity: 1, cents: 347500 },
      ]),
    ],
    [
      '100201',
      makeOrder('100201', CUSTOMERS.bruno, 'PROCESSING', [
        { productId: 14, quantity: 1, cents: 499990 },
      ]),
    ],
  ]);
  readonly cancelCalls: { orderId: string; idempotencyKey: string; reason: string | null }[] = [];
  readonly failing = new Set<FakeOperation>();
  readonly receivedPhones: string[] = [];
  private readonly idempotency = new Map<string, CancellationResult>();

  setStatus(orderId: string, status: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    this.orders.set(orderId, {
      ...order,
      status,
      cancellation: {
        eligible: status === 'PROCESSING',
        blockedReason: BLOCK_REASON[status] ?? null,
        cancelledAt: status === 'CANCELLED' ? new Date().toISOString() : null,
      },
    });
  }

  private down(operation: FakeOperation): TechnicalError | null {
    return this.failing.has(operation) ? { kind: 'technical_error', reason: 'unavailable' } : null;
  }

  findCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
    this.receivedPhones.push(phone);
    const failure = this.down('customer');
    if (failure) return Promise.resolve(failure);
    if (phone === PHONES.ana)
      return Promise.resolve({ kind: 'found', customerId: CUSTOMERS.ana, firstName: 'Ana' });
    if (phone === PHONES.bruno)
      return Promise.resolve({ kind: 'found', customerId: CUSTOMERS.bruno, firstName: 'Bruno' });
    return Promise.resolve({ kind: 'not_found' });
  }

  getOrder(customerId: string, orderId: string): Promise<OrderLookupResult> {
    const failure = this.down('get');
    if (failure) return Promise.resolve(failure);
    const order = this.orders.get(orderId);
    return Promise.resolve(
      order?.customerId === customerId ? { kind: 'found', order } : { kind: 'not_found' },
    );
  }

  listOrders(customerId: string): Promise<OrderListResult> {
    const failure = this.down('list');
    if (failure) return Promise.resolve(failure);
    const orders = [...this.orders.values()]
      .filter((order) => order.customerId === customerId)
      .map((order) => ({
        id: order.id,
        status: order.status,
        placedAt: order.placedAt,
        total: order.total,
        itemCount: order.items.length,
      }));
    return Promise.resolve({ kind: 'found', orders });
  }

  requestCancellation(
    customerId: string,
    orderId: string,
    input: { idempotencyKey: string; reason: string | null },
  ): Promise<CancellationResult> {
    this.cancelCalls.push({ orderId, ...input });
    const failure = this.down('cancel');
    if (failure) return Promise.resolve(failure);
    const replay = this.idempotency.get(input.idempotencyKey);
    if (replay) return Promise.resolve(replay);

    const order = this.orders.get(orderId);
    let result: CancellationResult;
    if (order?.customerId !== customerId) {
      result = { kind: 'not_found' };
    } else if (order.status !== 'PROCESSING') {
      result = {
        kind: 'not_cancellable',
        currentStatus: order.status,
        reason: BLOCK_REASON[order.status] ?? 'UNKNOWN_STATUS',
      };
    } else {
      this.setStatus(orderId, 'CANCELLED');
      result = { kind: 'cancelled', order: this.orders.get(orderId) ?? order };
    }
    this.idempotency.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  /** Simula: a API cancelou, mas a resposta se perdeu (timeout). */
  cancelThenLoseResponse(): void {
    const original = this.requestCancellation.bind(this);
    this.requestCancellation = async (customerId, orderId, input) => {
      await original(customerId, orderId, input);
      this.requestCancellation = original;
      return { kind: 'technical_error', reason: 'timeout' };
    };
  }
}

// ---------- Catálogo externo ----------

export const PRODUCTS: Record<number, CatalogProduct> = {
  1: {
    id: 1,
    title: 'Fjallraven - Foldsack No. 1 Backpack',
    category: "men's clothing",
    description: 'Your perfect pack for everyday use.',
    imageUrl: null,
  },
  3: {
    id: 3,
    title: 'Mens Cotton Jacket',
    category: "men's clothing",
    description: 'Great outerwear jackets.',
    imageUrl: null,
  },
  5: {
    id: 5,
    title: "John Hardy Women's Legends Naga",
    category: 'jewelery',
    description: 'Bracelet.',
    imageUrl: null,
  },
  9: {
    id: 9,
    title: 'WD 2TB Elements Portable External Hard Drive',
    category: 'electronics',
    description: 'USB 3.0.',
    imageUrl: null,
  },
  14: {
    id: 14,
    title: 'Samsung 49-Inch CHG90 Curved Gaming Monitor',
    category: 'electronics',
    description: 'Monitor.',
    imageUrl: null,
  },
};

export class FakeCatalog implements CatalogClient {
  available = true;
  readonly products = new Map<number, CatalogProduct>(
    Object.entries(PRODUCTS).map(([id, p]) => [Number(id), p]),
  );

  getProduct(productId: number): Promise<CatalogLookup> {
    if (!this.available) return Promise.resolve({ status: 'unavailable', reason: 'timeout' });
    const product = this.products.get(productId);
    return Promise.resolve(
      product ? { status: 'found', product, stale: false } : { status: 'not_found' },
    );
  }

  async getProducts(productIds: readonly number[]): Promise<ReadonlyMap<number, CatalogLookup>> {
    const entries = await Promise.all(
      productIds.map(async (id) => [id, await this.getProduct(id)] as const),
    );
    return new Map(entries);
  }
}

// ---------- Logs capturados ----------

export function captureLogs(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ service: 'agent', destination, level: 'debug' }), lines };
}
