/**
 * Vite build config for the npx-runnable session-audit CLI (issue #22).
 *
 * Bundles the two CLI entry points with their @main/@shared imports into
 * standalone ESM chunks under dist-cli/. Entry chunks keep their modules'
 * `import.meta.url` run-guards working per-file, so the bins self-execute
 * and `require`ing one bin from the other (sessionInventory → analyzeSession
 * helpers) stays side-effect free.
 */

import { resolve } from 'path';

import { defineConfig } from 'vite';

const nodeBuiltins = new Set([
  'fs',
  'path',
  'os',
  'events',
  'stream',
  'util',
  'net',
  'tls',
  'http',
  'https',
  'crypto',
  'zlib',
  'url',
  'querystring',
  'child_process',
  'buffer',
  'dns',
  'readline',
  'string_decoder',
  'timers',
  'tty',
  'worker_threads',
]);

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  ssr: { noExternal: true },
  build: {
    outDir: 'dist-cli',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node20',
    ssr: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        'session-audit': resolve(__dirname, 'src/cli/analyzeSession.ts'),
        'session-inventory': resolve(__dirname, 'src/cli/sessionInventory.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        banner: '#!/usr/bin/env node',
      },
      external: (id) => id.startsWith('node:') || nodeBuiltins.has(id),
    },
  },
});
