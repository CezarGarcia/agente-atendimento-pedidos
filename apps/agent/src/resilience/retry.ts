/**
 * Backoff exponencial com "full jitter": espalha as novas tentativas no tempo e evita que vários
 * clientes martelem a dependência em sincronia logo após uma falha.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
