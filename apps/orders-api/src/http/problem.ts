import type { Response } from 'express';

import { getCorrelationId } from '@agente/shared';

/**
 * Códigos de erro estáveis, legíveis por máquina. O agente decide o que dizer ao cliente
 * a partir do `code`, nunca do texto de `detail`.
 */
export const PROBLEM_CODES = {
  VALIDATION_ERROR: { status: 400, title: 'Requisição inválida' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency-Key obrigatória' },
  UNAUTHENTICATED: { status: 401, title: 'Credencial ausente ou inválida' },
  CUSTOMER_NOT_FOUND: { status: 404, title: 'Cliente não encontrado' },
  ORDER_NOT_FOUND: { status: 404, title: 'Pedido não encontrado' },
  ROUTE_NOT_FOUND: { status: 404, title: 'Rota não encontrada' },
  ORDER_NOT_CANCELLABLE: { status: 409, title: 'Pedido não pode ser cancelado' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Corpo da requisição muito grande' },
  IDEMPOTENCY_KEY_MISMATCH: {
    status: 422,
    title: 'Idempotency-Key já usada com outra requisição',
  },
  RATE_LIMITED: { status: 429, title: 'Limite de requisições excedido' },
  INTERNAL_ERROR: { status: 500, title: 'Erro interno' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Serviço temporariamente indisponível' },
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES;

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  instance?: string;
  correlationId?: string;
  [extension: string]: unknown;
}

/** Monta um documento RFC 9457 (Problem Details for HTTP APIs). */
export function buildProblem(
  code: ProblemCode,
  options: { detail?: string; instance?: string; extensions?: Record<string, unknown> } = {},
): ProblemDocument {
  const { status, title } = PROBLEM_CODES[code];
  return {
    type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title,
    status,
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    correlationId: getCorrelationId(),
    ...options.extensions,
  };
}

export function sendProblem(
  res: Response,
  code: ProblemCode,
  options: Parameters<typeof buildProblem>[1] = {},
): void {
  const problem = buildProblem(code, { instance: res.req.originalUrl, ...options });
  res.status(problem.status).type('application/problem+json').json(problem);
}

/** Erro de aplicação que a camada HTTP converte em Problem Details. */
export class HttpProblem extends Error {
  override readonly name = 'HttpProblem';
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly extensions?: Record<string, unknown>,
  ) {
    super(detail ?? PROBLEM_CODES[code].title);
  }
}
