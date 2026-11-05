import type { CancellationBlockReason, Customer, Order, OrderStatus } from '../domain/order.js';

/**
 * Portas da camada de aplicação. A implementação concreta (Postgres) fica em `infra/`;
 * os casos de uso dependem só destes contratos.
 */

export interface CustomersRepository {
  findByPhone(phone: string): Promise<Customer | null>;
}

export interface OrdersReadRepository {
  /** Busca escopada pelo cliente: um pedido de outro cliente é indistinguível de inexistente. */
  findForCustomer(customerId: string, orderId: string): Promise<Order | null>;
  listForCustomer(customerId: string, limit: number): Promise<Order[]>;
}

export interface StatusHistoryEntry {
  readonly orderId: string;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  /** Cliente da API que executou a ação (ex.: agent-service), para a trilha de auditoria. */
  readonly actor: string;
  readonly reason: string | null;
  readonly correlationId: string | null;
}

/** Resultado de negócio de uma solicitação de cancelamento (o que fica gravado para replays). */
export type CancellationOutcome =
  | { readonly kind: 'cancelled'; readonly order: Order }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'not_cancellable';
      readonly order: Order;
      readonly reason: CancellationBlockReason;
    };

export type IdempotencyClaim =
  | { readonly status: 'acquired' }
  | { readonly status: 'replay'; readonly outcome: CancellationOutcome }
  | { readonly status: 'mismatch' };

export interface TransactionScope {
  readonly orders: {
    /** Lê o pedido com bloqueio de linha (SELECT … FOR UPDATE) até o fim da transação. */
    findForUpdate(customerId: string, orderId: string): Promise<Order | null>;
    saveCancellation(order: Order): Promise<void>;
  };
  readonly statusHistory: {
    append(entry: StatusHistoryEntry): Promise<void>;
  };
  readonly idempotency: {
    /**
     * Reserva a chave. Se outra requisição com a mesma chave estiver em andamento, aguarda o
     * término dela (a unicidade no banco serializa as duas) e devolve o resultado gravado.
     */
    claim(customerId: string, key: string, fingerprint: string): Promise<IdempotencyClaim>;
    complete(customerId: string, key: string, outcome: CancellationOutcome): Promise<void>;
  };
}

export interface UnitOfWork {
  transaction<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}
