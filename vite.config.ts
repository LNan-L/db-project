import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Personal Knowledge Engine',
        short_name: 'PKE',
        description: 'Local-first personal knowledge engine',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
        ]
      },
      workbox: {
        // 字体体积约 1 MB，首屏用不到；不做 precache，改成运行时缓存，
        // 手机走慢速公网时能把首次预缓存从 3.2 MB 降到 ~2.1 MB。
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: /\.(woff2?|ttf|eot)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pke-fonts',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          }
        ]
      },
      devOptions: { enabled: false }
    })
  ],
  server: { host: '127.0.0.1', port: 5273, allowedHosts: true },
  preview: { host: '127.0.0.1', port: 4273, allowedHosts: true }
});
