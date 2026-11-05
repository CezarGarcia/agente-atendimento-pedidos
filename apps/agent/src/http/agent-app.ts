import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Router,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import {
  CORRELATION_HEADER,
  getCorrelationId,
  resolveCorrelationId,
  runWithContext,
  type Logger,
} from '@agente/shared';

import type { AgentService } from '../agent/agent-service.js';

export const SIGNATURE_HEADER = 'x-signature-256';

/** Formato do webhook da plataforma de mensagens simulada (inspirado no WhatsApp Cloud API). */
export const WebhookPayloadSchema = z
  .strictObject({
    messageId: z.string().min(1).max(128),
    from: z.string().regex(/^\+[1-9]\d{7,14}$/, 'from deve estar no formato E.164'),
    timestamp: z.number().int().optional(),
    text: z.string().max(4_096).optional(),
    button: z.strictObject({ payload: z.string().max(200), title: z.string().max(100) }).optional(),
  })
  .refine((payload) => payload.text !== undefined || payload.button !== undefined, {
    message: 'informe text ou button',
  });

export function signWebhook(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function isValidSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !header) return false;
  const expected = Buffer.from(signWebhook(rawBody, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

type RawBodyRequest = Request & { rawBody?: Buffer };

const problem = (status: number, code: string, detail: string) => ({
  type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
  status,
  code,
  detail,
  correlationId: getCorrelationId(),
});

export interface AgentAppDependencies {
  readonly agent: AgentService;
  readonly logger: Logger;
  readonly webhookSecret: string;
  readonly checkReadiness: () => Promise<Record<string, string>>;
  readonly simulatorRouter?: Router;
  readonly simulatorDistDir?: string;
}

export function createAgentApp(deps: AgentAppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const correlationId = resolveCorrelationId(req.get(CORRELATION_HEADER));
    res.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = Date.now();
    res.on('finish', () => {
      deps.logger.info(
        {
          event: 'http.request',
          method: req.method,
          route:
            (req.route as { path?: string } | undefined)?.path ??
            req.path.split('/').slice(0, 3).join('/'),
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        },
        'requisição concluída',
      );
    });
    runWithContext({ correlationId }, next);
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'img-src': ["'self'", 'data:', 'https://fakestoreapi.com'] },
      },
    }),
  );
  app.use(
    express.json({
      limit: '32kb',
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = buffer;
      },
    }),
  );

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      res.json({ status: 'ok', checks: await deps.checkReadiness() });
    } catch {
      res.status(503).json(problem(503, 'SERVICE_UNAVAILABLE', 'Dependência indisponível.'));
    }
  });

  /**
   * Webhook do canal de mensagens. Em produção (ex.: WhatsApp Cloud API), a plataforma assina o
   * corpo com HMAC-SHA256; mensagens sem assinatura válida são descartadas. A resposta é síncrona
   * para simplificar o mock; numa integração real, o webhook responderia 200 imediatamente e o
   * agente enviaria a resposta pela API de envio da plataforma.
   */
  app.post(
    '/channels/mock-whatsapp/webhook',
    rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req: RawBodyRequest, res) => {
      if (!isValidSignature(req.rawBody, req.get(SIGNATURE_HEADER), deps.webhookSecret)) {
        deps.logger.warn(
          { event: 'channel.webhook.invalid_signature' },
          'webhook com assinatura inválida',
        );
        res
          .status(401)
          .type('application/problem+json')
          .json(problem(401, 'INVALID_SIGNATURE', 'Assinatura inválida.'));
        return;
      }
      const payload = WebhookPayloadSchema.safeParse(req.body);
      if (!payload.success) {
        res
          .status(400)
          .type('application/problem+json')
          .json(
            problem(400, 'VALIDATION_ERROR', payload.error.issues.map((i) => i.message).join('; ')),
          );
        return;
      }
      const { messageId, from, text, button } = payload.data;
      const reply = await deps.agent.handle(
        { messageId, from, ...(text === undefined ? {} : { text }), ...(button ? { button } : {}) },
        getCorrelationId(),
      );
      res.json(reply);
    },
  );

  if (deps.simulatorRouter) app.use('/simulator', deps.simulatorRouter);

  const distDir = deps.simulatorDistDir ? resolve(deps.simulatorDistDir) : undefined;
  if (distDir && existsSync(distDir)) {
    app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!simulator|channels|health).*/, (_req, res) => {
      res.sendFile(resolve(distDir, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res
      .status(404)
      .type('application/problem+json')
      .json(problem(404, 'ROUTE_NOT_FOUND', 'Rota não encontrada.'));
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      const detail = error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      res
        .status(400)
        .type('application/problem+json')
        .json(problem(400, 'VALIDATION_ERROR', detail));
      return;
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res
        .status(status)
        .type('application/problem+json')
        .json(problem(status, 'BAD_REQUEST', 'Requisição inválida.'));
      return;
    }
    deps.logger.error({ event: 'http.error', err: error }, 'erro não tratado');
    res
      .status(500)
      .type('application/problem+json')
      .json(problem(500, 'INTERNAL_ERROR', 'Erro inesperado.'));
  };
  app.use(errorHandler);
  return app;
}
