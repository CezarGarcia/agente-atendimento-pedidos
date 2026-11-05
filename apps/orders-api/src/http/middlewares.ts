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

const CUSTOMER_IN_PATH = /^\/customers\/([^/]+)/;

/**
 * Limite por cliente da API E por cliente final (após a autenticação): um cliente final muito
 * ativo não esgota a cota de todos os outros que chegam pelo mesmo agente.
 */
export function rateLimiter(limitPerMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req, res) =>
      `${res.locals.clientName ?? 'anonymous'}:${CUSTOMER_IN_PATH.exec(req.path)?.[1] ?? '-'}`,
    handler: (_req, res) => {
      sendProblem(res, 'RATE_LIMITED', { detail: 'Aguarde alguns instantes e tente novamente.' });
    },
  });
}

/** Recusa corpos que não sejam JSON em vez de ignorá-los silenciosamente. */
export const requireJsonBody: RequestHandler = (req, res, next) => {
  const hasBody =
    Number(req.get('content-length') ?? '0') > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && !req.is('application/json')) {
    sendProblem(res, 'UNSUPPORTED_MEDIA_TYPE', { detail: 'Envie o corpo como application/json.' });
    return;
  }
  next();
};

export const notFound: RequestHandler = (_req, res) => {
  sendProblem(res, 'ROUTE_NOT_FOUND');
};

/**
 * Falhas transitórias do banco: o cliente pode repetir a requisição (503 + Retry-After).
 * Inclui indisponibilidade (conexão, DNS), sobrecarga, timeouts de comando/lock e conflitos de
 * concorrência que o Postgres resolve abortando uma das transações.
 */
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08006',
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

/** Erros 4xx sinalizados pelo Express/body-parser (status + expose). */
function asClientError(error: unknown): { status: number; type: string | undefined } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500 || candidate.expose === false) {
    return null;
  }
  return { status, type: typeof candidate.type === 'string' ? candidate.type : undefined };
}

function sendClientProblem(
  res: Parameters<ErrorRequestHandler>[2],
  clientError: { status: number; type: string | undefined },
): void {
  if (clientError.status === 413) {
    sendProblem(res, 'PAYLOAD_TOO_LARGE');
  } else if (clientError.status === 415) {
    sendProblem(res, 'UNSUPPORTED_MEDIA_TYPE', {
      detail: 'Envie o corpo como application/json (UTF-8).',
    });
  } else {
    sendProblem(res, 'VALIDATION_ERROR', {
      detail:
        clientError.type === 'entity.parse.failed'
          ? 'O corpo da requisição não é um JSON válido.'
          : 'A requisição não pôde ser interpretada.',
    });
  }
}

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
    const clientError = asClientError(error);
    if (clientError) {
      // Erros do cliente (JSON malformado, charset não suportado, URL mal codificada) não são
      // falhas do serviço. O log não leva a mensagem, que pode conter trechos da URL.
      logger.warn(
        { event: 'http.client_error', status: clientError.status, type: clientError.type },
        'requisição inválida rejeitada',
      );
      sendClientProblem(res, clientError);
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
