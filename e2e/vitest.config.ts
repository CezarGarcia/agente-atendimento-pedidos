import { defineConfig } from 'vitest/config';

/**
 * Testes ponta a ponta contra a stack em execução (docker compose + stubs):
 *   npm run e2e:up && npm run test:e2e
 * Os arquivos rodam em sequência porque compartilham os dados de demonstração.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    include: ['e2e/tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
