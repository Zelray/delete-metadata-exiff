import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@metadesk/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
  esbuild: {
    target: 'es2022',
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Engine tests drive a real exiftool.exe process; keep them sequential so
    // protocol framing and shutdown assertions are deterministic.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
});
