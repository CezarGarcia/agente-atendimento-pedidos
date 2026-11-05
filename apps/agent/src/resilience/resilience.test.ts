import { describe, expect, it } from 'vitest';

import { CircuitBreaker, type CircuitState } from './circuit-breaker.js';
import { backoffDelayMs } from './retry.js';
import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  it('[FS-14] serve fresco dentro do TTL, stale depois e esquece após a janela de stale', () => {
    let now = 0;
    const cache = new TtlCache<string, number>({
      maxEntries: 10,
      maxStaleMs: 1_000,
      now: () => now,
    });
    cache.set('a', 1, 100);

    expect(cache.get('a')).toEqual({ value: 1, fresh: true });
    now = 150;
    expect(cache.get('a')).toEqual({ value: 1, fresh: false });
    now = 1_200;
    expect(cache.get('a')).toBeUndefined();
  });

  it('[FS-14] respeita o limite de entradas descartando a menos usada', () => {
    const cache = new TtlCache<string, number>({ maxEntries: 2, maxStaleMs: 0 });
    cache.set('a', 1, 1_000);
    cache.set('b', 2, 1_000);
    cache.get('a');
    cache.set('c', 3, 1_000);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.size).toBe(2);
  });
});

describe('CircuitBreaker', () => {
  it('[FS-14] abre após falhas consecutivas, testa após o timeout e fecha com sucesso', () => {
    let now = 0;
    const transitions: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1_000,
      now: () => now,
      onStateChange: (from: CircuitState, to: CircuitState) => transitions.push(`${from}->${to}`),
    });

    for (let i = 0; i < 3; i += 1) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.recordFailure();
    }
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);

    now = 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // só uma requisição de teste por vez
    breaker.recordSuccess();

    expect(breaker.state).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('[FS-14] volta a abrir se a requisição de teste falhar', () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      now: () => now,
    });
    breaker.recordFailure();
    now = 100;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('[FS-14] um sucesso zera a contagem de falhas', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });
});

describe('backoffDelayMs', () => {
  it('[FS-14] cresce exponencialmente até o teto, com jitter', () => {
    const options = { baseMs: 100, maxMs: 1_000 };
    expect(backoffDelayMs(0, options, () => 0.999)).toBe(99);
    expect(backoffDelayMs(3, options, () => 0.5)).toBe(400);
    expect(backoffDelayMs(10, options, () => 0.999)).toBe(999);
    expect(backoffDelayMs(2, options, () => 0)).toBe(0);
  });
});
