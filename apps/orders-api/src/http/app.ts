import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import type { Logger } from '@agente/shared';

import type { OrdersService } from '../application/orders-service.js';
import {
  apiKeyAuth,
  captureRouteBase,
  correlation,
  errorHandler,
  notFound,
  rateLimiter,
  requestLogger,
  type ApiClientKey,
} from './middlewares.js';
import { buildOpenApiDocument } from './openapi.js';
import { healthRouter } from './routes/health.js';
import { customersRouter } from './routes/customers.js';
import { ordersRouter } from './routes/orders.js';

export interface AppDependencies {
  readonly service: OrdersService;
  readonly logger: Logger;
  readonly apiKeys: readonly ApiClientKey[];
  readonly rateLimitPerMinute: number;
  readonly checkDatabase: () => Promise<void>;
  /** Rotas extras montadas antes do 404 (ex.: rotas de demonstração). */
  readonly extraRouters?: readonly { path: string; router: express.Router }[];
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(correlation());
  app.use(requestLogger(deps.logger));
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.use('/health', healthRouter(deps.checkDatabase));

  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'API de Pedidos — Documentação',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );

  const v1 = express.Router();
  v1.use(captureRouteBase);
  v1.use(rateLimiter(deps.rateLimitPerMinute));
  v1.use(apiKeyAuth(deps.apiKeys));
  v1.use(customersRouter(deps.service));
  v1.use(ordersRouter(deps.service));
  app.use('/v1', v1);

  for (const extra of deps.extraRouters ?? []) {
    app.use(extra.path, extra.router);
  }

  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
