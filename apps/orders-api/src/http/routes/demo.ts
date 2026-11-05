import { Router } from 'express';

import { getCorrelationId } from '@agente/shared';

import type { createDemoOperations } from '../../infra/demo.js';
import { apiKeyAuth, type ApiClientKey } from '../middlewares.js';
import { OrderIdSchema } from '../schemas.js';

/** Rotas internas de demonstração. Montadas apenas com DEMO_MODE (proibido em produção). */
export function demoRouter(
  operations: ReturnType<typeof createDemoOperations>,
  apiKeys: readonly ApiClientKey[],
): Router {
  const router = Router();
  router.use(apiKeyAuth(apiKeys));

  router.post('/reset', async (_req, res) => {
    await operations.reset();
    res.status(204).end();
  });

  router.post('/orders/:orderId/ship', async (req, res) => {
    const orderId = OrderIdSchema.parse(req.params.orderId);
    res.json({ shipped: await operations.shipOrder(orderId, getCorrelationId() ?? null) });
  });

  return router;
}
