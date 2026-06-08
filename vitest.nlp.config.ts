import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    include: [
      'packages/nlp/**/*.{spec,test}.mts',
    ],
    exclude: ['build/**', '**/dist/**', '**/node_modules/**'],
  },
});