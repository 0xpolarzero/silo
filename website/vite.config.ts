import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../app/SiloUI/src', import.meta.url)),
      'react': fileURLToPath(new URL('../app/SiloUI/node_modules/react', import.meta.url)),
      '@testing-library/react': fileURLToPath(new URL('../app/SiloUI/node_modules/@testing-library/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../app/SiloUI/node_modules/react-dom', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        demo: fileURLToPath(new URL('./demo.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: true } },
    include: ['src/demo/*.test.tsx'],
    setupFiles: ['src/demo/test-setup.ts'],
  },
});
