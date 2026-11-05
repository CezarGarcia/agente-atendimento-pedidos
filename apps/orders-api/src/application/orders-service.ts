import { createHash } from 'node:crypto';

import { pseudonymize, type Logger } from '@agente/shared';

import { cancelOrder, type Customer, type Order } from '../domain/order.js';
import type {
  CancellationOutcome,
  Clock,
  CustomersRepository,
  OrdersReadRepository,
  TransactionScope,
  UnitOfWork,
} from './ports.js';

export interface RequestCancellationCommand {
  readonly customerId: string;
  readonly orderId: string;
  readonly reason: string | null;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly correlationId: string | null;
}

export type RequestCancellationResult =
  | (CancellationOutcome & { readonly replayed: boolean })
  | { readonly kind: 'idempotency_mismatch' };

export interface OrdersServiceDependencies {
  readonly customers: CustomersRepository;
  readonly orders: OrdersReadRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Segredo usado para pseudonimizar identificadores de clientes nos logs. */
  readonly logPseudonymSecret: string;
}

/** Casos de uso da API principal. */
export class OrdersService {
  constructor(private readonly deps: OrdersServiceDependencies) {}

  async findCustomerByPhone(phone: string): Promise<Customer | null> {
    const customer = await this.deps.customers.findByPhone(phone);
    this.deps.logger.info(
      { event: 'customer.lookup', outcome: customer ? 'found' : 'not_found' },
      'identificação de cliente pelo canal',
    );
    return customer;
  }

  async getOrder(customerId: string, orderId: string): Promise<Order | null> {
    const order = await this.deps.orders.findForCustomer(customerId, orderId);
    this.deps.logger.info(
      {
        event: 'order.lookup',
        orderId,
        customerRef: this.customerRef(customerId),
        outcome: order ? 'found' : 'not_found',
        status: order?.status,
      },
      'consulta de pedido',
    );
    return order;
  }

  async listOrders(customerId: string, limit: number): Promise<Order[]> {
    const orders = await this.deps.orders.listForCustomer(customerId, limit);
    this.deps.logger.info(
      { event: 'order.list', customerRef: this.customerRef(customerId), count: orders.length },
      'listagem de pedidos do cliente',
    );
    return orders;
  }

  /**
   * Regra 2/3 aplicada na API (não apenas no agente): a elegibilidade é decidida pelo domínio,
   * dentro de uma transação com bloqueio de linha. Duas solicitações simultâneas para o mesmo
   * pedido nunca cancelam duas vezes, e repetições com a mesma Idempotency-Key recebem a
   * mesma resposta.
   */
  async requestCancellation(
    command: RequestCancellationCommand,
  ): Promise<RequestCancellationResult> {
    const logContext = {
      orderId: command.orderId,
      customerRef: this.customerRef(command.customerId),
      actor: command.actor,
    };
    this.deps.logger.info(
      { event: 'order.cancellation.requested', ...logContext },
      'solicitação de cancelamento recebida',
    );

    const result = await this.deps.unitOfWork.transaction<RequestCancellationResult>(
      async (scope) => {
        const claim = await scope.idempotency.claim(
          command.customerId,
          command.idempotencyKey,
          fingerprint(command),
        );
        if (claim.status === 'mismatch') return { kind: 'idempotency_mismatch' };
        if (claim.status === 'replay') return { ...claim.outcome, replayed: true };

        const outcome = await this.decideCancellation(scope, command);
        await scope.idempotency.complete(command.customerId, command.idempotencyKey, outcome);
        return { ...outcome, replayed: false };
      },
    );

    this.logCancellationResult(result, logContext);
    return result;
  }

  private async decideCancellation(
    scope: TransactionScope,
    command: RequestCancellationCommand,
  ): Promise<CancellationOutcome> {
    const order = await scope.orders.findForUpdate(command.customerId, command.orderId);
    if (!order) return { kind: 'not_found' };

    const decision = cancelOrder(order, this.deps.clock.now(), command.reason);
    if (!decision.ok) return { kind: 'not_cancellable', order, reason: decision.reason };

    await scope.orders.saveCancellation(decision.order);
    await scope.statusHistory.append({
      orderId: order.id,
      fromStatus: order.status,
      toStatus: decision.order.status,
      actor: command.actor,
      reason: command.reason,
      correlationId: command.correlationId,
    });
    return { kind: 'cancelled', order: decision.order };
  }

  private logCancellationResult(
    result: RequestCancellationResult,
    logContext: Record<string, string>,
  ): void {
    const { logger } = this.deps;
    switch (result.kind) {
      case 'cancelled':
        logger.info(
          { event: 'order.cancellation.succeeded', ...logContext, replayed: result.replayed },
          'pedido cancelado',
        );
        return;
      case 'not_cancellable':
        logger.info(
          {
            event: 'order.cancellation.rejected',
            ...logContext,
            reason: result.reason,
            currentStatus: result.order.status,
            replayed: result.replayed,
          },
          'cancelamento recusado pela regra de negócio',
        );
        return;
      case 'not_found':
        logger.info(
          { event: 'order.cancellation.not_found', ...logContext, replayed: result.replayed },
          'cancelamento de pedido inexistente ou de outro cliente',
        );
        return;
      case 'idempotency_mismatch':
        logger.warn(
          { event: 'order.cancellation.idempotency_mismatch', ...logContext },
          'Idempotency-Key reutilizada com outra requisição',
        );
        return;
    }
  }

  private customerRef(customerId: string): string {
    return pseudonymize(customerId, this.deps.logPseudonymSecret, 'cus');
  }
}

function fingerprint(command: RequestCancellationCommand): string {
  return createHash('sha256')
    .update(JSON.stringify({ orderId: command.orderId, reason: command.reason }))
    .digest('hex');
}
