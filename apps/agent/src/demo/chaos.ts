import {
  LlmUnavailableError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '../agent/llm.js';
import type { CatalogClient, CatalogLookup } from '../integrations/fakestore/fakestore-client.js';
import type {
  CancellationResult,
  CustomerLookupResult,
  OrderListResult,
  OrderLookupResult,
  OrdersApi,
} from '../integrations/orders-api/orders-api-client.js';

/**
 * Injeção de falhas para demonstração (somente com DEMO_MODE). Permite mostrar ao vivo, pelo
 * simulador, como o agente se comporta com a API de pedidos, o catálogo ou o modelo fora do ar.
 */
export class ChaosState {
  ordersApiDown = false;
  catalogDown = false;
  llmDown = false;

  snapshot() {
    return {
      ordersApiDown: this.ordersApiDown,
      catalogDown: this.catalogDown,
      llmDown: this.llmDown,
    };
  }
}

const unavailable = { kind: 'technical_error', reason: 'unavailable' } as const;

export class ChaosOrdersApi implements OrdersApi {
  constructor(
    private readonly inner: OrdersApi,
    private readonly state: ChaosState,
  ) {}

  findCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
    return this.state.ordersApiDown
      ? Promise.resolve(unavailable)
      : this.inner.findCustomerByPhone(phone);
  }

  getOrder(customerId: string, orderId: string): Promise<OrderLookupResult> {
    return this.state.ordersApiDown
      ? Promise.resolve(unavailable)
      : this.inner.getOrder(customerId, orderId);
  }

  listOrders(customerId: string, limit: number): Promise<OrderListResult> {
    return this.state.ordersApiDown
      ? Promise.resolve(unavailable)
      : this.inner.listOrders(customerId, limit);
  }

  requestCancellation(
    customerId: string,
    orderId: string,
    input: { idempotencyKey: string; reason: string | null },
  ): Promise<CancellationResult> {
    return this.state.ordersApiDown
      ? Promise.resolve(unavailable)
      : this.inner.requestCancellation(customerId, orderId, input);
  }
}

export class ChaosCatalog implements CatalogClient {
  constructor(
    private readonly inner: CatalogClient,
    private readonly state: ChaosState,
  ) {}

  getProduct(productId: number): Promise<CatalogLookup> {
    return this.state.catalogDown
      ? Promise.resolve({ status: 'unavailable', reason: 'network_error' })
      : this.inner.getProduct(productId);
  }

  async getProducts(productIds: readonly number[]): Promise<ReadonlyMap<number, CatalogLookup>> {
    if (!this.state.catalogDown) return this.inner.getProducts(productIds);
    return new Map(
      productIds.map((id) => [id, { status: 'unavailable', reason: 'network_error' } as const]),
    );
  }
}

export class ChaosLlm implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly state: ChaosState,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.state.llmDown) return Promise.reject(new LlmUnavailableError('overloaded', 529));
    return this.inner.complete(request);
  }
}

/** Usado quando não há ANTHROPIC_API_KEY: o agente responde com a mensagem de indisponibilidade. */
export class UnconfiguredLlm implements LlmClient {
  constructor(readonly model: string) {}

  complete(): Promise<LlmResponse> {
    return Promise.reject(new LlmUnavailableError('authentication'));
  }
}
