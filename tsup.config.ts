import { defineConfig } from 'tsup';

// Bundles the server and its one-off scripts into dist/, so production runs plain `node` (plan §2.1).
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    seed: 'scripts/seed.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
});
