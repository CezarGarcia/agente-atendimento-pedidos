import { defineProject } from 'vitest/config';

/** Testes de integração: API HTTP real contra um PostgreSQL real (Testcontainers). */
export default defineProject({
  test: {
    name: 'orders-api:integration',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
