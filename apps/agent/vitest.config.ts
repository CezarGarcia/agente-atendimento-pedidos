import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
  },
});
