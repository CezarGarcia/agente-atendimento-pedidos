import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Header HTTP usado para propagar o identificador de correlação entre serviços
 * (simulador → agente → API de pedidos). Permite seguir uma conversa ponta a ponta nos logs.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Campos de contexto que entram automaticamente em todas as linhas de log. Nunca devem conter PII. */
export type ContextFields = Record<string, string | number | boolean | undefined>;

export interface RequestContext {
  readonly correlationId: string;
  readonly fields: ContextFields;
}

const storage = new AsyncLocalStorage<RequestContext>();

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Aceita um correlation id vindo de fora apenas se tiver formato seguro;
 * caso contrário gera um novo (evita log injection via header).
 */
export function resolveCorrelationId(candidate: unknown): string {
  if (typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

export function runWithContext<T>(
  context: { correlationId: string; fields?: ContextFields },
  fn: () => T,
): T {
  return storage.run({ correlationId: context.correlationId, fields: { ...context.fields } }, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Enriquecimento incremental do contexto (ex.: após identificar a conversa). */
export function addContextFields(fields: ContextFields): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store.fields, fields);
  }
}
