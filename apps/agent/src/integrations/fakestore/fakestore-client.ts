import { z } from 'zod';

import type { Logger } from '@agente/shared';

import { assessInjection } from '../../guardrails/injection-signals.js';
import { sanitizeUntrustedText } from '../../guardrails/sanitize.js';
import { CircuitBreaker } from '../../resilience/circuit-breaker.js';
import { backoffDelayMs, sleep } from '../../resilience/retry.js';
import { TtlCache } from '../../resilience/ttl-cache.js';

/**
 * Cliente da Fake Store API (catálogo de produtos), fonte externa COMPLEMENTAR.
 *
 * Funciona como camada anticorrupção: o resto do agente só conhece `CatalogProduct`, nunca o
 * formato da API externa. Decisões importantes:
 *  - O preço do catálogo é descartado aqui. O valor que vale é sempre o do pedido (API principal);
 *    assim o modelo nem recebe um segundo preço que poderia contradizer o primeiro.
 *  - O conteúdo é tratado como não confiável: validado, sanitizado e, se parecer uma instrução
 *    para o modelo, a descrição é omitida.
 *  - Falhas nunca propagam exceção: o resultado diz se o produto foi encontrado, não existe ou se
 *    o catálogo está indisponível, e o agente segue atendendo sem os detalhes.
 */

export interface CatalogProduct {
  readonly id: number;
  readonly title: string;
  readonly category: string;
  /** Pode ser omitida se estiver vazia ou tiver conteúdo suspeito. */
  readonly description: string | null;
  readonly imageUrl: string | null;
}

export type CatalogUnavailableReason =
  'timeout' | 'network_error' | 'http_error' | 'invalid_response' | 'circuit_open';

export type CatalogLookup =
  | { readonly status: 'found'; readonly product: CatalogProduct; readonly stale: boolean }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: CatalogUnavailableReason };

export interface CatalogClient {
  getProduct(productId: number): Promise<CatalogLookup>;
  getProducts(productIds: readonly number[]): Promise<ReadonlyMap<number, CatalogLookup>>;
}

/** Leitor tolerante: valida só o que usamos e ignora campos extras. */
const FakeStoreProductSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(1_000),
  category: z.string().min(1).max(200),
  description: z.string().max(10_000).optional().default(''),
  image: z.string().max(2_000).optional(),
});

const LIMITS = { title: 120, category: 60, description: 280 } as const;
const MAX_BODY_BYTES = 64 * 1024;

export interface FakeStoreClientOptions {
  readonly baseUrl: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly cacheTtlMs?: number;
  readonly notFoundTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly failureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
}

class RetryableError extends Error {
  constructor(readonly reason: CatalogUnavailableReason) {
    super(reason);
  }
}

class FatalError extends Error {
  constructor(readonly reason: CatalogUnavailableReason) {
    super(reason);
  }
}

type FetchResult = { kind: 'found'; product: CatalogProduct } | { kind: 'not_found' };

export class FakeStoreClient implements CatalogClient {
  private readonly cache: TtlCache<number, FetchResult>;
  private readonly breaker: CircuitBreaker;
  private readonly fetchFn: typeof fetch;
  private readonly settings: Required<
    Pick<
      FakeStoreClientOptions,
      'timeoutMs' | 'maxRetries' | 'retryBaseDelayMs' | 'cacheTtlMs' | 'notFoundTtlMs'
    >
  >;

  constructor(private readonly options: FakeStoreClientOptions) {
    this.settings = {
      timeoutMs: options.timeoutMs ?? 2_000,
      maxRetries: options.maxRetries ?? 1,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 200,
      cacheTtlMs: options.cacheTtlMs ?? 10 * 60_000,
      notFoundTtlMs: options.notFoundTtlMs ?? 60_000,
    };
    this.fetchFn = options.fetchFn ?? fetch;
    this.cache = new TtlCache({
      maxEntries: 500,
      maxStaleMs: options.maxStaleMs ?? 24 * 60 * 60_000,
      ...(options.now ? { now: options.now } : {}),
    });
    this.breaker = new CircuitBreaker({
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.circuitResetMs ?? 30_000,
      ...(options.now ? { now: options.now } : {}),
      onStateChange: (from, to) => {
        options.logger.warn(
          { event: 'external.fakestore.circuit_state', from, to },
          'mudança de estado do circuit breaker da Fake Store',
        );
      },
    });
  }

  async getProducts(productIds: readonly number[]): Promise<ReadonlyMap<number, CatalogLookup>> {
    const unique = [...new Set(productIds)];
    const results = await Promise.all(
      unique.map(async (id) => [id, await this.getProduct(id)] as const),
    );
    return new Map(results);
  }

