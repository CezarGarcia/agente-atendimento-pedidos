import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*/vitest.config.ts', 'apps/*/vitest.integration.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
