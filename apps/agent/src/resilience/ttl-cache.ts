export interface CacheHit<V> {
  readonly value: V;
  /** false quando o item expirou mas ainda está dentro da janela de "stale-on-error". */
  readonly fresh: boolean;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  staleUntil: number;
}

export interface TtlCacheOptions {
  readonly maxEntries: number;
  /** Por quanto tempo após expirar um item ainda pode ser servido se a origem falhar. */
  readonly maxStaleMs: number;
  readonly now?: () => number;
}

/** Cache em memória com TTL, janela de stale e limite de tamanho (descarta o menos usado). */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly now: () => number;

  constructor(private readonly options: TtlCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: K): CacheHit<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now >= entry.staleUntil) {
      this.entries.delete(key);
      return undefined;
    }
    // Reinsere para marcar como usado recentemente (ordem de inserção do Map = LRU).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, fresh: now < entry.expiresAt };
  }

  set(key: K, value: V, ttlMs: number): void {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: now + ttlMs,
      staleUntil: now + ttlMs + this.options.maxStaleMs,
    });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
