import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Tests backend contre une vraie base (finance_test) : exécution séquentielle.
    fileParallelism: false,
  },
});
