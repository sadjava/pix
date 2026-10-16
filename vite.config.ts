import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Ковры',
        short_name: 'Ковры',
        description: 'Редактор пиксельных узоров ковров',
        lang: 'ru',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#d7cdbf',
        theme_color: '#3a2e28',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: 'index.html',
        // ponytail: old caches stay until a later release deletes them after a successful migration.
        cleanupOutdatedCaches: false,
      },
    }),
  ],
  build: { modulePreload: false },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
  },
});
