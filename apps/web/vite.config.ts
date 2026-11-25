import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API and both WebSockets go to the server on :3000.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', ws: true } } },
});
