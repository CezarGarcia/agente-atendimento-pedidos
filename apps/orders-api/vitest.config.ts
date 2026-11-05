import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'orders-api',
    include: ['src/**/*.test.ts'],
  },
});
