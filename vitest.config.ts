import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@maboke123/raft-core', replacement: path.resolve(__dirname, 'packages/raft-core/src') },
    ],
  },
  test: {
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/auth/**/*.mts',
        'packages/query-language/**/*.mts',
        'packages/dbms/**/*.mts',
        'apps/api-server/**/*.mts',
        'packages/raft-core/src/**/*.ts',
        'packages/raft-grpc/src/**/*.ts',
      ],
      exclude: ['build/**', '**/dist/**', '**/node_modules/**', '**/*.{spec,test}.{ts,mts,mjs,js}', '**/*.d.ts'],
    },

    include: [
      'packages/auth/**/*.{spec,test}.mts',
      'packages/query-language/**/*.{spec,test}.mts',
      'packages/dbms/**/*.{spec,test}.mts',
      'apps/api-server/**/*.{spec,test}.mts',
      'apps/benchmarks/**/*.{spec,test}.mts',
      'packages/raft-core/src/**/*.{spec,test}.ts',
      'packages/raft-grpc/src/**/*.{spec,test}.ts',
    ],
    exclude: ['build/**', '**/node_modules/**', '**/dist/**', 'packages/nlp/**'],
  },
});
