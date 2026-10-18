/**
 * Vite build config for the npx-runnable session-audit CLI (issue #22).
 *
 * Bundles the two CLI entry points with their @main/@shared imports into
 * standalone ESM chunks under dist-cli/. Entry chunks keep their modules'
 * `import.meta.url` run-guards working per-file, so the bins self-execute
 * and `require`ing one bin from the other (sessionInventory → analyzeSession
 * helpers) stays side-effect free.
 */

import { chmodSync } from 'fs';

import { resolve } from 'path';

import { defineConfig, type Plugin } from 'vite';

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

/**
 * `emptyOutDir` recreates outputs with the default 0644, which would strip
 * the executable bit from the committed bundle and fail the CI freshness
 * guard (`git diff --exit-code dist-cli`) on every run — the skills invoke
 * the bins directly, so 0755 is part of what gets committed (#93).
 */
function preserveExecutableBit(): Plugin {
  return {
    name: 'preserve-executable-bit',
    writeBundle(_, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.isEntry) {
          chmodSync(resolve(__dirname, 'dist-cli', fileName), 0o755);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [preserveExecutableBit()],
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
        'bell-stats': resolve(__dirname, 'src/cli/bellStats.ts'),
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
