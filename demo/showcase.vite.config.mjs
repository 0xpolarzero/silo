import { defineConfig } from '../app/SiloUI/node_modules/vite/dist/node/index.js'
import react from '../app/SiloUI/node_modules/@vitejs/plugin-react/dist/index.js'
import tailwindcss from '../app/SiloUI/node_modules/@tailwindcss/vite/dist/index.mjs'
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('../app/SiloUI/src', import.meta.url).pathname },
    dedupe: ['react', 'react-dom'],
  },
  server: { host: 'localhost', port: 3410, strictPort: true },
  build: { outDir: 'out/showcase', rollupOptions: { input: new URL('showcase.html', import.meta.url).pathname } },
})
