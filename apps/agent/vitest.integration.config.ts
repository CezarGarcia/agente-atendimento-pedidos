import { defineProject } from 'vitest/config';

/** Integração do agente com PostgreSQL real (Testcontainers). */
export default defineProject({
  test: {
    name: 'agent:integration',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
