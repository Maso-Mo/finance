import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', rewrite: path => path.replace(/^\/api/, ''), cookiePathRewrite: { '/auth': '/api/auth' }, configure(proxy) { proxy.on('error', (_error, _request, response) => { if ('writeHead' in response && !response.headersSent) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Connexion impossible à Finance.' })); } }); } } },
  },
});
