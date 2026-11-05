import { Router } from 'express';

import { sendProblem } from '../problem.js';

/** Liveness: o processo está de pé. Readiness: consegue atender (banco acessível). */
export function healthRouter(checkDatabase: () => Promise<void>): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ok', checks: { database: 'ok' } });
    } catch {
      sendProblem(res, 'SERVICE_UNAVAILABLE', { detail: 'Banco de dados indisponível.' });
    }
  });

  return router;
}
