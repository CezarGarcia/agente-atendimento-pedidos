import { Router } from 'express';

import { getCorrelationId } from '@agente/shared';

import type { OrdersService } from '../../application/orders-service.js';
import type { CancellationBlockReason } from '../../domain/order.js';
import { presentOrder, presentOrderSummary } from '../presenters.js';
import { HttpProblem } from '../problem.js';
import {
  CancellationRequestSchema,
  CustomerOrderParamsSchema,
  CustomerParamsSchema,
  IdempotencyKeySchema,
  ListOrdersQuerySchema,
} from '../schemas.js';

const BLOCK_REASON_DETAIL: Record<CancellationBlockReason, string> = {
  PAYMENT_PENDING: 'O pedido ainda aguarda pagamento; o cancelamento automatizado não se aplica.',
  ALREADY_SHIPPED: 'O pedido já foi enviado e não pode ser cancelado pelo fluxo automatizado.',
  ALREADY_DELIVERED: 'O pedido já foi entregue e não pode ser cancelado pelo fluxo automatizado.',
  ALREADY_CANCELLED: 'O pedido já está cancelado.',
  UNKNOWN_STATUS: 'O status atual do pedido não permite cancelamento automatizado.',
};

export function ordersRouter(service: OrdersService): Router {
  const router = Router();

  router.get('/customers/:customerId/orders', async (req, res) => {
    const { customerId } = CustomerParamsSchema.parse(req.params);
    const { limit } = ListOrdersQuerySchema.parse(req.query);
    const orders = await service.listOrders(customerId, limit);
    res.json({ orders: orders.map(presentOrderSummary) });
  });

  router.get('/customers/:customerId/orders/:orderId', async (req, res) => {
    const { customerId, orderId } = CustomerOrderParamsSchema.parse(req.params);
    const order = await service.getOrder(customerId, orderId);
    if (!order) {
      throw new HttpProblem(
        'ORDER_NOT_FOUND',
        `Pedido ${orderId} não encontrado para este cliente.`,
      );
    }
    res.json(presentOrder(order));
  });

  router.post('/customers/:customerId/orders/:orderId/cancellation', async (req, res) => {
    const { customerId, orderId } = CustomerOrderParamsSchema.parse(req.params);

    const rawKey = req.get('idempotency-key');
    if (!rawKey) {
      throw new HttpProblem('IDEMPOTENCY_KEY_REQUIRED', 'Envie o header Idempotency-Key.');
    }
    const key = IdempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw new HttpProblem('VALIDATION_ERROR', 'Idempotency-Key inválida.', {
        errors: [{ path: 'Idempotency-Key', message: key.error.issues[0]?.message ?? 'inválida' }],
      });
    }
    const body = CancellationRequestSchema.parse(req.body ?? {});

    const result = await service.requestCancellation({
      customerId,
      orderId,
      reason: body.reason ?? null,
      idempotencyKey: key.data,
      actor: res.locals.clientName ?? 'api-client',
      correlationId: getCorrelationId() ?? null,
    });

    switch (result.kind) {
      case 'cancelled':
        res.setHeader('Idempotent-Replayed', String(result.replayed));
        res.json({ order: presentOrder(result.order) });
        return;
      case 'not_found':
        throw new HttpProblem(
          'ORDER_NOT_FOUND',
          `Pedido ${orderId} não encontrado para este cliente.`,
        );
      case 'not_cancellable':
        res.setHeader('Idempotent-Replayed', String(result.replayed));
        throw new HttpProblem('ORDER_NOT_CANCELLABLE', BLOCK_REASON_DETAIL[result.reason], {
          orderId,
          currentStatus: result.order.status,
          reason: result.reason,
        });
      case 'idempotency_mismatch':
        throw new HttpProblem(
          'IDEMPOTENCY_KEY_MISMATCH',
          'Esta Idempotency-Key já foi usada com outros dados. Gere uma nova chave.',
        );
    }
  });

  return router;
}
