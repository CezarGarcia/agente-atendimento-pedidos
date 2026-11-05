import { createHash, timingSafeEqual } from 'node:crypto';

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';

import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithContext,
  type Logger,
} from '@agente/shared';

import { HttpProblem, sendProblem } from './problem.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- extensão de tipos do Express
  namespace Express {
    interface Locals {
      /** Nome do cliente da API autenticado pela chave (ex.: agent-service). */
      clientName?: string;
      /** Prefixo do router (ex.: /v1), preservado para o log mesmo quando um erro sobe ao app. */
      routeBase?: string;
    }
  }
}

/** Propaga (ou cria) o correlation id e o disponibiliza para todos os logs da requisição. */
export function correlation(): RequestHandler {
  return (req, res, next) => {
    const correlationId = resolveCorrelationId(req.get(CORRELATION_HEADER));
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId }, next);
  };
}

/**
 * Loga cada requisição com o padrão da rota (ex.: /v1/customers/:customerId/orders/:orderId)
 * em vez da URL real, para não registrar identificadores de clientes.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const routePath = (req.route as { path?: string } | undefined)?.path;
      const base = res.locals.routeBase ?? req.baseUrl;
      logger.info(
        {
          event: 'http.request',
          method: req.method,
          route: routePath ? `${base}${routePath}` : 'unmatched',
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          client: res.locals.clientName,
        },
        'requisição concluída',
      );
    });
    next();
  };
}

/** Guarda o prefixo do router atual: o Express o descarta quando um erro sai do router. */
export const captureRouteBase: RequestHandler = (req, res, next) => {
  res.locals.routeBase = req.baseUrl;
  next();
};

export interface ApiClientKey {
  readonly clientName: string;
  readonly key: string;
}

/** Converte "nome:segredo,nome2:segredo2" em credenciais nomeadas (permite auditoria e rotação). */
export function parseApiKeys(raw: readonly string[]): ApiClientKey[] {
  return raw.map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) return { clientName: 'api-client', key: entry };
    return { clientName: entry.slice(0, separator), key: entry.slice(separator + 1) };
  });
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Autenticação serviço-a-serviço por chave, com comparação em tempo constante. */
export function apiKeyAuth(keys: readonly ApiClientKey[]): RequestHandler {
  const known = keys.map((entry) => ({ ...entry, digest: digest(entry.key) }));
  return (req, res, next) => {
    const provided = req.get('x-api-key');
    const providedDigest = provided ? digest(provided) : null;
    const match = providedDigest
      ? known.find((entry) => timingSafeEqual(entry.digest, providedDigest))
      : undefined;
    if (!match) {
      res.setHeader('WWW-Authenticate', 'ApiKey header="x-api-key"');
      sendProblem(res, 'UNAUTHENTICATED', {
        detail: 'Envie uma chave válida no header x-api-key.',
      });
      return;
    }
    res.locals.clientName = match.clientName;
    next();
  };
}

export function rateLimiter(limitPerMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      sendProblem(res, 'RATE_LIMITED', { detail: 'Aguarde alguns instantes e tente novamente.' });
    },
  });
}

export const notFound: RequestHandler = (_req, res) => {
  sendProblem(res, 'ROUTE_NOT_FOUND');
};

const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  '57P01',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
]);

function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === 'string' && DB_UNAVAILABLE_CODES.has(code)) ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(error.message)
  );
}

/**
 * Converte qualquer erro em Problem Details. Erros técnicos nunca expõem detalhes internos
 * (mensagem, stack, SQL) ao cliente: ficam só no log, ligados pelo correlationId.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    if (error instanceof HttpProblem) {
      sendProblem(res, error.code, {
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
      });
      return;
    }
    if (error instanceof ZodError) {
      sendProblem(res, 'VALIDATION_ERROR', {
        detail: 'Um ou mais campos são inválidos.',
        extensions: {
          errors: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return;
    }
    const bodyParserType = (error as { type?: unknown } | null)?.type;
    if (bodyParserType === 'entity.parse.failed') {
      sendProblem(res, 'VALIDATION_ERROR', {
        detail: 'O corpo da requisição não é um JSON válido.',
      });
      return;
    }
    if (bodyParserType === 'entity.too.large') {
      sendProblem(res, 'PAYLOAD_TOO_LARGE');
      return;
    }
    if (isDatabaseUnavailable(error)) {
      logger.error(
        { event: 'http.error', code: 'SERVICE_UNAVAILABLE', err: error },
        'banco indisponível',
      );
      res.setHeader('Retry-After', '5');
      sendProblem(res, 'SERVICE_UNAVAILABLE', { detail: 'Tente novamente em alguns segundos.' });
      return;
    }
    logger.error({ event: 'http.error', code: 'INTERNAL_ERROR', err: error }, 'erro não tratado');
    sendProblem(res, 'INTERNAL_ERROR', {
      detail: 'Ocorreu um erro inesperado. Informe o correlationId ao suporte.',
    });
  };
}