  async getProduct(productId: number): Promise<CatalogLookup> {
    const cached = this.cache.get(productId);
    if (cached?.fresh) return this.toLookup(cached.value, false);

    if (!this.breaker.tryAcquire()) {
      this.log(productId, { outcome: 'circuit_open', attempts: 0, durationMs: 0 });
      return cached
        ? this.toLookup(cached.value, true)
        : { status: 'unavailable', reason: 'circuit_open' };
    }

    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.fetchOnce(productId);
        this.breaker.recordSuccess();
        this.cache.set(
          productId,
          result,
          result.kind === 'found' ? this.settings.cacheTtlMs : this.settings.notFoundTtlMs,
        );
        this.log(productId, {
          outcome: result.kind,
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
        });
        return this.toLookup(result, false);
      } catch (error) {
        const reason =
          error instanceof RetryableError || error instanceof FatalError
            ? error.reason
            : 'network_error';
        const retryable = !(error instanceof FatalError);
        if (retryable && attempt < this.settings.maxRetries) {
          const delay = backoffDelayMs(
            attempt,
            { baseMs: this.settings.retryBaseDelayMs, maxMs: 2_000 },
            this.options.random,
          );
          this.options.logger.warn(
            {
              event: 'external.fakestore.retry',
              productId,
              attempt: attempt + 1,
              reason,
              delayMs: delay,
            },
            'nova tentativa na Fake Store',
          );
          attempt += 1;
          await sleep(delay);
          continue;
        }

        this.breaker.recordFailure();
        this.log(productId, {
          outcome: 'unavailable',
          reason,
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
          servedStale: Boolean(cached),
        });
        return cached ? this.toLookup(cached.value, true) : { status: 'unavailable', reason };
      }
    }
  }

  private async fetchOnce(productId: number): Promise<FetchResult> {
    let response: Response;
    try {
      response = await this.fetchFn(new URL(`/products/${productId}`, this.options.baseUrl), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      throw new RetryableError(isTimeout ? 'timeout' : 'network_error');
    }

    if (response.status === 404) return { kind: 'not_found' };
    if (response.status === 429 || response.status >= 500) throw new RetryableError('http_error');
    if (!response.ok) throw new FatalError('http_error');

    const body = await this.readBody(response);
    // Comportamento observado na API real: produto inexistente responde 200 com corpo vazio.
    if (body.trim() === '') return { kind: 'not_found' };

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new FatalError('invalid_response');
    }
    const parsed = FakeStoreProductSchema.safeParse(json);
    if (!parsed.success || parsed.data.id !== productId) {
      this.options.logger.warn(
        {
          event: 'external.fakestore.invalid_response',
          productId,
          issues: parsed.error?.issues.length ?? 0,
        },
        'resposta da Fake Store fora do contrato esperado',
      );
      throw new FatalError('invalid_response');
    }
    return { kind: 'found', product: this.toProduct(parsed.data) };
  }

  private async readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) throw new FatalError('invalid_response');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new FatalError('invalid_response');
    return text;
  }

  private toProduct(raw: z.infer<typeof FakeStoreProductSchema>): CatalogProduct {
    const title = sanitizeUntrustedText(raw.title, LIMITS.title);
    const category = sanitizeUntrustedText(raw.category, LIMITS.category);
    let description: string | null = sanitizeUntrustedText(raw.description, LIMITS.description);

    const assessment = assessInjection(`${title} ${category} ${description}`, {
      includeActionCoercion: true,
    });
    if (assessment.suspicious) {
      this.options.logger.warn(
        {
          event: 'external.fakestore.suspicious_content',
          productId: raw.id,
          signals: assessment.signals,
        },
        'conteúdo do catálogo parece conter instruções; descrição omitida',
      );
      description = null;
    }

    return {
      id: raw.id,
      title: assessInjection(title, { includeActionCoercion: true }).suspicious
        ? `Produto ${raw.id}`
        : title,
      category,
      description: description === '' ? null : description,
      imageUrl: raw.image?.startsWith('https://') ? raw.image : null,
    };
  }

  private toLookup(result: FetchResult, stale: boolean): CatalogLookup {
    return result.kind === 'found'
      ? { status: 'found', product: result.product, stale }
      : { status: 'not_found' };
  }

  private log(productId: number, fields: Record<string, unknown>): void {
    this.options.logger.info(
      { event: 'external.fakestore.request', productId, circuit: this.breaker.state, ...fields },
      'consulta ao catálogo externo',
    );
  }
}
