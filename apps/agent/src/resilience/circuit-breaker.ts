export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Falhas consecutivas que abrem o circuito. */
  readonly failureThreshold: number;
  /** Tempo com o circuito aberto antes de permitir uma requisição de teste. */
  readonly resetTimeoutMs: number;
  readonly now?: () => number;
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Circuit breaker mínimo. Quando a dependência está fora do ar, para de chamá-la por um tempo:
 * responde rápido ao cliente (sem esperar timeouts) e não sobrecarrega quem já está com problema.
 */
export class CircuitBreaker {
  private currentState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    return this.currentState;
  }

  /** Indica se uma requisição pode ser feita agora. No estado half_open, só uma por vez. */
  tryAcquire(): boolean {
    if (this.currentState === 'closed') return true;
    if (this.currentState === 'open') {
      if (this.now() - this.openedAt < this.options.resetTimeoutMs) return false;
      this.transition('half_open');
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
    if (this.currentState !== 'closed') this.transition('closed');
  }

  recordFailure(): void {
    this.trialInFlight = false;
    this.consecutiveFailures += 1;
    if (
      this.currentState === 'half_open' ||
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.openedAt = this.now();
      if (this.currentState !== 'open') this.transition('open');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.currentState;
    this.currentState = to;
    this.options.onStateChange?.(from, to);
  }
}
